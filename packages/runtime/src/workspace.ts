import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

export interface WorkspaceScenario {
  readonly name: string;
  readonly format: 'json' | 'yaml';
  readonly source: string;
}

export interface WorkspaceDocument {
  readonly version: 1;
  readonly resources: readonly Readonly<Record<string, unknown>>[];
  readonly scenarios: readonly WorkspaceScenario[];
  readonly options: { readonly seed: number; readonly mode: 'strict' | 'lenient' };
}

export interface WorkspaceSnapshot {
  readonly status: 'missing' | 'ready' | 'future' | 'corrupt';
  readonly path: string;
  readonly hash: string | null;
  readonly document: WorkspaceDocument | null;
  readonly version: number | null;
  readonly backupAvailable: boolean;
  readonly error: string | null;
}

export class WorkspaceError extends Error {
  public constructor(
    public readonly code: 'invalid' | 'conflict' | 'future-version' | 'busy' | 'unsafe-path',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const MAX_BYTES = 8 * 1_048_576;
const MAX_SCENARIO_BYTES = 262_144;
const RESOURCE_TYPES = new Set(['guild', 'channel', 'role', 'user', 'member', 'message']);
// Keep fixture placeholders editable without granting transport or interaction support.
const CHANNEL_TYPES = new Set([0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 16]);
const FILE_NAME = 'workspace.json';
const BACKUP_NAME = 'workspace.backup.json';
const LOCK_NAME = 'workspace.lock';
const SENSITIVE_KEY =
  /^(?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)$/iu;
const CREDENTIAL =
  /(?:\bdisrunner\.offline\.[A-Za-z0-9_-]{16,}\b|\bmfa\.[A-Za-z0-9_-]{20,}\b|\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{16,})/u;

export function emptyWorkspace(): WorkspaceDocument {
  return { version: 1, resources: [], scenarios: [], options: { seed: 42, mode: 'strict' } };
}

/** Validate and copy data without invoking accessors or retaining caller-owned objects. */
export function parseWorkspace(value: unknown): WorkspaceDocument {
  const copied = copyJson(value);
  const document = record(copied, ['version', 'resources', 'scenarios', 'options'], 'Workspace');
  if (document['version'] !== 1) invalid('Workspace version must be 1.');
  const resources = boundedArray(document['resources'], 10_000, 'resources').map((resource) => {
    const item = record(resource, undefined, 'Resource');
    const type = item['resourceType'];
    if (typeof type !== 'string' || !RESOURCE_TYPES.has(type))
      invalid('Resource type must be guild, channel, role, user, member, or message.');
    snowflake(item['id'], 'Resource id');
    return item;
  });
  validateRelations(resources);
  const names = new Set<string>();
  const scenarios = boundedArray(document['scenarios'], 100, 'scenarios').map<WorkspaceScenario>(
    (scenario) => {
      const item = record(scenario, ['name', 'format', 'source'], 'Scenario');
      const name = boundedText(item['name'], 1, 100, 'Scenario name');
      if (names.has(name)) invalid('Scenario names must be unique.');
      names.add(name);
      const format = item['format'];
      if (format !== 'json' && format !== 'yaml') invalid('Scenario format must be json or yaml.');
      const source = boundedText(item['source'], 1, MAX_SCENARIO_BYTES, 'Scenario source');
      return { name, format, source };
    },
  );
  const options = record(document['options'], ['seed', 'mode'], 'Workspace options');
  const seed = options['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    invalid('Workspace seed must be an unsigned 32-bit integer.');
  const mode = options['mode'];
  if (mode !== 'strict' && mode !== 'lenient') invalid('Workspace mode must be strict or lenient.');
  return { version: 1, resources, scenarios, options: { seed, mode } };
}

/** Opening a workspace never migrates, recovers, or executes a Bot. */
export async function openWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const directory = await workspaceDirectory(root, false);
  const filePath = path.join(directory, FILE_NAME);
  const current = await readOptional(filePath);
  const backup = await readOptional(path.join(directory, BACKUP_NAME));
  let backupAvailable = false;
  if (backup !== null) {
    try {
      parseWorkspace(decodeJson(backup));
      backupAvailable = true;
    } catch {
      // A damaged backup is not offered as a recovery candidate.
    }
  }
  return snapshot(filePath, current, backupAvailable);
}

/** expectedHash is mandatory: null creates a workspace, a hash replaces that exact file. */
export async function saveWorkspace(
  root: string,
  document: unknown,
  options: { readonly expectedHash: string | null },
): Promise<WorkspaceSnapshot> {
  validateExpectedHash(options);
  const parsed = parseWorkspace(document);
  const encoded = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_BYTES) invalid('Workspace exceeds the 8 MiB limit.');
  const directory = await workspaceDirectory(root, true);
  return withLock(directory, async () => {
    const filePath = path.join(directory, FILE_NAME);
    const current = await readOptional(filePath);
    assertExpected(current, options.expectedHash);
    assertWritableVersion(filePath, current);
    if (current !== null) {
      await atomicWrite(directory, BACKUP_NAME, current);
    }
    // Detect an external editor changing the file while the backup was being written.
    assertExpected(await readOptional(filePath), options.expectedHash);
    await atomicWrite(directory, FILE_NAME, encoded);
    return snapshot(filePath, encoded, current !== null || (await validBackup(directory)));
  });
}

/** Explicit recovery preserves the replaced bytes in workspace.displaced.json. */
export async function recoverWorkspace(
  root: string,
  options: { readonly expectedHash: string | null },
): Promise<WorkspaceSnapshot> {
  validateExpectedHash(options);
  const directory = await workspaceDirectory(root, false);
  return withLock(directory, async () => {
    const filePath = path.join(directory, FILE_NAME);
    const current = await readOptional(filePath);
    assertExpected(current, options.expectedHash);
    const observed = snapshot(filePath, current, false);
    if (observed.status === 'future')
      throw new WorkspaceError(
        'future-version',
        'A newer workspace cannot be overwritten by recovery.',
      );
    const backup = await readOptional(path.join(directory, BACKUP_NAME));
    if (backup === null) invalid('No workspace backup is available.');
    if (snapshot(path.join(directory, BACKUP_NAME), backup, false).status !== 'ready')
      invalid('The workspace backup is damaged or uses an unsupported version.');
    if (current !== null) await atomicWrite(directory, 'workspace.displaced.json', current);
    assertExpected(await readOptional(filePath), options.expectedHash);
    await atomicWrite(directory, FILE_NAME, backup);
    return snapshot(filePath, backup, true);
  });
}

function validateRelations(resources: readonly Record<string, unknown>[]): void {
  const entries = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    const key = `${String(resource['resourceType'])}:${String(resource['id'])}`;
    if (entries.has(key)) invalid('Duplicate resource type and id.');
    entries.set(key, resource);
  }
  const requireReference = (type: string, id: unknown, label: string): Record<string, unknown> => {
    const canonical = snowflake(id, label);
    const resource = entries.get(`${type}:${canonical}`);
    if (resource === undefined) invalid(`${label} references a missing ${type}.`);
    return resource;
  };
  const members = new Set<string>();
  for (const resource of resources) {
    const type = resource['resourceType'];
    const guildId = resource['guild_id'];
    if (
      type === 'role' ||
      type === 'member' ||
      (type === 'channel' && resource['type'] !== 1 && resource['type'] !== 3)
    )
      requireReference('guild', guildId, `${String(type)} guild_id`);
    if (type === 'channel') {
      if (typeof resource['type'] !== 'number' || !CHANNEL_TYPES.has(resource['type']))
        invalid('Workspace channel type must be a recognized Discord channel type.');
      if ((resource['type'] === 1 || resource['type'] === 3) && guildId !== undefined)
        invalid('A DM channel must not have guild_id.');
      if (
        (resource['type'] === 1 || resource['type'] === 3) &&
        resource['recipients'] !== undefined
      ) {
        for (const recipient of boundedArray(resource['recipients'], 10, 'DM recipients'))
          requireReference(
            'user',
            record(recipient, undefined, 'DM recipient')['id'],
            'DM recipient id',
          );
      }
      const overwrites = resource['permission_overwrites'];
      if (overwrites !== undefined) {
        for (const value of boundedArray(overwrites, 1000, 'permission_overwrites')) {
          const overwrite = record(value, undefined, 'Permission overwrite');
          if (overwrite['type'] !== 0 && overwrite['type'] !== 1)
            invalid('Permission overwrite type must be 0 or 1.');
          const target = requireReference(
            overwrite['type'] === 0 ? 'role' : 'user',
            overwrite['id'],
            'Permission overwrite id',
          );
          if (overwrite['type'] === 0 && target['guild_id'] !== guildId)
            invalid('Permission overwrite role must belong to its channel guild.');
          bitfield(overwrite['allow'] ?? '0');
          bitfield(overwrite['deny'] ?? '0');
        }
      }
    }
    if (type === 'member') {
      const userId = snowflake(resource['user_id'], 'Member user_id');
      requireReference('user', userId, 'Member user_id');
      if (
        resource['user'] !== undefined &&
        record(resource['user'], undefined, 'Member user')['id'] !== userId
      )
        invalid('Member user.id must match user_id.');
      const key = `${String(guildId)}:${userId}`;
      if (members.has(key)) invalid('A user may have only one member per guild.');
      members.add(key);
      const roles = boundedArray(resource['roles'] ?? [], 250, 'Member roles');
      if (new Set(roles).size !== roles.length) invalid('Member role ids must be unique.');
      for (const roleId of roles) {
        const role = requireReference('role', roleId, 'Member role id');
        if (role['guild_id'] !== guildId) invalid('Member roles must belong to its guild.');
      }
    }
    if (type === 'message') {
      const channel = requireReference('channel', resource['channel_id'], 'Message channel_id');
      if (guildId !== undefined && guildId !== channel['guild_id'])
        invalid('Message guild_id must match its channel.');
      const author = resource['author'];
      if (author !== undefined)
        requireReference(
          'user',
          record(author, undefined, 'Message author')['id'],
          'Message author id',
        );
      if (resource['attachments'] !== undefined) {
        for (const value of boundedArray(resource['attachments'], 10, 'Message attachments')) {
          const attachment = record(value, undefined, 'Message attachment');
          if (attachment['path'] !== undefined) relativePath(attachment['path']);
        }
      }
    }
    if (type === 'role' && resource['permissions'] !== undefined) bitfield(resource['permissions']);
  }
}

function copyJson(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32) invalid('Workspace exceeds its structure limit.');
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current);
      if (bytes > MAX_BYTES) invalid('Workspace exceeds the 8 MiB limit.');
      if (CREDENTIAL.test(current)) invalid('Credentials must not be saved in a workspace.');
      return current;
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object' || current === null)
      invalid('Workspace must contain only JSON data.');
    if (seen.has(current)) invalid('Workspace must not contain circular references.');
    seen.add(current);
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        current.length > 100_000 ||
        Reflect.ownKeys(current).length !== current.length + 1
      )
        invalid('Workspace arrays must contain dense JSON elements only.');
      const result: unknown[] = [];
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
          invalid('Workspace arrays must contain JSON data properties only.');
        result.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(current);
      return result;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null)
      invalid('Workspace objects must be plain JSON objects.');
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
        invalid('Workspace contains an unsupported property.');
      bytes += Buffer.byteLength(key);
      if (bytes > MAX_BYTES) invalid('Workspace exceeds the 8 MiB limit.');
      if (SENSITIVE_KEY.test(key)) invalid('Credentials must not be saved in a workspace.');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
        invalid('Workspace objects must contain JSON data properties only.');
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    seen.delete(current);
    return Object.fromEntries(entries);
  };
  return visit(value, 0);
}

function snapshot(
  filePath: string,
  source: string | Buffer | null,
  backupAvailable: boolean,
): WorkspaceSnapshot {
  const base = { path: filePath, hash: source === null ? null : hash(source), backupAvailable };
  if (source === null)
    return { ...base, status: 'missing', document: null, version: null, error: null };
  try {
    const data: unknown = decodeJson(source);
    const version =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['version']
        : undefined;
    if (typeof version === 'number' && Number.isInteger(version) && version > 1)
      return {
        ...base,
        status: 'future',
        document: null,
        version,
        error: 'This workspace was created by a newer version of DisRunner.',
      };
    return { ...base, status: 'ready', document: parseWorkspace(data), version: 1, error: null };
  } catch (error) {
    return {
      ...base,
      status: 'corrupt',
      document: null,
      version: null,
      error: error instanceof WorkspaceError ? error.message : 'Workspace is not valid JSON.',
    };
  }
}

function assertWritableVersion(filePath: string, current: Buffer | null): void {
  const observed = snapshot(filePath, current, false);
  if (observed.status === 'future')
    throw new WorkspaceError('future-version', 'A newer workspace must not be overwritten.');
  if (observed.status === 'corrupt')
    invalid('Recover the damaged workspace before saving changes.');
}

async function validBackup(directory: string): Promise<boolean> {
  const backup = await readOptional(path.join(directory, BACKUP_NAME));
  if (backup === null) return false;
  try {
    parseWorkspace(decodeJson(backup));
    return true;
  } catch {
    return false;
  }
}

async function workspaceDirectory(root: string, create: boolean): Promise<string> {
  if (typeof root !== 'string' || root.trim() === '') invalid('A project directory is required.');
  const canonicalRoot = await realpath(root);
  if (!(await lstat(canonicalRoot)).isDirectory()) invalid('Project root must be a directory.');
  const directory = path.join(canonicalRoot, '.disrunner');
  if (create)
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new WorkspaceError(
        'unsafe-path',
        'Workspace directory must be a real directory within the project.',
      );
  } catch (error) {
    if (!hasCode(error, 'ENOENT') || create) throw error;
  }
  return directory;
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw new WorkspaceError(
      'unsafe-path',
      'Workspace files must be regular files, not links or directories.',
    );
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev)
      throw new WorkspaceError('conflict', 'Workspace file changed while it was being opened.');
    if (opened.size > MAX_BYTES) invalid('Workspace exceeds the 8 MiB limit.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) invalid('Workspace exceeds the 8 MiB limit.');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  directory: string,
  name: string,
  source: string | Buffer,
): Promise<void> {
  const temporary = path.join(directory, `.workspace-${randomUUID()}.tmp`);
  const target = path.join(directory, name);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await readOptional(target);
    if ((await realpath(directory)) !== directory)
      throw new WorkspaceError('unsafe-path', 'Workspace directory changed while saving.');
    await rename(temporary, target);
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
}

async function withLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, LOCK_NAME);
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    throw new WorkspaceError(
      'busy',
      'Workspace is already being saved. Close other instances before retrying. A stale workspace.lock may be removed after confirming its process has stopped.',
    );
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

function validateExpectedHash(options: { readonly expectedHash: string | null }): void {
  if (options === null || typeof options !== 'object')
    invalid(
      'Saving or recovering requires the last opened workspace hash, or null for a missing file.',
    );
  const descriptor = Object.getOwnPropertyDescriptor(options, 'expectedHash');
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor) ||
    (descriptor.value !== null &&
      (typeof descriptor.value !== 'string' || !/^[a-f0-9]{64}$/u.test(descriptor.value)))
  )
    invalid(
      'Saving or recovering requires the last opened workspace hash, or null for a missing file.',
    );
}

function assertExpected(source: string | Buffer | null, expectedHash: string | null): void {
  if ((source === null ? null : hash(source)) !== expectedHash)
    throw new WorkspaceError(
      'conflict',
      'Workspace changed on disk. Reopen it before saving or recovering.',
    );
}

function hash(source: string | Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}
function decodeJson(source: string | Buffer): unknown {
  if (Buffer.isBuffer(source) && !isUtf8(source)) invalid('Workspace must contain valid UTF-8.');
  return JSON.parse(source.toString()) as unknown;
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
function invalid(message: string): never {
  throw new WorkspaceError('invalid', message);
}
function record(
  value: unknown,
  keys: readonly string[] | undefined,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (
    keys !== undefined &&
    (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
  )
    invalid(`${label} has missing or unknown fields.`);
  return result;
}
function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    invalid(`${label} must be an array with at most ${maximum} items.`);
  return value as unknown[];
}
function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value) < minimum ||
    Buffer.byteLength(value) > maximum
  )
    invalid(`${label} is outside its UTF-8 byte bounds.`);
  return value;
}
function snowflake(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  )
    invalid(`${label} must be a positive decimal unsigned 64-bit string.`);
  return value;
}
function bitfield(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  )
    invalid('Permissions must be an unsigned 64-bit decimal string.');
}

function relativePath(value: unknown): void {
  const filePath = boundedText(value, 1, 4096, 'Attachment path').replaceAll('\\', '/');
  if (
    path.posix.isAbsolute(filePath) ||
    /^[A-Za-z]:/u.test(filePath) ||
    filePath.split('/').some((part) => part === '..' || part === '') ||
    [...filePath].some((character) => character.charCodeAt(0) < 32)
  )
    invalid('Attachment paths must remain within the project directory.');
}
