import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { assertOfflineGatewayUrl, assertOfflineUrl } from './network-policy.js';
import { redactString } from './redaction.js';
import {
  assertSyntheticToken,
  createOfflineSessionToken,
  isDiscordTokenShaped,
} from './session-token.js';

export type BotProcessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface BotProcessConfig {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Security boundary within which cwd must resolve, including through symlinks. */
  readonly workspaceRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv?: readonly string[];
  readonly restBaseUrl: string;
  readonly gatewayUrl: string;
  readonly interactionEndpoint?: string;
  /** Supervisor-owned per-run secret used to authenticate raw-webhook responses. */
  readonly interactionPeerSecret?: string;
  readonly fakeToken?: string;
}

export interface BotProcessOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly atMs: number;
}

/** Parsed supervisor records; free-form messages are redacted before delivery. */
export type BotProcessControl =
  | { readonly kind: 'ready' }
  | { readonly kind: 'handler'; readonly id: string; readonly phase: 'start' | 'end' }
  | { readonly kind: 'diagnostic'; readonly code: 'bot-error'; readonly message: string }
  | { readonly kind: 'adapter-error'; readonly code: 'unsupported'; readonly message: string }
  | {
      readonly kind: 'protocol-error';
      readonly message: 'Invalid or incomplete Bot control record.';
    };

export interface BotProcessSnapshot {
  readonly status: BotProcessStatus;
  readonly pid?: number;
  readonly startedAtMs?: number;
  readonly exitedAtMs?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly output: readonly BotProcessOutput[];
}

export interface BotRunnerOptions {
  readonly now?: () => number;
  readonly maxOutputEntries?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLineBytes?: number;
  readonly onOutput?: (entry: BotProcessOutput) => void;
  /** Consumes reserved control lines separately from human output when present. */
  readonly onControl?: (record: BotProcessControl) => void;
}

export interface BotOutputEvidence {
  /** UTF-8 bytes received from the decoded stdout/stderr streams. */
  readonly receivedBytes: number;
  readonly recordedEntries: number;
  readonly retainedEntries: number;
  readonly retainedBytes: number;
  readonly evictedEntries: number;
  /** Bytes of redacted entries removed from the retained history. */
  readonly evictedBytes: number;
  readonly truncatedLines: number;
  /** Decoded bytes drained after an oversized line's first truncated entry. */
  readonly discardedBytes: number;
  /** Decoded source bytes omitted by string/line limits before entries enter history. */
  readonly clippedBytes: number;
  readonly redactionTruncatedEntries: number;
  readonly observerFailures: number;
  /** Valid reserved records accepted by the dedicated control path. */
  readonly controlRecords: number;
  /** Reserved records rejected, including records discarded after protocol failure. */
  readonly controlErrors: number;
  readonly controlObserverFailures: number;
  readonly complete: boolean;
}

const OUTPUT_REDACTION_LIMIT_CHARACTERS = 100_000;
const CONTROL_PREFIX = 'DISRUNNER_';
const MAX_CONTROL_LINE_BYTES = 4_096;
const MAX_CONTROL_RECORDS = 100_000;
const MAX_CONTROL_HANDLERS = 1_000;
const CONTROL_PROTOCOL_ERROR = 'Invalid or incomplete Bot control record.';

export class BotRunner {
  readonly #now: () => number;
  readonly #maxOutputEntries: number;
  readonly #onOutput: ((entry: BotProcessOutput) => void) | undefined;
  readonly #onControl: ((record: BotProcessControl) => void) | undefined;
  readonly #maxOutputBytes: number;
  readonly #maxOutputLineBytes: number;
  readonly #output: BotProcessOutput[] = [];
  readonly #pendingOutput: Record<BotProcessOutput['stream'], { text: string; dropping: boolean }> =
    {
      stdout: { text: '', dropping: false },
      stderr: { text: '', dropping: false },
    };
  #outputBytes = 0;
  #receivedBytes = 0;
  #recordedEntries = 0;
  #evictedEntries = 0;
  #evictedBytes = 0;
  #truncatedLines = 0;
  #discardedBytes = 0;
  #clippedBytes = 0;
  #redactionTruncatedEntries = 0;
  #observerFailures = 0;
  #controlRecords = 0;
  #controlErrors = 0;
  #controlObserverFailures = 0;
  #controlFailed = false;
  #controlCallbackEnabled = true;
  readonly #controlHandlers = new Set<string>();
  #outputCallbackEnabled = true;
  #sensitiveValues: readonly string[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  /**
   * Process group started by the current run (non-Windows). Retained after the direct child
   * exits until the group is confirmed empty. Captured starttime detects observed leader reuse,
   * but identity checks and signalling are not atomic. Unknown observations retain ownership.
   */
  #ownedGroup: OwnedProcessGroup | undefined;
  // A failed Windows cleanup can outlive its leader. Never retry against a departed PID.
  #windowsCleanupFailure: Error | undefined;
  #generation = 0;
  #stopPromise: Promise<BotProcessSnapshot> | undefined;
  #status: BotProcessStatus = 'stopped';
  #startedAtMs: number | undefined;
  #exitedAtMs: number | undefined;
  #exitCode: number | null | undefined;
  #signal: NodeJS.Signals | null | undefined;

  public constructor(options: BotRunnerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxOutputEntries = boundedLimit(
      options.maxOutputEntries ?? 5_000,
      'maxOutputEntries',
      1_000_000,
    );
    this.#maxOutputBytes = boundedLimit(
      options.maxOutputBytes ?? 1_048_576,
      'maxOutputBytes',
      1_073_741_824,
    );
    this.#maxOutputLineBytes = boundedLimit(
      options.maxOutputLineBytes ?? 65_536,
      'maxOutputLineBytes',
      16_777_216,
    );
    if (this.#maxOutputLineBytes > this.#maxOutputBytes) {
      throw new RangeError('maxOutputLineBytes cannot exceed maxOutputBytes.');
    }
    this.#onOutput = options.onOutput;
    this.#onControl = options.onControl;
  }

  public async start(config: BotProcessConfig): Promise<BotProcessSnapshot> {
    if (
      this.#child === undefined &&
      this.#ownedGroup !== undefined &&
      this.#stopPromise === undefined
    )
      this.#releaseGroupIfEmpty();
    if (
      this.#child !== undefined ||
      this.#windowsCleanupFailure !== undefined ||
      (platform() === 'win32' && this.#stopPromise !== undefined) ||
      this.#ownedGroup !== undefined ||
      this.#status === 'starting' ||
      this.#status === 'running'
    ) {
      throw new Error('Bot process is already running.');
    }
    if (
      config.executable.trim() === '' ||
      Buffer.byteLength(config.executable) > 32_768 ||
      config.executable.includes('\0')
    ) {
      throw new TypeError('Bot executable must contain 1 to 32,768 UTF-8 bytes without NUL.');
    }
    const args = boundedStringArray(config.args ?? [], 'Bot arguments', 1_024, 65_536, 1_048_576);
    const workspaceRoot = await realpath(resolve(config.workspaceRoot));
    const cwd = await realpath(resolve(config.cwd));
    const containedPath = relative(workspaceRoot, cwd);
    if (
      containedPath === '..' ||
      containedPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(containedPath)
    ) {
      throw new TypeError('Bot working directory must resolve inside workspaceRoot.');
    }
    const cwdStats = await stat(cwd);
    if (!cwdStats.isDirectory()) throw new TypeError('Bot working directory must be a directory.');
    assertOfflineUrl(config.restBaseUrl);
    assertOfflineGatewayUrl(config.gatewayUrl);
    if (config.interactionEndpoint !== undefined) assertOfflineUrl(config.interactionEndpoint);
    const fakeToken = assertSyntheticToken(config.fakeToken ?? createOfflineSessionToken());
    const interactionPeerSecret =
      config.interactionPeerSecret === undefined
        ? undefined
        : requireInteractionPeerSecret(config.interactionPeerSecret);
    assertInteractionAuthenticationPair(config.interactionEndpoint, interactionPeerSecret);
    const environment = sanitizeBotEnvironment(process.env, {
      ...config,
      fakeToken,
      ...(interactionPeerSecret === undefined ? {} : { interactionPeerSecret }),
    });
    this.#status = 'starting';
    this.#output.length = 0;
    this.#outputBytes = 0;
    this.#receivedBytes = 0;
    this.#recordedEntries = 0;
    this.#evictedEntries = 0;
    this.#evictedBytes = 0;
    this.#truncatedLines = 0;
    this.#discardedBytes = 0;
    this.#clippedBytes = 0;
    this.#redactionTruncatedEntries = 0;
    this.#observerFailures = 0;
    this.#controlRecords = 0;
    this.#controlErrors = 0;
    this.#controlObserverFailures = 0;
    this.#controlFailed = false;
    this.#controlCallbackEnabled = true;
    this.#controlHandlers.clear();
    this.#outputCallbackEnabled = true;
    this.#pendingOutput.stdout = { text: '', dropping: false };
    this.#pendingOutput.stderr = { text: '', dropping: false };
    this.#startedAtMs = this.#now();
    this.#exitedAtMs = undefined;
    this.#exitCode = undefined;
    this.#signal = undefined;
    this.#sensitiveValues = [
      ...Object.entries(config.env ?? {})
        .filter(([key]) =>
          /(?:^|_)(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|CREDENTIAL)$/iu.test(
            key,
          ),
        )
        .flatMap(([, value]) => (typeof value === 'string' && value !== '' ? [value] : [])),
      fakeToken,
      ...(interactionPeerSecret === undefined ? [] : [interactionPeerSecret]),
    ];

    const generation = ++this.#generation;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.executable, args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: platform() !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#status = 'crashed';
      this.#exitedAtMs = this.#now();
      throw error;
    }
    this.#child = child;
    if (platform() !== 'win32' && child.pid !== undefined) {
      // detached:true makes the child the leader of a new process group whose PGID is its PID.
      this.#ownedGroup = { pgid: child.pid, leaderStartTime: procStartTime(child.pid) };
    }
    // Late events from an older child must never mutate a newer run's state.
    const current = (): boolean => this.#generation === generation;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (current()) this.#consumeOutput('stdout', chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      if (current()) this.#consumeOutput('stderr', chunk);
    });
    child.stdout.on('end', () => {
      if (current()) this.#flushOutput('stdout');
    });
    child.stderr.on('end', () => {
      if (current()) this.#flushOutput('stderr');
    });
    const onSpawn = (): void => {
      if (current() && this.#child === child) this.#status = 'running';
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      if (!current()) return;
      this.#recordOutput('stderr', error.stack ?? error.message);
      if (this.#child === child) {
        this.#status = 'crashed';
        this.#exitedAtMs = this.#now();
        // A child-level error is not proof of termination; ownership is retained when a PID exists.
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
          this.#child = undefined;
      }
    };
    child.once('spawn', onSpawn);
    // Stays attached for the child's lifetime so a late 'error' can never become uncaught.
    child.on('error', onError);
    child.once('exit', (code, signal) => {
      if (!current()) return;
      this.#flushOutput('stdout');
      this.#flushOutput('stderr');
      this.#exitCode = code;
      this.#signal = signal;
      this.#exitedAtMs = this.#now();
      if (this.#status !== 'stopping') this.#status = code === 0 ? 'stopped' : 'crashed';
      else this.#status = 'stopped';
      if (this.#child === child) this.#child = undefined;
      // Forget the group as soon as it is confirmed empty; keep it while descendants survive.
      if (this.#stopPromise === undefined) this.#releaseGroupIfEmpty();
    });
    await waitForSpawn(child);
    const spawnedPid = child.pid;
    const group = this.#ownedGroup;
    if (
      spawnedPid !== undefined &&
      group?.pgid === spawnedPid &&
      group.leaderStartTime === undefined
    )
      this.#ownedGroup = { pgid: spawnedPid, leaderStartTime: procStartTime(spawnedPid) };
    return this.snapshot();
  }

  public async stop(graceMs = 5_000): Promise<BotProcessSnapshot> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647) {
      throw new RangeError(
        'Shutdown grace period must be a safe integer from 0 through 2,147,483,647 ms.',
      );
    }
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const child = this.#child;
    if (
      this.#windowsCleanupFailure !== undefined &&
      (child === undefined || this.#windowsCleanupFailure instanceof WindowsTaskkillTimeoutError)
    )
      throw this.#windowsCleanupFailure;
    if (child === undefined && this.#ownedGroup === undefined) return this.snapshot();
    const operation = this.#stopOwned(child, graceMs);
    this.#stopPromise = operation;
    try {
      const snapshot = await operation;
      this.#windowsCleanupFailure = undefined;
      return snapshot;
    } catch (error) {
      if (platform() === 'win32') {
        this.#windowsCleanupFailure =
          error instanceof Error ? error : new Error('Windows bot cleanup could not be confirmed.');
      }
      throw error;
    } finally {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    }
  }

  public async restart(config: BotProcessConfig, graceMs = 5_000): Promise<BotProcessSnapshot> {
    await this.stop(graceMs);
    return this.start(config);
  }

  public snapshot(): BotProcessSnapshot {
    return {
      status: this.#status,
      ...(this.#child?.pid === undefined ? {} : { pid: this.#child.pid }),
      ...(this.#startedAtMs === undefined ? {} : { startedAtMs: this.#startedAtMs }),
      ...(this.#exitedAtMs === undefined ? {} : { exitedAtMs: this.#exitedAtMs }),
      ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode }),
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      output: this.#output.map((entry) => ({ ...entry })),
    };
  }

  /** Capture completeness for the current run; reading snapshots does not change it. */
  public evidence(): BotOutputEvidence {
    return {
      receivedBytes: this.#receivedBytes,
      recordedEntries: this.#recordedEntries,
      retainedEntries: this.#output.length,
      retainedBytes: this.#outputBytes,
      evictedEntries: this.#evictedEntries,
      evictedBytes: this.#evictedBytes,
      truncatedLines: this.#truncatedLines,
      discardedBytes: this.#discardedBytes,
      clippedBytes: this.#clippedBytes,
      redactionTruncatedEntries: this.#redactionTruncatedEntries,
      observerFailures: this.#observerFailures,
      controlRecords: this.#controlRecords,
      controlErrors: this.#controlErrors,
      controlObserverFailures: this.#controlObserverFailures,
      complete:
        this.#evictedEntries === 0 &&
        this.#truncatedLines === 0 &&
        this.#redactionTruncatedEntries === 0 &&
        this.#observerFailures === 0 &&
        this.#controlErrors === 0 &&
        this.#controlObserverFailures === 0,
    };
  }

  /** Non-mutating supervision observation; snapshot stays event-driven until Node reaps the child. */
  public observeExit(): 'alive' | 'exited' | 'unknown' {
    const child = this.#child;
    if (child === undefined) return this.#exitedAtMs === undefined ? 'unknown' : 'exited';
    if (child.exitCode !== null || child.signalCode !== null) return 'exited';
    if (process.platform !== 'linux' || child.pid === undefined) return 'unknown';
    return directChildExitObservation(child.pid, this.#ownedGroup?.leaderStartTime);
  }

  /**
   * Resolves only after the owned child and its owned process group are confirmed terminated.
   * Otherwise rejects and retains ownership so a later stop() can retry; start() stays blocked.
   */
  async #stopOwned(
    child: ChildProcessWithoutNullStreams | undefined,
    graceMs: number,
  ): Promise<BotProcessSnapshot> {
    const generation = this.#generation;
    if (child !== undefined) this.#status = 'stopping';
    const forceWaitMs = Math.min(2_000, graceMs || 2_000);
    let forced = false;
    try {
      await this.#signalOwned(child, false, forceWaitMs);
    } catch (error) {
      // Only a completed helper is safe to supersede. Never target a departed child's PID.
      if (
        !(error instanceof WindowsTaskkillExitError) ||
        child === undefined ||
        this.#child !== child ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw error;
      await this.#signalOwned(child, true, forceWaitMs);
      forced = true;
    }
    if (!(await this.#waitForOwnedTermination(child, forced ? forceWaitMs : graceMs))) {
      if (forced)
        throw new Error(
          'Bot process termination could not be confirmed; ownership is retained for retry.',
        );
      await this.#signalOwned(child, true, Math.min(2_000, graceMs || 2_000));
      if (!(await this.#waitForOwnedTermination(child, Math.min(2_000, graceMs || 2_000)))) {
        throw new Error(
          'Bot process termination could not be confirmed; ownership is retained for retry.',
        );
      }
    }
    if (this.#generation === generation) {
      this.#ownedGroup = undefined;
      if (this.#child === child) this.#child = undefined;
    }
    return this.snapshot();
  }

  async #signalOwned(
    child: ChildProcessWithoutNullStreams | undefined,
    force: boolean,
    commandTimeoutMs: number,
  ): Promise<void> {
    if (platform() === 'win32') {
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null)
        await runTaskkill(child.pid, force, commandTimeoutMs);
      return;
    }
    const group = this.#ownedGroup;
    if (group === undefined) return;
    const state = ownedGroupState(group);
    if (state === 'empty') return;
    if (state === 'unknown')
      throw new Error(
        'Bot process group identity or liveness is uncertain; ownership is retained.',
      );
    try {
      process.kill(-group.pgid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  async #waitForOwnedTermination(
    child: ChildProcessWithoutNullStreams | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    if (child !== undefined && !(await waitForExit(child, timeoutMs))) return false;
    const group = this.#ownedGroup;
    // Windows: a successful taskkill /T and direct-child exit are required. These observations
    // are not independent proof of descendant termination; real Windows qualification is pending.
    if (platform() === 'win32' || group === undefined) return true;
    for (;;) {
      if (ownedGroupState(group) === 'empty') return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remaining)));
    }
  }

  #releaseGroupIfEmpty(): void {
    const group = this.#ownedGroup;
    if (group !== undefined && ownedGroupState(group) === 'empty') this.#ownedGroup = undefined;
  }

  #consumeOutput(stream: BotProcessOutput['stream'], raw: string): void {
    this.#receivedBytes += Buffer.byteLength(raw);
    const pending = this.#pendingOutput[stream];
    let input = raw;
    while (input.length > 0) {
      const newline = input.indexOf('\n');
      const part = newline < 0 ? input : input.slice(0, newline + 1);
      input = newline < 0 ? '' : input.slice(newline + 1);
      if (pending.dropping) this.#discardedBytes += Buffer.byteLength(part);
      if (!pending.dropping) pending.text += part;
      const control = this.#onControl !== undefined && pending.text.startsWith(CONTROL_PREFIX);
      const possibleControlPrefix =
        this.#onControl !== undefined && newline < 0 && CONTROL_PREFIX.startsWith(pending.text);
      const lineLimit = control ? MAX_CONTROL_LINE_BYTES : this.#maxOutputLineBytes;
      if (
        !pending.dropping &&
        !possibleControlPrefix &&
        Buffer.byteLength(pending.text) > lineLimit
      ) {
        this.#truncatedLines += 1;
        // A later chunk may complete a secret already present in this prefix.
        this.#clippedBytes += Buffer.byteLength(pending.text);
        if (control) this.#rejectControl();
        else this.#recordOutput(stream, '[TRUNCATED]\n', true);
        pending.text = '';
        pending.dropping = newline < 0;
      } else if (newline >= 0) {
        if (!pending.dropping) {
          if (control) this.#consumeControl(stream, pending.text);
          else this.#recordOutput(stream, pending.text);
        }
        pending.text = '';
        pending.dropping = false;
      }
    }
  }

  #flushOutput(stream: BotProcessOutput['stream']): void {
    const pending = this.#pendingOutput[stream];
    if (pending.text !== '') {
      if (this.#onControl !== undefined && pending.text.startsWith(CONTROL_PREFIX))
        this.#rejectControl();
      else this.#recordOutput(stream, pending.text);
    }
    pending.text = '';
    pending.dropping = false;
  }

  #consumeControl(stream: BotProcessOutput['stream'], raw: string): void {
    if (this.#controlFailed || stream !== 'stdout' || this.#controlRecords >= MAX_CONTROL_RECORDS) {
      this.#rejectControl();
      return;
    }
    let record: Exclude<BotProcessControl, { kind: 'protocol-error' }>;
    try {
      record = parseControlRecord(raw);
      if (record.kind === 'handler') {
        if (record.phase === 'start') {
          if (
            this.#controlHandlers.size >= MAX_CONTROL_HANDLERS ||
            this.#controlHandlers.has(record.id)
          )
            throw new Error(CONTROL_PROTOCOL_ERROR);
          this.#controlHandlers.add(record.id);
        } else if (!this.#controlHandlers.delete(record.id)) {
          throw new Error(CONTROL_PROTOCOL_ERROR);
        }
      } else if (record.kind === 'diagnostic' || record.kind === 'adapter-error') {
        record = { ...record, message: this.#redactOutput(record.message) };
      }
    } catch {
      this.#rejectControl();
      return;
    }
    this.#controlRecords += 1;
    this.#notifyControl(record);
  }

  #rejectControl(): void {
    this.#controlErrors += 1;
    if (this.#controlFailed) return;
    this.#controlFailed = true;
    this.#notifyControl({ kind: 'protocol-error', message: CONTROL_PROTOCOL_ERROR });
  }

  #notifyControl(record: BotProcessControl): void {
    if (!this.#controlCallbackEnabled || this.#onControl === undefined) return;
    try {
      this.#onControl(Object.freeze(record));
    } catch {
      this.#controlObserverFailures += 1;
      this.#controlFailed = true;
      this.#controlCallbackEnabled = false;
      this.#recordOutput('stderr', '[DisRunner] Control observer threw and was disabled.\n');
    }
  }

  #redactOutput(raw: string): string {
    if (raw.length > OUTPUT_REDACTION_LIMIT_CHARACTERS) {
      this.#redactionTruncatedEntries += 1;
      this.#clippedBytes += Buffer.byteLength(raw.slice(OUTPUT_REDACTION_LIMIT_CHARACTERS));
    }
    const redacted = redactString(raw, {
      sensitiveValues: this.#sensitiveValues,
      maxStringLength: OUTPUT_REDACTION_LIMIT_CHARACTERS,
    });
    if (redacted === '[REDACTION_SENSITIVE_VALUES_LIMIT]') {
      if (raw.length <= OUTPUT_REDACTION_LIMIT_CHARACTERS) this.#redactionTruncatedEntries += 1;
      this.#clippedBytes += Buffer.byteLength(raw.slice(0, OUTPUT_REDACTION_LIMIT_CHARACTERS));
    }
    return redacted;
  }

  #recordOutput(stream: BotProcessOutput['stream'], raw: string, sanitized = false): void {
    const text = sanitized ? raw : this.#redactOutput(raw);
    const entry: BotProcessOutput = { stream, text, atMs: this.#now() };
    this.#appendOutput(entry);
    if (!this.#outputCallbackEnabled || this.#onOutput === undefined) return;
    try {
      this.#onOutput({ ...entry });
    } catch {
      this.#observerFailures += 1;
      this.#outputCallbackEnabled = false;
      this.#appendOutput({
        stream: 'stderr',
        text: '[DisRunner] Output observer threw and was disabled.\n',
        atMs: this.#now(),
      });
    }
  }

  #appendOutput(entry: BotProcessOutput): void {
    this.#recordedEntries += 1;
    const entryBytes = Buffer.byteLength(entry.text);
    this.#output.push(entry);
    this.#outputBytes += entryBytes;
    while (
      this.#output.length > 0 &&
      (this.#output.length > this.#maxOutputEntries || this.#outputBytes > this.#maxOutputBytes)
    ) {
      const removed = this.#output.shift();
      if (removed !== undefined) {
        const removedBytes = Buffer.byteLength(removed.text);
        this.#outputBytes -= removedBytes;
        this.#evictedEntries += 1;
        this.#evictedBytes += removedBytes;
      }
    }
  }
}

function parseControlRecord(raw: string): Exclude<BotProcessControl, { kind: 'protocol-error' }> {
  if (!raw.endsWith('\n') || Buffer.byteLength(raw) > MAX_CONTROL_LINE_BYTES)
    throw new Error(CONTROL_PROTOCOL_ERROR);
  const line = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.slice(0, -1);
  if (line === 'DISRUNNER_ADAPTER_READY') return { kind: 'ready' };
  const separator = line.indexOf(' ');
  if (separator < 0) throw new Error(CONTROL_PROTOCOL_ERROR);
  const prefix = line.slice(0, separator);
  const payload = line.slice(separator + 1);
  if (!['DISRUNNER_HANDLER', 'DISRUNNER_DIAGNOSTIC', 'DISRUNNER_ADAPTER_ERROR'].includes(prefix))
    throw new Error(CONTROL_PROTOCOL_ERROR);
  const value: unknown = JSON.parse(payload);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(CONTROL_PROTOCOL_ERROR);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  // These are flat two-string records. Every extra key, including a duplicate key erased by
  // JSON.parse, introduces at least one additional string token in the original JSON.
  if (payload.match(/"(?:\\.|[^"\\])*"/gu)?.length !== 4) throw new Error(CONTROL_PROTOCOL_ERROR);
  if (prefix === 'DISRUNNER_HANDLER') {
    if (
      keys.join(',') !== 'id,phase' ||
      typeof object['id'] !== 'string' ||
      !isControlHandlerId(object['id']) ||
      (object['phase'] !== 'start' && object['phase'] !== 'end')
    )
      throw new Error(CONTROL_PROTOCOL_ERROR);
    return { kind: 'handler', id: object['id'], phase: object['phase'] };
  }
  if (
    keys.join(',') !== 'code,message' ||
    typeof object['message'] !== 'string' ||
    object['message'].trim() === ''
  )
    throw new Error(CONTROL_PROTOCOL_ERROR);
  if (prefix === 'DISRUNNER_DIAGNOSTIC' && object['code'] === 'bot-error')
    return { kind: 'diagnostic', code: 'bot-error', message: object['message'] };
  if (prefix === 'DISRUNNER_ADAPTER_ERROR' && object['code'] === 'unsupported')
    return { kind: 'adapter-error', code: 'unsupported', message: object['message'] };
  throw new Error(CONTROL_PROTOCOL_ERROR);
}

function isControlHandlerId(id: string): boolean {
  const match =
    /^(?:(?:js|py)-([1-9][0-9]{0,9})-(0|[1-9][0-9]{0,19})|raw-([1-9][0-9]{0,19}))$/u.exec(id);
  if (match === null) return false;
  const counter = match[3] ?? match[2];
  return (
    counter !== undefined &&
    BigInt(counter) <= 0xffff_ffff_ffff_ffffn &&
    (match[1] === undefined || BigInt(match[1]) <= 0xffff_ffffn)
  );
}

export function sanitizeBotEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  config: Pick<
    BotProcessConfig,
    | 'env'
    | 'inheritEnv'
    | 'fakeToken'
    | 'restBaseUrl'
    | 'gatewayUrl'
    | 'interactionEndpoint'
    | 'interactionPeerSecret'
  >,
): NodeJS.ProcessEnv {
  const interactionPeerSecret =
    config.interactionPeerSecret === undefined
      ? undefined
      : requireInteractionPeerSecret(config.interactionPeerSecret);
  assertInteractionAuthenticationPair(config.interactionEndpoint, interactionPeerSecret);
  const output: NodeJS.ProcessEnv = {};
  const requestedInheritance = boundedStringArray(
    config.inheritEnv ?? [],
    'Inherited environment keys',
    256,
    256,
    65_536,
  );
  const inherited = new Set(
    [...DEFAULT_INHERITED_ENV, ...requestedInheritance].map((key) => key.toUpperCase()),
  );
  for (const [key, value] of boundedEnvironmentEntries(base, 'Base environment', 10_000)) {
    if (inherited.has(key.toUpperCase()) && !isTokenEnvironmentKey(key) && value !== undefined)
      output[key] = value;
  }
  for (const [key, value] of boundedEnvironmentEntries(config.env ?? {}, 'Bot environment', 256)) {
    if (value !== undefined && isDiscordTokenShaped(value))
      throw new TypeError(`Environment value ${key} looks like a Discord credential.`);
    if (!isTokenEnvironmentKey(key) && value !== undefined) output[key] = value;
  }
  const fakeToken = assertSyntheticToken(config.fakeToken ?? createOfflineSessionToken());
  output['DISRUNNER_OFFLINE'] = '1';
  output['DISRUNNER_NETWORK_POLICY'] = 'loopback-only';
  output['DISRUNNER_FAKE_TOKEN'] = fakeToken;
  output['DISCORD_TOKEN'] = fakeToken;
  output['DISCORD_API_BASE_URL'] = config.restBaseUrl;
  output['DISCORD_GATEWAY_URL'] = config.gatewayUrl;
  if (config.interactionEndpoint !== undefined)
    output['DISRUNNER_INTERACTION_ENDPOINT'] = config.interactionEndpoint;
  if (interactionPeerSecret !== undefined) {
    output['DISRUNNER_WEBHOOK_PEER_SECRET'] = interactionPeerSecret;
  }
  return output;
}

export const DEFAULT_INHERITED_ENV = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

function isTokenEnvironmentKey(key: string): boolean {
  return /(?:^|_)(?:DISCORD_)?(?:BOT_)?(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)(?:$|_)/i.test(
    key,
  );
}

function requireInteractionPeerSecret(value: string): string {
  if (!/^[a-f\d]{64}$/iu.test(value)) {
    throw new TypeError('interactionPeerSecret must be a 32-byte hexadecimal value.');
  }
  return value.toLowerCase();
}

function assertInteractionAuthenticationPair(
  interactionEndpoint: string | undefined,
  interactionPeerSecret: string | undefined,
): void {
  if ((interactionEndpoint === undefined) !== (interactionPeerSecret === undefined)) {
    throw new TypeError('interactionEndpoint and interactionPeerSecret must be supplied together.');
  }
}

function boundedLimit(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer from 1 through ${maximum}.`);
  }
  return value;
}

function boundedStringArray(
  value: readonly string[],
  label: string,
  maxEntries: number,
  maxEntryBytes: number,
  maxTotalBytes: number,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > maxEntries) {
    throw new RangeError(`${label} cannot contain more than ${maxEntries} entries.`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[value.length] !== 'length') {
    throw new TypeError(`${label} must be dense and must not contain custom properties.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties.`);
  }
  const output: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (names[index] !== String(index)) {
      throw new TypeError(`${label} must be dense and must not contain custom properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${label} entries must be string data properties.`);
    }
    const entryValue = descriptor.value as unknown;
    if (typeof entryValue !== 'string') {
      throw new TypeError(`${label} entries must be string data properties.`);
    }
    const bytes = Buffer.byteLength(entryValue);
    if (bytes > maxEntryBytes) {
      throw new RangeError(`${label} entries cannot exceed ${maxEntryBytes} UTF-8 bytes.`);
    }
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      throw new RangeError(`${label} cannot exceed ${maxTotalBytes} total UTF-8 bytes.`);
    }
    output.push(entryValue);
  }
  return output;
}

function boundedEnvironmentEntries(
  value: Readonly<Record<string, string | undefined>>,
  label: string,
  maxEntries: number,
): readonly (readonly [string, string | undefined])[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null && value !== process.env) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties.`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length > maxEntries) {
    throw new RangeError(`${label} cannot contain more than ${maxEntries} entries.`);
  }
  const output: (readonly [string, string | undefined])[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
    if (
      name.length === 0 ||
      name.includes('=') ||
      name.includes('\0') ||
      Buffer.byteLength(name) > 256
    ) {
      throw new TypeError(`${label} contains an invalid environment key.`);
    }
    const entryValue = descriptor.value as unknown;
    if (entryValue !== undefined && typeof entryValue !== 'string') {
      throw new TypeError(`${label} values must be strings or undefined.`);
    }
    const valueBytes = entryValue === undefined ? 0 : Buffer.byteLength(entryValue);
    if (valueBytes > 65_536) {
      throw new RangeError(`${label} values cannot exceed 65,536 UTF-8 bytes.`);
    }
    totalBytes += Buffer.byteLength(name) + valueBytes;
    if (totalBytes > 1_048_576) {
      throw new RangeError(`${label} cannot exceed 1,048,576 total UTF-8 bytes.`);
    }
    output.push([name, entryValue]);
  }
  return output;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // Whichever event wins detaches the other, so no loser listener outlives the wait.
    const onSpawn = (): void => {
      child.off('error', onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    // When the timer wins, the exit listener is detached immediately rather than left behind.
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

interface OwnedProcessGroup {
  readonly pgid: number;
  /** /proc starttime of the leader, used to detect PGID reuse after the leader is gone. */
  readonly leaderStartTime: string | undefined;
}

/**
 * 'empty' when no live (non-zombie) member of the owned group remains. A PGID cannot be reused
 * while any member exists, so a live process whose PID equals the PGID but whose starttime differs
 * from the recorded leader proves the owned group is already gone.
 */
function ownedGroupState(group: OwnedProcessGroup): 'alive' | 'empty' | 'unknown' {
  if (process.platform === 'linux') {
    const leader = readProcStat(group.pgid);
    if (leader.kind === 'unknown') return 'unknown';
    if (leader.kind === 'present') {
      if (group.leaderStartTime === undefined) return 'unknown';
      if (leader.stat.startTime !== group.leaderStartTime) return 'empty';
    }
  }
  try {
    process.kill(-group.pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'empty' : 'unknown';
  }
  if (process.platform !== 'linux') return 'alive';
  // A group can outlive a reused leader too. Without the original identity, only ESRCH
  // above proves it is safe to release; a successful existence probe cannot authorize a kill.
  if (group.leaderStartTime === undefined) return 'unknown';
  // kill(-pgid, 0) also succeeds for zombies awaiting reaping; only live members count.
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return 'unknown';
  }
  let uncertain = false;
  let observedMember = false;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const member = readProcStat(Number(entry));
    if (member.kind === 'unknown') uncertain = true;
    if (member.kind === 'present' && member.stat.pgid === group.pgid) {
      observedMember = true;
      if (member.stat.state !== 'Z' && member.stat.state !== 'X') return 'alive';
    }
  }
  return uncertain || !observedMember ? 'unknown' : 'empty';
}

type ProcStatResult =
  | {
      readonly kind: 'present';
      readonly stat: { readonly state: string; readonly pgid: number; readonly startTime: string };
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

function procStartTime(pid: number): string | undefined {
  const result = readProcStat(pid);
  return result.kind === 'present' ? result.stat.startTime : undefined;
}

function directChildExitObservation(
  pid: number,
  startTime: string | undefined,
): 'alive' | 'exited' | 'unknown' {
  const result = readProcStat(pid);
  if (result.kind === 'unknown') return 'unknown';
  if (result.kind === 'missing') return 'exited';
  if (
    result.stat.state === 'Z' ||
    result.stat.state === 'X' ||
    (startTime !== undefined && result.stat.startTime !== startTime)
  )
    return 'exited';
  return startTime === undefined ? 'unknown' : 'alive';
}

function readProcStat(pid: number): ProcStatResult {
  if (process.platform !== 'linux') return { kind: 'unknown' };
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unknown' };
    // A missing procfs mount is not evidence that this child exited. Check a known-own record
    // before interpreting per-PID ENOENT; unreadable or malformed procfs remains uncertain.
    try {
      const self = parseProcStat(process.pid, readFileSync('/proc/self/stat', 'utf8'));
      if (self.kind !== 'present') return { kind: 'unknown' };
      // A readable self record alone does not rule out hidepid visibility restrictions.
      // Only ESRCH from a non-destructive PID probe confirms this target is missing.
      try {
        process.kill(pid, 0);
        return { kind: 'unknown' };
      } catch (probeError) {
        return {
          kind: (probeError as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unknown',
        };
      }
    } catch {
      return { kind: 'unknown' };
    }
  }
  return parseProcStat(pid, raw);
}

function parseProcStat(pid: number, raw: string): ProcStatResult {
  const closingParen = raw.lastIndexOf(')');
  if (!raw.startsWith(`${pid} (`) || closingParen < 0) return { kind: 'unknown' };
  const fields = raw
    .slice(closingParen + 2)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (
    state === undefined ||
    !/^[RSDZTtXxKWPI]$/u.test(state) ||
    !Number.isSafeInteger(pgid) ||
    pgid < 0 ||
    startTime === undefined ||
    !/^\d+$/u.test(startTime)
  )
    return { kind: 'unknown' };
  return { kind: 'present', stat: { state, pgid, startTime } };
}

// A timed-out mutating helper may still be alive, even after kill() returns true. Never clear
// that uncertainty by launching another helper or a new bot run.
class WindowsTaskkillTimeoutError extends Error {}

// Only this completed nonzero outcome permits automatic graceful-to-force escalation.
class WindowsTaskkillExitError extends Error {
  public constructor(code: number) {
    super(`Windows taskkill exited with code ${code}; process-tree termination is unconfirmed.`);
  }
}

/** Windows: observes taskkill failure; success still requires awaiting the owned child. */
function runTaskkill(pid: number, force: boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const failure = (): Error =>
      new Error(
        'Windows taskkill failed or timed out; process-tree termination is uncertain and ownership is retained.',
      );
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      reject(failure());
      return;
    }
    let settled = false;
    const finish = (success: boolean, timedOut = false, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.off('exit', onExit);
      if (success) resolvePromise();
      else
        reject(
          timedOut
            ? new WindowsTaskkillTimeoutError(failure().message)
            : exitCode === undefined
              ? failure()
              : new WindowsTaskkillExitError(exitCode),
        );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        code === 0 && signal === null,
        false,
        code !== null && code !== 0 && signal === null ? code : undefined,
      );
    const timer = setTimeout(() => {
      finish(false, true);
      // Terminate only our taskkill helper, never an exited bot's potentially reused PID.
      try {
        killer.kill();
      } catch {
        /* Cleanup remains uncertain even if helper termination fails. */
      }
    }, timeoutMs);
    // A late helper error must remain handled after the bounded wait has settled.
    killer.on('error', () => finish(false));
    killer.once('exit', onExit);
  });
}
