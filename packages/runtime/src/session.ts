import { randomUUID } from 'node:crypto';
import { DesktopRuntimeManager } from './runtime-manager.js';
import {
  SessionError,
  type InvocationContext,
  type InvocationRequest,
  type RuntimeEndpoints,
  type Session,
  type SessionEvent,
  type SessionInvocationResult,
  type SessionSnapshot,
  type ShutdownResult,
} from './contracts.js';

/** Shared facade: all resources and orchestration belong to DesktopRuntimeManager. */
export function createSession(
  options: { onEndpoints?: (endpoints: RuntimeEndpoints | null) => void } = {},
): Session {
  return new RuntimeSession(options);
}

class RuntimeSession implements Session {
  readonly #sessionId = randomUUID();
  readonly #manager: DesktopRuntimeManager;
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #requests = new Set<string>();
  #runId: string | null = null;
  #revision = 0;
  #notifying = false;
  readonly #events: SessionEvent[] = [];
  #disposed = false;
  #selecting = false;
  #starting = false;
  #invoking = false;
  #pendingInvocation: Promise<unknown> | null = null;
  #pendingSelection: Promise<unknown> | null = null;
  #stopping: Promise<ShutdownResult> | null = null;

  public constructor(options: { onEndpoints?: (endpoints: RuntimeEndpoints | null) => void }) {
    this.#manager = new DesktopRuntimeManager(
      () => this.#publish(),
      (endpoints) => options.onEndpoints?.(endpoints),
    );
  }
  public snapshot(): SessionSnapshot {
    return {
      ...this.#manager.snapshot(),
      schemaVersion: 1,
      sessionId: this.#sessionId,
      runId: this.#runId,
      revision: this.#revision,
      disposed: this.#disposed,
      contexts: this.#manager.contexts(),
    };
  }
  public subscribe(listener: (event: SessionEvent) => void): () => void {
    if (typeof listener !== 'function')
      throw new SessionError('invalid', 'A snapshot listener is required.');
    if (!this.#disposed) this.#listeners.add(listener);
    this.#deliver(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  public async selectProject(directory: string): Promise<SessionSnapshot> {
    this.#assertUsable();
    if (this.#selecting || this.#starting || this.#stopping !== null || this.#manager.hasResources)
      throw new SessionError('invalid', 'Stop the active runtime before selecting a project.');
    this.#selecting = true;
    try {
      const selection = this.#manager.selectProject(directory);
      this.#pendingSelection = selection;
      const selected = await selection;
      this.#assertUsable();
      if (selected.phase !== 'ready')
        throw (
          this.#manager.failure ??
          new SessionError('invalid', 'Project configuration could not be validated.')
        );
      return this.snapshot();
    } finally {
      this.#selecting = false;
      this.#pendingSelection = null;
    }
  }
  public validateContext(context: InvocationContext): InvocationContext {
    this.#assertUsable();
    return this.#manager.validateContext(context);
  }
  public async start(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionSnapshot> {
    this.#assertUsable();
    checkOptions(options, 60_000);
    if (
      this.#selecting ||
      this.#starting ||
      this.#stopping !== null ||
      this.#manager.hasResources ||
      this.snapshot().project === null
    )
      throw new SessionError('invalid', 'Select a project and finish cleanup before starting.');
    this.#starting = true;
    this.#runId = randomUUID();
    this.#requests.clear();
    try {
      const result = await this.#manager.start(options);
      if (this.#disposed || this.#stopping !== null || options.signal?.aborted)
        throw new SessionError('cancelled', 'Runtime startup cancelled.');
      if (result.phase !== 'running')
        throw this.#manager.failure ?? new SessionError('start-failed', 'Bot startup failed.');
      this.#manager.assertLive();
      return this.snapshot();
    } finally {
      this.#starting = false;
    }
  }
  public async invoke(
    request: InvocationRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionInvocationResult> {
    this.#assertUsable();
    checkOptions(options, 30_000);
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(request.requestId)
    )
      throw new SessionError('invalid', 'A valid request ID is required.');
    const context = this.validateContext(request.context);
    const { requestId, input, runId } = request;
    if (
      typeof input !== 'string' ||
      Buffer.byteLength(input) < 1 ||
      Buffer.byteLength(input) > 2_000 ||
      !/^\/?[a-z0-9_-]{1,32}(?:\s|$)/u.test(input.trim())
    )
      throw new SessionError(
        'invalid',
        'Command input must be a supported command of 1–2,000 UTF-8 bytes.',
      );
    if (runId !== this.#runId || this.snapshot().phase !== 'running' || this.#stopping !== null)
      throw new SessionError('not-running', 'Request does not target the current running session.');
    if (this.#invoking || this.#requests.has(requestId))
      throw new SessionError('invalid', 'Concurrent or duplicate requests are not supported.');
    this.#manager.assertLive();
    this.#requests.add(requestId);
    this.#invoking = true;
    try {
      const invocation = this.#manager.invoke(input, context, {
        ...options,
        requireExactResponse: true,
      });
      this.#pendingInvocation = invocation;
      const result = await invocation;
      if (!result.ok)
        throw this.#manager.failure ?? new SessionError('transport', 'Bot interaction failed.');
      return structuredClone({ ...result, runId, requestId, context });
    } finally {
      this.#invoking = false;
      this.#pendingInvocation = null;
    }
  }
  public async stop(): Promise<ShutdownResult> {
    if (this.#stopping !== null) return this.#stopping;
    const operation = Promise.resolve().then(() => this.#shutdown());
    this.#stopping = operation;
    try {
      return structuredClone(await operation);
    } finally {
      if (this.#stopping === operation) this.#stopping = null;
    }
  }
  public async dispose(): Promise<ShutdownResult> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#publish();
    }
    try {
      return await this.stop();
    } finally {
      this.#listeners.clear();
    }
  }
  async #shutdown(): Promise<ShutdownResult> {
    const stopping = this.#manager.stop();
    await Promise.allSettled([this.#pendingInvocation, this.#pendingSelection]);
    await stopping;
    const errors = this.#manager.shutdownIssues;
    return { ok: errors.length === 0, errors, snapshot: this.snapshot() };
  }
  #assertUsable(): void {
    if (this.#disposed) throw new SessionError('invalid', 'Session has been disposed.');
  }
  #publish(): void {
    this.#revision += 1;
    this.#events.push({
      schemaVersion: 1,
      sessionId: this.#sessionId,
      runId: this.#runId,
      sequence: this.#revision,
      kind: 'snapshot',
      snapshot: this.snapshot(),
    });
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      for (let event = this.#events.shift(); event !== undefined; event = this.#events.shift()) {
        for (const listener of [...this.#listeners]) {
          try {
            listener(structuredClone(event));
          } catch {
            /* Observer only. */
          }
        }
      }
    } finally {
      this.#notifying = false;
    }
  }

  #deliver(listener: (event: SessionEvent) => void): void {
    try {
      listener({
        schemaVersion: 1,
        sessionId: this.#sessionId,
        runId: this.#runId,
        sequence: this.#revision,
        kind: 'snapshot',
        snapshot: this.snapshot(),
      });
    } catch {
      /* An observer cannot fail a runtime operation. */
    }
  }
}
function checkOptions(
  options: { signal?: AbortSignal; timeoutMs?: number },
  maximum: number,
): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > maximum)
  )
    throw new SessionError('invalid', 'Timeout is outside the supported integer range.');
  if (options.signal?.aborted) throw new SessionError('cancelled', 'Runtime operation cancelled.');
}
