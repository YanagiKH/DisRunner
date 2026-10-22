/**
 * Opt-in identity profile served by the local REST emulator for `GET /users/@me` and
 * `GET /oauth2/applications/@me`. Every value is synthetic test data supplied by the caller.
 */
export interface BootstrapUser {
  readonly id: string;
  readonly username: string;
  readonly discriminator: string;
  readonly avatar: null;
  readonly bot: boolean;
}

export interface BootstrapApplication {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: null;
  readonly bot_public: boolean;
  readonly bot_require_code_grant: boolean;
  readonly owner: BootstrapUser;
  /** Synthetic public test value. It is stored and returned only, never used to sign or verify. */
  readonly verify_key: string;
  readonly flags: number;
  readonly team: null;
}

export interface RestBootstrapProfile {
  readonly user: BootstrapUser;
  readonly application: BootstrapApplication;
}

const PROFILE_KEYS = ['user', 'application'] as const;
const USER_KEYS = ['id', 'username', 'discriminator', 'avatar', 'bot'] as const;
const APPLICATION_KEYS = [
  'id',
  'name',
  'description',
  'icon',
  'bot_public',
  'bot_require_code_grant',
  'owner',
  'verify_key',
  'flags',
  'team',
] as const;

const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n;
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,19}$/;
const DISCRIMINATOR_PATTERN = /^(?:0|[0-9]{4})$/;
const VERIFY_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates an untrusted bootstrap profile and returns a frozen deep copy made only of plain
 * data. Properties are read through their descriptors, so accessors are rejected without being
 * invoked. Throws `TypeError` naming the offending field path; values are never echoed.
 */
export function parseRestBootstrapProfile(value: unknown): RestBootstrapProfile {
  const profile = readRecord(value, 'bootstrap', PROFILE_KEYS);
  return Object.freeze({
    user: parseUser(profile.user, 'bootstrap.user', true),
    application: parseApplication(profile.application, 'bootstrap.application'),
  });
}

function parseUser(value: unknown, path: string, bot: boolean): BootstrapUser {
  const user = readRecord(value, path, USER_KEYS);
  const role = requireBoolean(user.bot, `${path}.bot`);
  if (role !== bot) {
    throw new TypeError(`${path}.bot must be ${String(bot)} for this profile role.`);
  }
  return Object.freeze({
    id: requireSnowflake(user.id, `${path}.id`),
    username: requireText(user.username, `${path}.username`, 1, 100),
    discriminator: requireDiscriminator(user.discriminator, `${path}.discriminator`),
    avatar: requireNull(user.avatar, `${path}.avatar`),
    bot: role,
  });
}

function parseApplication(value: unknown, path: string): BootstrapApplication {
  const application = readRecord(value, path, APPLICATION_KEYS);
  return Object.freeze({
    id: requireSnowflake(application.id, `${path}.id`),
    name: requireText(application.name, `${path}.name`, 1, 100),
    description: requireText(application.description, `${path}.description`, 0, 1024),
    icon: requireNull(application.icon, `${path}.icon`),
    bot_public: requireBoolean(application.bot_public, `${path}.bot_public`),
    bot_require_code_grant: requireBoolean(
      application.bot_require_code_grant,
      `${path}.bot_require_code_grant`,
    ),
    owner: parseUser(application.owner, `${path}.owner`, false),
    verify_key: requireVerifyKey(application.verify_key, `${path}.verify_key`),
    flags: requireFlags(application.flags, `${path}.flags`),
    team: requireNull(application.team, `${path}.team`),
  });
}

/**
 * Reads exactly the expected own, enumerable data properties of a plain object (prototype
 * `Object.prototype` or `null`). Symbol keys, unknown or non-enumerable keys, accessors and
 * inherited fields are rejected. Getters are never invoked because values come from descriptors.
 */
function readRecord<const K extends string>(
  value: unknown,
  path: string,
  keys: readonly K[],
): Record<K, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object, not a class instance.`);
  }
  const allowed = new Set<string>(keys);
  const result = Object.create(null) as Record<K, unknown>;
  const seen = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      throw new TypeError(`${path} must not have symbol keys.`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${path}.${key} is not a supported field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${path}.${key} must be a data property, not an accessor.`);
    }
    if (descriptor.enumerable !== true) {
      throw new TypeError(`${path}.${key} must be an enumerable data property.`);
    }
    result[key as K] = descriptor.value as unknown;
    seen.add(key);
  }
  for (const key of keys) {
    if (!seen.has(key)) throw new TypeError(`${path}.${key} is required.`);
  }
  return result;
}

function requireSnowflake(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !SNOWFLAKE_PATTERN.test(value) ||
    BigInt(value) > MAX_SNOWFLAKE
  ) {
    throw new TypeError(`${path} must be a canonical positive decimal unsigned 64-bit ID string.`);
  }
  return value;
}

function requireText(value: unknown, path: string, minBytes: number, maxBytes: number): string {
  if (typeof value !== 'string' || !isWellFormedUtf16(value)) {
    throw new TypeError(`${path} must be a well-formed string.`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > maxBytes) {
    throw new TypeError(`${path} must be ${minBytes}-${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function requireDiscriminator(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DISCRIMINATOR_PATTERN.test(value)) {
    throw new TypeError(`${path} must be "0" or exactly four ASCII digits.`);
  }
  return value;
}

function requireVerifyKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !VERIFY_KEY_PATTERN.test(value)) {
    throw new TypeError(`${path} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function requireFlags(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  // Normalize -0 so the stored value is the canonical integer zero.
  return value === 0 ? 0 : value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean.`);
  return value;
}

function requireNull(value: unknown, path: string): null {
  if (value !== null) throw new TypeError(`${path} must be null.`);
  return null;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
