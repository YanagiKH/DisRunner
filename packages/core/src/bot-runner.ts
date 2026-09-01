import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
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
  readonly fakeToken?: string;
}

export interface BotProcessOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly atMs: number;
}

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
}

export class BotRunner {
  readonly #now: () => number;
  readonly #maxOutputEntries: number;
  readonly #onOutput: ((entry: BotProcessOutput) => void) | undefined;
  readonly #maxOutputBytes: number;
  readonly #maxOutputLineBytes: number;
  readonly #output: BotProcessOutput[] = [];
  readonly #pendingOutput: Record<BotProcessOutput['stream'], { text: string; dropping: boolean }> =
    {
      stdout: { text: '', dropping: false },
      stderr: { text: '', dropping: false },
    };
  #outputBytes = 0;
  #outputCallbackEnabled = true;
  #sensitiveValues: readonly string[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
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
  }

  public async start(config: BotProcessConfig): Promise<BotProcessSnapshot> {
    if (this.#child !== undefined || this.#status === 'starting' || this.#status === 'running') {
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
    const environment = sanitizeBotEnvironment(process.env, {
      ...config,
      fakeToken,
    });
    this.#status = 'starting';
    this.#output.length = 0;
    this.#outputBytes = 0;
    this.#outputCallbackEnabled = true;
    this.#pendingOutput.stdout = { text: '', dropping: false };
    this.#pendingOutput.stderr = { text: '', dropping: false };
    this.#startedAtMs = this.#now();
    this.#exitedAtMs = undefined;
    this.#exitCode = undefined;
    this.#signal = undefined;
    this.#sensitiveValues = [fakeToken];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.executable, args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#status = 'crashed';
      this.#exitedAtMs = this.#now();
      throw error;
    }
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consumeOutput('stdout', chunk));
    child.stderr.on('data', (chunk: string) => this.#consumeOutput('stderr', chunk));
    child.stdout.on('end', () => this.#flushOutput('stdout'));
    child.stderr.on('end', () => this.#flushOutput('stderr'));
    child.once('spawn', () => {
      if (this.#child === child) this.#status = 'running';
    });
    child.once('error', (error) => {
      this.#recordOutput('stderr', error.stack ?? error.message);
      this.#status = 'crashed';
      this.#exitedAtMs = this.#now();
      if (this.#child === child) this.#child = undefined;
    });
    child.once('exit', (code, signal) => {
      this.#flushOutput('stdout');
      this.#flushOutput('stderr');
      this.#exitCode = code;
      this.#signal = signal;
      this.#exitedAtMs = this.#now();
      if (this.#status !== 'stopping') this.#status = code === 0 ? 'stopped' : 'crashed';
      else this.#status = 'stopped';
      if (this.#child === child) this.#child = undefined;
    });
    await waitForSpawn(child);
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
    if (child === undefined) return this.snapshot();
    const operation = this.#stopChild(child, graceMs);
    this.#stopPromise = operation;
    try {
      return await operation;
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

  async #stopChild(
    child: ChildProcessWithoutNullStreams,
    graceMs: number,
  ): Promise<BotProcessSnapshot> {
    this.#status = 'stopping';
    terminateOwnedProcess(child, false);
    const exited = await waitForExit(child, graceMs);
    if (!exited) {
      terminateOwnedProcess(child, true);
      await waitForExit(child, Math.min(2_000, graceMs || 2_000));
    }
    return this.snapshot();
  }

  #consumeOutput(stream: BotProcessOutput['stream'], raw: string): void {
    const pending = this.#pendingOutput[stream];
    let input = raw;
    while (input.length > 0) {
      const newline = input.indexOf('\n');
      const part = newline < 0 ? input : input.slice(0, newline + 1);
      input = newline < 0 ? '' : input.slice(newline + 1);
      if (!pending.dropping) pending.text += part;
      if (!pending.dropping && Buffer.byteLength(pending.text) > this.#maxOutputLineBytes) {
        const redacted = redactString(pending.text, { sensitiveValues: this.#sensitiveValues });
        this.#recordOutput(
          stream,
          `${truncateUtf8(redacted, this.#maxOutputLineBytes)}…[TRUNCATED]\n`,
        );
        pending.text = '';
        pending.dropping = newline < 0;
      } else if (newline >= 0) {
        if (!pending.dropping) this.#recordOutput(stream, pending.text);
        pending.text = '';
        pending.dropping = false;
      }
    }
  }

  #flushOutput(stream: BotProcessOutput['stream']): void {
    const pending = this.#pendingOutput[stream];
    if (pending.text !== '') this.#recordOutput(stream, pending.text);
    pending.text = '';
    pending.dropping = false;
  }

  #recordOutput(stream: BotProcessOutput['stream'], raw: string): void {
    const text = redactString(raw, { sensitiveValues: this.#sensitiveValues });
    const entry: BotProcessOutput = { stream, text, atMs: this.#now() };
    this.#appendOutput(entry);
    if (!this.#outputCallbackEnabled || this.#onOutput === undefined) return;
    try {
      this.#onOutput({ ...entry });
    } catch {
      this.#outputCallbackEnabled = false;
      this.#appendOutput({
        stream: 'stderr',
        text: '[DisRunner] Output observer threw and was disabled.\n',
        atMs: this.#now(),
      });
    }
  }

  #appendOutput(entry: BotProcessOutput): void {
    const entryBytes = Buffer.byteLength(entry.text);
    this.#output.push(entry);
    this.#outputBytes += entryBytes;
    while (
      this.#output.length > 0 &&
      (this.#output.length > this.#maxOutputEntries || this.#outputBytes > this.#maxOutputBytes)
    ) {
      const removed = this.#output.shift();
      if (removed !== undefined) this.#outputBytes -= Buffer.byteLength(removed.text);
    }
  }
}

export function sanitizeBotEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  config: Pick<
    BotProcessConfig,
    'env' | 'inheritEnv' | 'fakeToken' | 'restBaseUrl' | 'gatewayUrl' | 'interactionEndpoint'
  >,
): NodeJS.ProcessEnv {
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

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

function terminateOwnedProcess(child: ChildProcessWithoutNullStreams, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
