import { types } from 'node:util';
import { DiscordApiError } from './interactions.js';
export interface CommandRegistryProfile {
  readonly profile: 'command-registry-v1';
  readonly guildIds: readonly string[];
}
export const COMMAND_UINT64_MAX = 18446744073709551615n;
export function commandError(
  kind: 'payload' | 'feature' | 'state' | 'capacity' | 'mutation' | 'route',
): DiscordApiError {
  const messages = {
    payload: 'Invalid application command payload.',
    feature: 'Unsupported application command feature in command-registry-v1.',
    state: 'Command registry state is invalid.',
    capacity: 'Command registry capacity exceeded.',
    mutation: 'Command registry mutation is not allowed in this state context.',
    route: 'Invalid application command route.',
  };
  return new DiscordApiError(
    kind === 'state' || kind === 'capacity' ? 503 : kind === 'mutation' ? 409 : 400,
    kind === 'state' || kind === 'capacity' || kind === 'mutation' ? 0 : 50035,
    messages[kind],
  );
}
export function canonicalCommandId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= COMMAND_UINT64_MAX
  );
}
/** Copy only descriptor-inspected JSON data; never execute caller object code. */
export function inspectCommandData(value: unknown): unknown {
  return inspectCommandValue(value, new Set<object>(), 0, { nodes: 0, bytes: 0 });
}
function inspectCommandValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
  budget: { nodes: number; bytes: number },
): unknown {
  if (++budget.nodes > 8192) throw commandError('payload');
  if (depth > 16) throw commandError('payload');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 65536) throw commandError('payload');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw commandError('payload');
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value)) throw commandError('payload');
  if (seen.has(value)) throw commandError('payload');
  const array = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && (typeof proto !== 'object' || types.isProxy(proto)))
    throw commandError('payload');
  if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null)
    throw commandError('payload');
  // Inspect prototype chain before any reflection on its members.
  let parent = proto;
  while (parent !== null) {
    if (typeof parent !== 'object' || types.isProxy(parent)) throw commandError('payload');
    const next: unknown = Object.getPrototypeOf(parent);
    if (next !== null && (typeof next !== 'object' || types.isProxy(next)))
      throw commandError('payload');
    if (Reflect.ownKeys(parent).some((k) => Object.getOwnPropertyDescriptor(parent, k)?.enumerable))
      throw commandError('payload');
    parent = next;
  }
  seen.add(value);
  const out: Record<string, unknown> | unknown[] = array
    ? []
    : (Object.create(null) as Record<string, unknown>);
  const keys = Reflect.ownKeys(value);
  let length = 0;
  if (array) {
    const d = Object.getOwnPropertyDescriptor(value, 'length');
    if (!d || !('value' in d) || typeof d.value !== 'number' || d.value > 1024)
      throw commandError('payload');
    length = d.value;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
      throw commandError('payload');
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) throw commandError('payload');
    if (key === 'choices') throw commandError('feature');
    if (key === 'options' && typeof d.value === 'object' && d.value !== null) {
      if (types.isProxy(d.value)) throw commandError('payload');
      if (Array.isArray(d.value)) {
        const size = Object.getOwnPropertyDescriptor(d.value, 'length');
        if (!size || !('value' in size)) throw commandError('payload');
        // Options are outside this profile: do not traverse an unsupported recursive tree.
        if (size.value !== 0) throw commandError('feature');
      }
    }
    if (array && key === 'length') continue;
    if (!d.enumerable || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))
      throw commandError('payload');
    (out as Record<string, unknown>)[key] = inspectCommandValue(d.value, seen, depth + 1, budget);
  }
  if (array && keys.length !== length + 1) throw commandError('payload');
  // Repeated object references are not a JSON tree; reject them before recursive expansion.
  return out;
}
export function commandRecord(value: unknown): Record<string, unknown> {
  const copy = inspectCommandData(value);
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy))
    throw commandError('payload');
  return copy as Record<string, unknown>;
}
export function parseCommandRegistryProfile(value: unknown): CommandRegistryProfile {
  const data = commandRecord(value);
  if (
    Object.keys(data).length !== 2 ||
    data['profile'] !== 'command-registry-v1' ||
    !Array.isArray(data['guildIds']) ||
    data['guildIds'].length > 128 ||
    !data['guildIds'].every(canonicalCommandId) ||
    new Set(data['guildIds']).size !== data['guildIds'].length
  )
    throw commandError('payload');
  return Object.freeze({
    profile: 'command-registry-v1',
    guildIds: Object.freeze([...data['guildIds']]),
  });
}
export interface CommandFields {
  readonly type: number;
  readonly name: string;
  readonly description: string;
}
const common = new Set([
  'name',
  'type',
  'description',
  'options',
  'default_member_permissions',
  'nsfw',
  'name_localizations',
  'description_localizations',
  'default_permission',
]);
const global = new Set(['integration_types', 'contexts', 'dm_permission']);
export function parseCommandFields(
  input: unknown,
  guild: boolean,
  current?: CommandFields,
  allowId = false,
): CommandFields & { id?: string } {
  const data = commandRecord(input);
  const previous = current === undefined ? undefined : commandRecord(current);
  for (const key of Object.keys(data)) {
    if (key === 'id' && allowId) {
      if (!canonicalCommandId(data[key])) throw commandError('payload');
      continue;
    }
    if (key === 'type' && previous) throw commandError('feature');
    if (!common.has(key) && !(global.has(key) && !guild)) throw commandError('feature');
  }
  const type = previous?.['type'] ?? ('type' in data ? data['type'] : 1);
  if (typeof type !== 'number' || !Number.isInteger(type)) throw commandError('payload');
  if (![1, 2, 3].includes(type)) throw commandError('feature');
  const name = data['name'] === undefined ? previous?.['name'] : data['name'];
  if (
    typeof name !== 'string' ||
    [...name].length < 1 ||
    [...name].length > 32 ||
    !name.trim() ||
    /\p{Cc}/u.test(name)
  )
    throw commandError('payload');
  if (
    type === 1 &&
    (!/^[-_\p{L}\p{N}\p{sc=Devanagari}\p{sc=Thai}]+$/u.test(name) || name.toLowerCase() !== name)
  )
    throw commandError('payload');
  const description =
    data['description'] === undefined
      ? (previous?.['description'] ?? (type === 1 ? undefined : ''))
      : data['description'];
  if (
    typeof description !== 'string' ||
    (type === 1 ? [...description].length < 1 || [...description].length > 100 : description !== '')
  )
    throw commandError('payload');
  if ('options' in data) {
    if (type !== 1) throw commandError('feature');
    if (!Array.isArray(data['options'])) throw commandError('payload');
    if (data['options'].length) throw commandError('feature');
  }
  for (const key of [
    'default_member_permissions',
    'name_localizations',
    'description_localizations',
  ]) {
    if (!(key in data) || data[key] === null) continue;
    if (
      key === 'default_member_permissions'
        ? typeof data[key] === 'string'
        : typeof data[key] === 'object'
    )
      throw commandError('feature');
    throw commandError('payload');
  }
  for (const [key, neutral] of [
    ['nsfw', false],
    ['default_permission', true],
    ['dm_permission', false],
  ] as const) {
    if (!(key in data)) continue;
    if (key === 'default_permission' && data[key] === null) throw commandError('feature');
    if (typeof data[key] !== 'boolean') throw commandError('payload');
    if (data[key] !== neutral) throw commandError('feature');
  }
  for (const key of ['integration_types', 'contexts']) {
    if (!(key in data)) continue;
    if (data[key] === null) throw commandError('feature');
    if (!Array.isArray(data[key])) throw commandError('payload');
    if (data[key].length !== 1 || data[key][0] !== 0) throw commandError('feature');
  }
  return {
    type,
    name,
    description,
    ...(allowId && 'id' in data ? { id: data['id'] as string } : {}),
  };
}
