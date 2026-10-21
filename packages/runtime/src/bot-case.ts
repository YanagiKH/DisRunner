import type {
  InvocationContext,
  RuntimeInvocationResult,
  SessionInvocationResult,
} from './contracts.js';

export interface BotCase {
  readonly version: 1;
  readonly execution: 'bot';
  readonly name: string;
  readonly context: InvocationContext;
  readonly steps: readonly {
    readonly requestId: string;
    readonly input: string;
    readonly expect: { readonly responseType: 'message'; readonly content: string };
  }[];
}
export interface BotAssertion {
  readonly requestId: string;
  readonly passed: boolean;
  readonly expected: { readonly responseType: 'message'; readonly content: string };
  readonly actual: RuntimeInvocationResult['response'];
}

/** Validate data descriptors before reading values: getters must never run. */
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be a plain object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object.`);
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new TypeError(`${label} has missing or unknown fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError(`${label}.${key} must be an enumerable data property.`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) < minimum ||
    Buffer.byteLength(value) > maximum
  )
    throw new TypeError(`${label} is outside its UTF-8 byte bounds.`);
  return value;
}
function contextId(value: unknown, label: string): string {
  const id = text(value, 1, 128, label);
  if (id.includes('\0')) throw new TypeError(`${label} must not contain NUL.`);
  return id;
}
function stepsArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 100
  )
    throw new TypeError('steps must be a dense array of 1–100 steps.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    throw new TypeError('steps must not have custom properties.');
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('steps must have only enumerable data elements.');
  }
  return value as unknown[];
}

/** Pure validation: no project loading, child processes, or assertion defaults. */
export function parseBotCase(value: unknown): BotCase {
  const root = record(value, ['version', 'execution', 'name', 'context', 'steps'], 'case');
  if (root['version'] !== 1 || root['execution'] !== 'bot')
    throw new TypeError('case requires version 1 and execution bot.');
  const name = text(root['name'], 1, 100, 'name');
  const sourceContext = record(root['context'], ['actorId', 'guildId', 'channelId'], 'context');
  const context = Object.freeze({
    actorId: contextId(sourceContext['actorId'], 'actorId'),
    guildId: contextId(sourceContext['guildId'], 'guildId'),
    channelId: contextId(sourceContext['channelId'], 'channelId'),
  });
  const seen = new Set<string>();
  const steps = stepsArray(root['steps']).map((value, index) => {
    const step = record(value, ['requestId', 'input', 'expect'], `steps[${index}]`);
    const requestId = text(step['requestId'], 1, 64, 'requestId');
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(requestId) || seen.has(requestId))
      throw new TypeError('requestId must be valid and unique.');
    seen.add(requestId);
    const input = text(step['input'], 1, 2_000, 'input');
    if (!/^\/?[a-z0-9_-]{1,32}(?:\s|$)/u.test(input.trim()))
      throw new TypeError('input must use the supported command grammar.');
    const expect = record(step['expect'], ['responseType', 'content'], 'expect');
    if (expect['responseType'] !== 'message')
      throw new TypeError('expect.responseType must be message.');
    const content = text(expect['content'], 0, 2_000, 'expect.content');
    return Object.freeze({
      requestId,
      input,
      expect: Object.freeze({ responseType: 'message' as const, content }),
    });
  });
  return Object.freeze({
    version: 1,
    execution: 'bot',
    name,
    context,
    steps: Object.freeze(steps),
  });
}

/** Context and active run identity are checked by the CLI before this function. */
export function evaluateBotStep(
  step: BotCase['steps'][number],
  result: SessionInvocationResult,
): BotAssertion {
  if (result.requestId !== step.requestId)
    throw new TypeError('Invocation requestId does not match the step.');
  const actual =
    result.response === null || result.response === undefined
      ? null
      : structuredClone(result.response);
  return {
    requestId: step.requestId,
    passed:
      result.ok === true &&
      result.error === null &&
      actual?.type === 'message' &&
      typeof actual.data['content'] === 'string' &&
      actual.data['content'] === step.expect.content,
    expected: { responseType: 'message', content: step.expect.content },
    actual,
  };
}
