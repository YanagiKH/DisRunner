import type { LocalAttachmentMetadata, FaultPlan } from '@disrunner/core';
import { randomUUID } from 'node:crypto';
import type { RuntimeResourceDependencies } from './resource-lifecycle.js';
import { DesktopRuntimeManager } from './runtime-manager.js';
import {
  SessionError,
  type InvocationContext,
  type InvocationRequest,
  type RuntimeActionRequest,
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
  return new RuntimeSession(options, {});
}

/**
 * Internal factory for the same Session implementation with instance-scoped resource wrappers.
 * Not exported from the package entry point; production uses createSession (identity defaults).
 */
export function createSessionWithDependencies(
  options: { onEndpoints?: (endpoints: RuntimeEndpoints | null) => void },
  dependencies: RuntimeResourceDependencies,
): Session {
  return new RuntimeSession(options, dependencies);
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

  public constructor(
    options: { onEndpoints?: (endpoints: RuntimeEndpoints | null) => void },
    dependencies: RuntimeResourceDependencies,
  ) {
    this.#manager = new DesktopRuntimeManager(
      () => this.#publish(),
      (endpoints) => options.onEndpoints?.(endpoints),
      dependencies,
    );
  }
  public snapshot(): SessionSnapshot {
    return {
      ...this.#manager.snapshot(),
      ...this.#manager.captureEvidence(),
      diagnostics: this.#manager.diagnostics(),
      activeHandlers: this.#manager.activeHandlers(),
      coreState: this.#manager.coreState(),
      commands: this.#manager.commands(),
      commandsTruncated: this.#manager.commandsTruncated(),
      ...(this.#manager.inputIdentity() ? { inputs: this.#manager.inputIdentity()! } : {}),
      interactions: this.#manager.interactionStates(),
      faults: this.#manager.faultEvidence(),
      schemaVersion: 1,
      sessionId: this.#sessionId,
      runId: this.#runId,
      revision: this.#revision,
      disposed: this.#disposed,
      contexts: this.#manager.contexts(),
    };
  }
  public commandsForContext(
    context: InvocationContext,
  ): readonly Readonly<Record<string, unknown>>[] {
    this.#assertUsable();
    return this.#manager.commands(context);
  }
  public readAttachment(id: string, context: InvocationContext) {
    this.#assertUsable();
    return Promise.resolve(this.#manager.readAttachment(id, context));
  }
  public async importAttachment(
    relativePath: string,
    context: InvocationContext,
  ): Promise<LocalAttachmentMetadata> {
    this.#assertUsable();
    if (this.#invoking || this.#stopping)
      throw new SessionError('invalid', 'Wait for the active operation to finish.');
    this.#invoking = true;
    try {
      const operation = this.#manager.importAttachment(relativePath, context);
      this.#pendingInvocation = operation;
      return await operation;
    } finally {
      this.#invoking = false;
      this.#pendingInvocation = null;
    }
  }
  public setFaults(plans: readonly FaultPlan[]): void {
    this.#assertUsable();
    this.#manager.setFaults(plans);
  }
  public snapshotForActor(actorId: string): SessionSnapshot {
    this.#assertUsable();
    if (!this.#manager.hasActor(actorId))
      throw new SessionError('invalid', 'Select an existing actor.');
    return { ...this.snapshot(), coreState: this.#manager.coreState(actorId) };
  }
  public async dispatch(
    request: RuntimeActionRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionInvocationResult> {
    this.#assertUsable();
    checkOptions(options, 30000);
    if (!request || !/^[A-Za-z0-9_-]{1,64}$/.test(request.requestId))
      throw new SessionError('invalid', 'A valid request ID is required.');
    const context = this.validateContext(request.context);
    if (
      request.runId !== this.#runId ||
      this.snapshot().phase !== 'running' ||
      this.#stopping !== null
    )
      throw new SessionError('not-running', 'Request does not target the current run.');
    if (this.#invoking || this.#requests.has(request.requestId))
      throw new SessionError('invalid', 'Concurrent or duplicate requests are not supported.');
    this.#requests.add(request.requestId);
    this.#invoking = true;
    try {
      const invocation = this.#manager.dispatch(request.action, context, options);
      this.#pendingInvocation = invocation;
      const result = await invocation;
      return structuredClone({
        ...result,
        runId: request.runId,
        requestId: request.requestId,
        context,
      });
    } finally {
      this.#invoking = false;
      this.#pendingInvocation = null;
    }
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
    if (
      this.#selecting ||
      this.#starting ||
      this.#stopping !== null ||
      (this.#manager.hasResources && !this.#cleanupPending())
    )
      throw new SessionError('invalid', 'Stop the active runtime before selecting a project.');
    if (this.#manager.hasResources)
      throw new SessionError(
        'invalid',
        'Previous run cleanup is not confirmed. Stop again to retry cleanup before selecting a project.',
      );
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
      (this.#manager.hasResources && !this.#cleanupPending())
    )
      throw new SessionError('invalid', 'Select a project and finish cleanup before starting.');
    if (this.#manager.hasResources)
      throw new SessionError(
        'invalid',
        'Previous run cleanup is not confirmed. Stop again to retry cleanup before starting.',
      );
    if (this.snapshot().project === null)
      throw new SessionError('invalid', 'Select a project before starting.');
    this.#starting = true;
    this.#runId = randomUUID();
    this.#requests.clear();
    try {
      const result = await this.#manager.start({ ...options, runId: this.#runId });
      const cancelled = this.#disposed || this.#stopping !== null || options.signal?.aborted;
      // A startup failure classified before shutdown began stays the primary error; a stop
      // requested meanwhile does not relabel it as a cancellation.
      if (result.phase !== 'running')
        throw (
          this.#manager.failure ??
          (cancelled
            ? new SessionError('cancelled', 'Runtime startup cancelled.')
            : new SessionError('start-failed', 'Bot startup failed.'))
        );
      if (cancelled) throw new SessionError('cancelled', 'Runtime startup cancelled.');
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
  /** Resources remain after a failed cleanup (not an active or in-progress run). */
  #cleanupPending(): boolean {
    return this.#manager.hasResources && this.#manager.snapshot().phase === 'error';
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
