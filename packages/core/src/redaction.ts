export interface RedactionOptions {
  readonly replacement?: string;
  readonly redactPii?: boolean;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  /** Maximum values visited across the complete object graph. */
  readonly maxNodes?: number;
  /** Maximum enumerable entries copied from any one object or array. */
  readonly maxEntriesPerContainer?: number;
  /** UTF-8 byte budget shared by source-derived output property names and string values. */
  readonly maxTotalStringBytes?: number;
  /** Exact runtime-only values (for example generated session tokens) to remove. */
  readonly sensitiveValues?: readonly string[];
}

interface NormalizedRedactionOptions {
  readonly replacement: string;
  readonly redactPii: boolean;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxNodes: number;
  readonly maxEntriesPerContainer: number;
  readonly maxTotalStringBytes: number;
  readonly sensitiveValues: readonly string[];
}

interface RedactionState {
  nodes: number;
  remainingStringBytes: number;
  halted: boolean;
}

const SENSITIVE_KEY =
  /authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|cookie/i;
const AUTHORIZATION = /\b(Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const DISCORD_WEBHOOK =
  /https?:\/\/(?:canary\.|ptb\.)?(?:discord(?:app)?\.com)\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi;
const ENV_SECRET = /\b(DISCORD_TOKEN|BOT_TOKEN|API_KEY|CLIENT_SECRET)\s*=\s*[^\s;]+/gi;
const DISCORD_TOKEN_VALUE =
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/g;
const DISRUNNER_TOKEN_VALUE = /\bdisrunner\.offline\.[A-Za-z0-9_-]{16,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const REDACTION_TRUNCATED = '[REDACTION_TRUNCATED]';
const REDACTION_STRING_TRUNCATED = '[REDACTION_STRING_TRUNCATED]';
const REDACTION_MAX_DEPTH = '[REDACTION_MAX_DEPTH]';
const REDACTION_MAX_ENTRIES = '[REDACTION_MAX_ENTRIES]';
const REDACTION_CIRCULAR = '[REDACTION_CIRCULAR]';
const REDACTION_ACCESSOR = '[REDACTION_ACCESSOR]';
const REDACTION_UNSUPPORTED = '[REDACTION_UNSUPPORTED]';
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_ENTRIES_PER_CONTAINER = 10_000;
const DEFAULT_MAX_TOTAL_STRING_BYTES = 16 * 1_024 * 1_024;
const MAX_REDACTION_NODES = 1_000_000;
const MAX_REDACTION_ENTRIES_PER_CONTAINER = 100_000;
const MAX_REDACTION_TOTAL_STRING_BYTES = 64 * 1_024 * 1_024;
const MAX_SENSITIVE_VALUES = 256;
const MAX_SENSITIVE_VALUE_LENGTH = 4_096;
const MAX_REPLACEMENT_LENGTH = 1_024;
const MAX_RETAINED_BIGINT_MAGNITUDE = 1n << 256n;

export function redact<T>(value: T, options: RedactionOptions = {}): T {
  const normalized = normalizeOptions(options);
  const markerBytes = Buffer.byteLength(REDACTION_TRUNCATED);
  const state: RedactionState = {
    nodes: 0,
    remainingStringBytes: normalized.maxTotalStringBytes - markerBytes,
    halted: false,
  };
  const active = new WeakSet<object>();

  const visit = (current: unknown, key: string | undefined, depth: number): unknown => {
    if (state.halted) return REDACTION_TRUNCATED;
    if (state.nodes >= normalized.maxNodes) return haltRedaction(state);
    state.nodes += 1;
    if (key !== undefined && isSensitiveKey(key, normalized.maxStringLength)) {
      return retainString(normalized.replacement, state);
    }
    if (typeof current === 'string') {
      return retainString(redactStringCore(current, normalized), state);
    }
    if (depth > normalized.maxDepth) {
      return retainString(REDACTION_MAX_DEPTH, state);
    }
    if (typeof current === 'function' || typeof current === 'symbol') {
      return retainString(REDACTION_UNSUPPORTED, state);
    }
    if (
      typeof current === 'bigint' &&
      (current > MAX_RETAINED_BIGINT_MAGNITUDE || current < -MAX_RETAINED_BIGINT_MAGNITUDE)
    ) {
      return retainString(REDACTION_UNSUPPORTED, state);
    }
    if (Array.isArray(current)) {
      if (active.has(current)) {
        return retainString(REDACTION_CIRCULAR, state);
      }
      active.add(current);
      const output: unknown[] = [];
      const entryLimit = Math.min(current.length, normalized.maxEntriesPerContainer);
      for (let index = 0; index < entryLimit && !state.halted; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor !== undefined && !('value' in descriptor)) {
          output.push(retainString(REDACTION_ACCESSOR, state));
        } else {
          output.push(visit(descriptor?.value, undefined, depth + 1));
        }
      }
      let capacityMarkerAdded = false;
      if (current.length > entryLimit && !state.halted) {
        output.push(retainString(REDACTION_MAX_ENTRIES, state));
        capacityMarkerAdded = true;
      }
      let enumeratedProperties = 0;
      const enumerableProperties = current as unknown as Record<string, unknown>;
      for (const propertyKey in enumerableProperties) {
        if (enumeratedProperties >= normalized.maxEntriesPerContainer) {
          if (!state.halted && !capacityMarkerAdded) {
            output.push(retainString(REDACTION_MAX_ENTRIES, state));
          }
          break;
        }
        enumeratedProperties += 1;
        const descriptor = Object.getOwnPropertyDescriptor(current, propertyKey);
        if (descriptor === undefined || !descriptor.enumerable) continue;
        if (isArrayIndexKey(propertyKey)) continue;
        if (!state.halted) output.push(retainString(REDACTION_UNSUPPORTED, state));
        break;
      }
      active.delete(current);
      return output;
    }
    if (typeof current === 'object' && current !== null) {
      if (active.has(current)) {
        return retainString(REDACTION_CIRCULAR, state);
      }
      active.add(current);
      const output: Record<string, unknown> = {};
      const keyCounts = new Map<string, number>();
      let entries = 0;
      let enumeratedEntries = 0;
      let entriesTruncated = false;
      for (const entryKey in current) {
        if (enumeratedEntries >= normalized.maxEntriesPerContainer) {
          entriesTruncated = true;
          break;
        }
        enumeratedEntries += 1;
        const descriptor = Object.getOwnPropertyDescriptor(current, entryKey);
        if (descriptor === undefined || !descriptor.enumerable) continue;
        if (entries >= normalized.maxEntriesPerContainer) {
          entriesTruncated = true;
          break;
        }
        if (state.halted) break;
        const preferredKey = retainString(redactStringCore(entryKey, normalized), state);
        const sanitizedKey = nextUniqueKey(output, keyCounts, preferredKey);
        const sanitizedValue = state.halted
          ? null
          : 'value' in descriptor
            ? visit(descriptor.value, entryKey, depth + 1)
            : retainString(REDACTION_ACCESSOR, state);
        Object.defineProperty(output, sanitizedKey, {
          configurable: true,
          enumerable: true,
          value: sanitizedValue,
          writable: true,
        });
        entries += 1;
      }
      if (entriesTruncated && !state.halted) {
        const markerKey = nextUniqueKey(
          output,
          keyCounts,
          retainString(REDACTION_MAX_ENTRIES, state),
        );
        Object.defineProperty(output, markerKey, {
          configurable: true,
          enumerable: true,
          value: true,
          writable: true,
        });
      }
      active.delete(current);
      return output;
    }
    return current;
  };

  return visit(value, undefined, 0) as T;
}

export function redactString(value: string, options: RedactionOptions = {}): string {
  const normalized = normalizeOptions(options);
  const state: RedactionState = {
    nodes: 1,
    remainingStringBytes: normalized.maxTotalStringBytes - Buffer.byteLength(REDACTION_TRUNCATED),
    halted: false,
  };
  return retainString(redactStringCore(value, normalized), state);
}

function redactStringCore(value: string, options: NormalizedRedactionOptions): string {
  const replacement = options.replacement;
  const clipped =
    value.length > options.maxStringLength
      ? `${value.slice(0, options.maxStringLength)}${REDACTION_STRING_TRUNCATED}`
      : value;
  let result = clipped;
  for (const sensitiveValue of options.sensitiveValues) {
    if (sensitiveValue.length >= 4) result = result.split(sensitiveValue).join(replacement);
  }
  result = result
    .replace(DISCORD_WEBHOOK, replacement)
    .replace(AUTHORIZATION, (_match, scheme: string) => `${scheme} ${replacement}`)
    .replace(ENV_SECRET, (_match, name: string) => `${name}=${replacement}`)
    .replace(DISRUNNER_TOKEN_VALUE, replacement)
    .replace(DISCORD_TOKEN_VALUE, replacement);
  if (options.redactPii) {
    result = result
      .replace(EMAIL, '[REDACTED_EMAIL]')
      .replace(IPV4, (address) => (isLoopbackAddress(address) ? address : '[REDACTED_IP]'));
  }
  return result;
}

export function containsLikelySecret(value: unknown): boolean {
  const marker = '__DISRUNNER_REDACTED__';
  const redacted = redact(value, { replacement: marker, redactPii: false });
  const serialized = JSON.stringify(redacted, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
  return (serialized ?? '').includes(marker) || (serialized ?? '').includes('[REDACTION_');
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith('127.');
}

function nextUniqueKey(
  output: Readonly<Record<string, unknown>>,
  counts: Map<string, number>,
  preferred: string,
): string {
  if (!Object.hasOwn(output, preferred)) {
    counts.set(preferred, 1);
    return preferred;
  }
  let suffix = (counts.get(preferred) ?? 1) + 1;
  while (Object.hasOwn(output, `${preferred}#${suffix}`)) suffix += 1;
  counts.set(preferred, suffix);
  return `${preferred}#${suffix}`;
}

function normalizeOptions(options: RedactionOptions): NormalizedRedactionOptions {
  const replacement = options.replacement ?? '[REDACTED]';
  if (replacement.length > MAX_REPLACEMENT_LENGTH) {
    throw new RangeError(`replacement cannot exceed ${MAX_REPLACEMENT_LENGTH} characters.`);
  }
  const sensitiveValues = options.sensitiveValues ?? [];
  if (sensitiveValues.length > MAX_SENSITIVE_VALUES) {
    throw new RangeError(
      `sensitiveValues cannot contain more than ${MAX_SENSITIVE_VALUES} values.`,
    );
  }
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > MAX_SENSITIVE_VALUE_LENGTH) {
      throw new RangeError(
        `A sensitive value cannot exceed ${MAX_SENSITIVE_VALUE_LENGTH} characters.`,
      );
    }
  }
  return {
    replacement,
    redactPii: options.redactPii !== false,
    maxDepth: boundedInteger(options.maxDepth ?? 32, 'maxDepth', 0, 64),
    maxStringLength: boundedInteger(
      options.maxStringLength ?? 100_000,
      'maxStringLength',
      0,
      1_000_000,
    ),
    maxNodes: boundedInteger(
      options.maxNodes ?? DEFAULT_MAX_NODES,
      'maxNodes',
      1,
      MAX_REDACTION_NODES,
    ),
    maxEntriesPerContainer: boundedInteger(
      options.maxEntriesPerContainer ?? DEFAULT_MAX_ENTRIES_PER_CONTAINER,
      'maxEntriesPerContainer',
      1,
      MAX_REDACTION_ENTRIES_PER_CONTAINER,
    ),
    maxTotalStringBytes: boundedInteger(
      options.maxTotalStringBytes ?? DEFAULT_MAX_TOTAL_STRING_BYTES,
      'maxTotalStringBytes',
      Buffer.byteLength(REDACTION_TRUNCATED),
      MAX_REDACTION_TOTAL_STRING_BYTES,
    ),
    sensitiveValues: [...sensitiveValues],
  };
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function retainString(value: string, state: RedactionState): string {
  const sizeBytes = Buffer.byteLength(value);
  if (sizeBytes <= state.remainingStringBytes) {
    state.remainingStringBytes -= sizeBytes;
    return value;
  }
  const prefix = truncateUtf8(value, state.remainingStringBytes);
  state.remainingStringBytes = 0;
  state.halted = true;
  return `${prefix}${REDACTION_TRUNCATED}`;
}

function haltRedaction(state: RedactionState): string {
  state.remainingStringBytes = 0;
  state.halted = true;
  return REDACTION_TRUNCATED;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const boundedPrefix = value.slice(0, Math.min(value.length, maxBytes));
  const buffer = Buffer.from(boundedPrefix);
  if (buffer.byteLength <= maxBytes) return boundedPrefix;
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function isSensitiveKey(key: string, maxStringLength: number): boolean {
  if (key.length > maxStringLength) return true;
  return SENSITIVE_KEY.test(key);
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
}
