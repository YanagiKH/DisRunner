import { types } from 'node:util';
import { DiscordApiError } from './interactions.js';
export interface CommandRegistryProfile {
  readonly profile: 'command-registry-v1' | 'command-registry-v2';
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
export function inspectCommandData(value: unknown, extended = false): unknown {
  return inspectCommandValue(value, new Set<object>(), 0, { nodes: 0, bytes: 0 }, extended);
}
function inspectCommandValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
  budget: { nodes: number; bytes: number },
  extended: boolean,
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
    if (!extended && key === 'choices') throw commandError('feature');
    if (!extended && key === 'options' && typeof d.value === 'object' && d.value !== null) {
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
    (out as Record<string, unknown>)[key] = inspectCommandValue(
      d.value,
      seen,
      depth + 1,
      budget,
      extended,
    );
  }
  if (array && keys.length !== length + 1) throw commandError('payload');
  // Repeated object references are not a JSON tree; reject them before recursive expansion.
  return out;
}
export function commandRecord(value: unknown, extended = false): Record<string, unknown> {
  const copy = inspectCommandData(value, extended);
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy))
    throw commandError('payload');
  return copy as Record<string, unknown>;
}
export function parseCommandRegistryProfile(value: unknown): CommandRegistryProfile {
  const data = commandRecord(value);
  if (
    Object.keys(data).length !== 2 ||
    (data['profile'] !== 'command-registry-v1' && data['profile'] !== 'command-registry-v2') ||
    !Array.isArray(data['guildIds']) ||
    data['guildIds'].length > 128 ||
    !data['guildIds'].every(canonicalCommandId) ||
    new Set(data['guildIds']).size !== data['guildIds'].length
  )
    throw commandError('payload');
  return Object.freeze({
    profile: data['profile'],
    guildIds: Object.freeze([...data['guildIds']]),
  });
}
export interface CommandFields {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly options?: readonly Readonly<Record<string, unknown>>[];
  readonly default_member_permissions?: string | null;
  readonly nsfw?: boolean;
  readonly name_localizations?: Readonly<Record<string, string>> | null;
  readonly description_localizations?: Readonly<Record<string, string>> | null;
  readonly dm_permission?: boolean;
  readonly contexts?: readonly number[];
  readonly integration_types?: readonly number[];
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
  profile: CommandRegistryProfile['profile'] = 'command-registry-v1',
): CommandFields & { id?: string } {
  if (profile === 'command-registry-v2')
    return parseExtendedCommand(input, guild, current, allowId);
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

function parseExtendedCommand(
  input: unknown,
  guild: boolean,
  current: CommandFields | undefined,
  allowId: boolean,
): CommandFields & { id?: string } {
  const data = commandRecord(input, true);
  const previous = current === undefined ? {} : commandRecord(current, true);
  for (const key of Object.keys(data)) {
    if (key === 'id' && allowId) {
      if (!canonicalCommandId(data[key])) throw commandError('payload');
      continue;
    }
    if (!common.has(key) && !global.has(key)) throw commandError('feature');
    if (key === 'type' && current !== undefined && data[key] !== previous['type'])
      throw commandError('feature');
  }
  const merged = { ...previous, ...data };
  const type = merged['type'] === undefined ? 1 : merged['type'];
  if (typeof type !== 'number' || ![1, 2, 3].includes(type)) throw commandError('feature');
  const name = commandName(merged['name'], type === 1);
  const description =
    merged['description'] === undefined ? (type === 1 ? undefined : '') : merged['description'];
  boundedText(description, type === 1 ? 1 : 0, type === 1 ? 100 : 0);
  const options = parseOptions(merged['options'] === undefined ? [] : merged['options'], 0);
  if (type !== 1 && options.length > 0) throw commandError('payload');
  const permissions = merged['default_member_permissions'] ?? null;
  if (
    permissions !== null &&
    (typeof permissions !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(permissions) ||
      BigInt(permissions) > COMMAND_UINT64_MAX)
  )
    throw commandError('payload');
  const nsfw = merged['nsfw'] === undefined ? false : merged['nsfw'];
  if (typeof nsfw !== 'boolean') throw commandError('payload');
  if ('default_permission' in data && data['default_permission'] !== true)
    throw commandError('feature');
  const localizedName = localizations(merged['name_localizations'], 1, 32, type === 1);
  const localizedDescription = localizations(
    merged['description_localizations'],
    type === 1 ? 1 : 0,
    type === 1 ? 100 : 0,
  );
  // Pinned SDKs serialize these global-only fields for guild sync as well.
  // Accept their neutral values, without giving them a meaning in guild scope.
  const dmPermission = optionalBoolean(merged['dm_permission'], true);
  const integrationTypes = numericSet(merged['integration_types'], [0], [0]);
  const contexts = numericSet(merged['contexts'], [0, 1], [0, 1]);
  const fields: CommandFields = {
    type,
    name,
    description: description,
    ...(type === 1 ? { options } : {}),
    default_member_permissions: permissions,
    nsfw,
    name_localizations: localizedName,
    description_localizations: localizedDescription,
    ...(guild
      ? {}
      : {
          dm_permission: dmPermission,
          integration_types: integrationTypes,
          contexts,
        }),
  };
  return { ...fields, ...(allowId && 'id' in data ? { id: data['id'] as string } : {}) };
}

function commandName(value: unknown, slash: boolean): string {
  boundedText(value, 1, 32);
  const name = value;
  if (!name.trim() || /\p{Cc}/u.test(name)) throw commandError('payload');
  if (
    slash &&
    (!/^[-_\p{L}\p{N}\p{sc=Devanagari}\p{sc=Thai}]+$/u.test(name) || name.toLowerCase() !== name)
  )
    throw commandError('payload');
  return name;
}

function boundedText(value: unknown, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== 'string' || [...value].length < minimum || [...value].length > maximum)
    throw commandError('payload');
}

function localizations(
  value: unknown,
  minimum: number,
  maximum: number,
  slash = false,
): Readonly<Record<string, string>> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw commandError('payload');
  const result: Record<string, string> = {};
  for (const [locale, text] of Object.entries(value)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(locale)) throw commandError('payload');
    boundedText(text, minimum, maximum);
    if (slash) commandName(text, true);
    result[locale] = text;
  }
  return result;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw commandError('payload');
  return value;
}

function numericSet(
  value: unknown,
  fallback: readonly number[],
  allowed: readonly number[],
): number[] {
  if (value === undefined || value === null) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    !value.every((item) => typeof item === 'number' && allowed.includes(item))
  )
    throw commandError('feature');
  return (value as number[]).slice();
}

const optionKeys = new Set([
  'type',
  'name',
  'description',
  'name_localizations',
  'description_localizations',
  'required',
  'choices',
  'options',
  'channel_types',
  'min_value',
  'max_value',
  'min_length',
  'max_length',
  'autocomplete',
]);

function parseOptions(value: unknown, parent: number): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 25) throw commandError('payload');
  const result: Readonly<Record<string, unknown>>[] = [];
  let optionalSeen = false;
  let structural: boolean | undefined;
  const names = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw commandError('payload');
    const data = item as Record<string, unknown>;
    if (Object.keys(data).some((key) => !optionKeys.has(key))) throw commandError('feature');
    const type = data['type'];
    if (typeof type !== 'number' || !Number.isInteger(type) || type < 1 || type > 11)
      throw commandError('feature');
    if ((parent === 2 && type !== 1) || (parent === 1 && type <= 2)) throw commandError('payload');
    if (parent === 0) {
      if (structural !== undefined && structural !== type <= 2) throw commandError('payload');
      structural = type <= 2;
    }
    const name = commandName(data['name'], true);
    if (names.has(name)) throw commandError('payload');
    names.add(name);
    boundedText(data['description'], 1, 100);
    const option: Record<string, unknown> = { type, name, description: data['description'] };
    for (const field of ['name_localizations', 'description_localizations']) {
      if (field in data)
        option[field] = localizations(
          data[field],
          1,
          field === 'name_localizations' ? 32 : 100,
          field === 'name_localizations',
        );
    }
    if (type <= 2) {
      if (
        Object.keys(data).some(
          (field) =>
            ![
              'type',
              'name',
              'description',
              'name_localizations',
              'description_localizations',
              'options',
            ].includes(field),
        )
      )
        throw commandError('payload');
      const nested = parseOptions(data['options'] === undefined ? [] : data['options'], type);
      if (type === 2 && nested.length === 0) throw commandError('payload');
      if ('options' in data) option['options'] = nested;
      result.push(option);
      continue;
    }
    const required = optionalBoolean(data['required'], false);
    if (optionalSeen && required) throw commandError('payload');
    if (!required) optionalSeen = true;
    if ('required' in data) option['required'] = required;
    const autocomplete = optionalBoolean(data['autocomplete'], false);
    if (autocomplete && ![3, 4, 10].includes(type)) throw commandError('payload');
    if ('autocomplete' in data) option['autocomplete'] = autocomplete;
    if ('options' in data) throw commandError('payload');
    if ('choices' in data) {
      if (![3, 4, 10].includes(type) || autocomplete) throw commandError('payload');
      option['choices'] = parseChoices(data['choices'], type);
    }
    if ('channel_types' in data) {
      if (type !== 7) throw commandError('payload');
      option['channel_types'] = numericSet(
        data['channel_types'],
        [],
        [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 16],
      );
    }
    for (const [minimum, maximum, allowedTypes] of [
      ['min_value', 'max_value', [4, 10]],
      ['min_length', 'max_length', [3]],
    ] as const) {
      for (const field of [minimum, maximum]) {
        if (!(field in data)) continue;
        if (!(allowedTypes as readonly number[]).includes(type)) throw commandError('payload');
        const bound = data[field];
        if (
          typeof bound !== 'number' ||
          !Number.isFinite(bound) ||
          Math.abs(bound) > Number.MAX_SAFE_INTEGER ||
          ((type === 4 || type === 3) && !Number.isInteger(bound)) ||
          (type === 3 && (bound < 0 || bound > 6000))
        )
          throw commandError('payload');
        option[field] = bound;
      }
      if (
        minimum in data &&
        maximum in data &&
        (data[minimum] as number) > (data[maximum] as number)
      )
        throw commandError('payload');
    }
    result.push(option);
  }
  return result;
}

function parseChoices(value: unknown, type: number): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 25) throw commandError('payload');
  return value.map((choice: unknown) => {
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice))
      throw commandError('payload');
    const data = choice as Record<string, unknown>;
    if (Object.keys(data).some((key) => !['name', 'value', 'name_localizations'].includes(key)))
      throw commandError('feature');
    boundedText(data['name'], 1, 100);
    const entry = data['value'];
    if (type === 3) boundedText(entry, 1, 100);
    else if (
      typeof entry !== 'number' ||
      !Number.isFinite(entry) ||
      Math.abs(entry) > Number.MAX_SAFE_INTEGER ||
      (type === 4 && !Number.isInteger(entry))
    )
      throw commandError('payload');
    return {
      name: data['name'],
      value: entry,
      ...('name_localizations' in data
        ? { name_localizations: localizations(data['name_localizations'], 1, 100) }
        : {}),
    };
  });
}
