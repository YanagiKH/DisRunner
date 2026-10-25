import { setTimeout as delay } from 'node:timers/promises';

export const MAX_FAULT_PLANS = 100;
export const MAX_FAULT_COUNT = 100;
export const MAX_FAULT_DELAY_MS = 30_000;
export const MAX_FAULT_EVENTS = 1_000;

export type FaultKind = 'delay' | 'timeout' | 'http-status' | 'disconnect' | 'duplicate';
export type FaultHttpStatus = 429 | 500 | 502 | 503;

export interface FaultPlan {
  readonly id: string;
  readonly kind: FaultKind;
  readonly count: number;
  readonly method?: string;
  readonly route?: string;
  readonly event?: string;
  readonly delayMs?: number;
  readonly status?: FaultHttpStatus;
}

interface Activation {
  readonly id: string;
  readonly activation: number;
}

export type HttpFaultEffect = Activation &
  (
    | { readonly kind: 'delay' | 'timeout'; readonly delayMs: number }
    | {
        readonly kind: 'http-status';
        readonly status: FaultHttpStatus;
        readonly retryAfterMs: number;
      }
  );

export type GatewayFaultEffect = Activation &
  (
    | { readonly kind: 'disconnect'; readonly closeCode: 1012 }
    | { readonly kind: 'duplicate'; readonly copies: 2 }
  );

export interface FaultReceipt {
  readonly sequence: number;
  readonly activation: number;
  readonly planId: string;
  readonly kind: FaultKind;
  readonly target: 'http' | 'gateway';
  readonly phase: 'selected' | 'ready' | 'cancelled';
}

export interface FaultEvidence {
  readonly events: readonly FaultReceipt[];
  readonly droppedEvents: number;
  readonly complete: boolean;
}

export class FaultPolicyResetError extends Error {
  public constructor() {
    super('Fault policy changed before the pending fault completed.');
    this.name = 'FaultPolicyResetError';
  }
}

interface ActivePlan {
  readonly plan: FaultPlan;
  remaining: number;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HTTP_KINDS = new Set<FaultKind>(['delay', 'timeout', 'http-status']);
const STATUSES = new Set<number>([429, 500, 502, 503]);
const COMMON_KEYS = ['id', 'kind', 'count'];

/** One session owns one policy. Matching consumes the first eligible plan in declaration order. */
export class FaultPolicy {
  #plans: ActivePlan[] = [];
  #events: FaultReceipt[] = [];
  #droppedEvents = 0;
  #activation = 0;
  #receiptSequence = 0;
  #generation = 0;
  #scope = new AbortController();

  public constructor(plans: unknown = []) {
    this.set(plans);
  }

  public set(plans: unknown): void {
    const validated = parseFaultPlans(plans);
    this.#beginScope();
    this.#plans = validated.map((plan) => ({ plan, remaining: plan.count }));
  }

  /** Restore configured occurrence counts; pending delays from the previous scope are cancelled. */
  public reset(): void {
    this.#beginScope();
    for (const item of this.#plans) item.remaining = item.plan.count;
  }

  /** Remove every plan and cancel pending waits. No fault configuration survives teardown. */
  public clear(): void {
    this.#beginScope();
    this.#plans = [];
  }

  public plans(): readonly (FaultPlan & { readonly remaining: number })[] {
    return this.#plans.map(({ plan, remaining }) => Object.freeze({ ...plan, remaining }));
  }

  public evidence(): FaultEvidence {
    return {
      events: this.#events.map((event) => ({ ...event })),
      droppedEvents: this.#droppedEvents,
      complete: this.#droppedEvents === 0,
    };
  }

  /** Select a transport action without waiting. Receipts record selection, not socket delivery. */
  public consumeHttp(request: {
    readonly method: string;
    readonly route: string;
  }): HttpFaultEffect | null {
    validateHttpRequest(request);
    const selected = this.#plans.find(
      ({ plan, remaining }) =>
        remaining > 0 &&
        HTTP_KINDS.has(plan.kind) &&
        (plan.method === undefined || plan.method === request.method) &&
        (plan.route === undefined || matchesRoute(plan.route, request.route)),
    );
    if (selected === undefined) return null;
    const { plan } = selected;
    selected.remaining -= 1;
    const activation = ++this.#activation;
    this.#record(plan, activation, 'http', 'selected');
    if (plan.kind === 'http-status') {
      return Object.freeze({
        id: plan.id,
        activation,
        kind: plan.kind,
        status: plan.status!,
        retryAfterMs: 1_000,
      });
    }
    return Object.freeze({
      id: plan.id,
      activation,
      kind: plan.kind as 'delay' | 'timeout',
      delayMs: plan.delayMs!,
    });
  }

  /** Delay/timeout plans await real transport time; the caller decides how to end a timed-out socket. */
  public async applyHttp(
    request: { readonly method: string; readonly route: string },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<HttpFaultEffect | null> {
    const signal =
      options.signal === undefined
        ? this.#scope.signal
        : AbortSignal.any([this.#scope.signal, options.signal]);
    signal.throwIfAborted();
    const effect = this.consumeHttp(request);
    if (effect === null) return null;
    const generation = this.#generation;
    try {
      if (effect.kind === 'delay' || effect.kind === 'timeout') {
        await delay(effect.delayMs, undefined, { signal });
      }
      signal.throwIfAborted();
      this.#record(effect, effect.activation, 'http', 'ready');
      return effect;
    } catch (error) {
      if (generation === this.#generation)
        this.#record(effect, effect.activation, 'http', 'cancelled');
      signal.throwIfAborted();
      throw error;
    }
  }

  public consumeGateway(event: string): GatewayFaultEffect | null {
    validateEvent(event);
    const selected = this.#plans.find(
      ({ plan, remaining }) =>
        remaining > 0 &&
        (plan.kind === 'disconnect' || plan.kind === 'duplicate') &&
        (plan.event === undefined || plan.event === event),
    );
    if (selected === undefined) return null;
    selected.remaining -= 1;
    const activation = ++this.#activation;
    this.#record(selected.plan, activation, 'gateway', 'selected');
    return selected.plan.kind === 'disconnect'
      ? Object.freeze({ id: selected.plan.id, activation, kind: 'disconnect', closeCode: 1012 })
      : Object.freeze({ id: selected.plan.id, activation, kind: 'duplicate', copies: 2 });
  }

  #beginScope(): void {
    this.#scope.abort(new FaultPolicyResetError());
    this.#scope = new AbortController();
    this.#generation += 1;
    this.#events = [];
    this.#droppedEvents = 0;
    this.#activation = 0;
    this.#receiptSequence = 0;
  }

  #record(
    plan: Pick<FaultPlan, 'id' | 'kind'>,
    activation: number,
    target: FaultReceipt['target'],
    phase: FaultReceipt['phase'],
  ): void {
    const receipt = Object.freeze({
      sequence: ++this.#receiptSequence,
      activation,
      planId: plan.id,
      kind: plan.kind,
      target,
      phase,
    });
    if (this.#events.length === MAX_FAULT_EVENTS) {
      this.#events.shift();
      this.#droppedEvents += 1;
    }
    this.#events.push(receipt);
  }
}

export function parseFaultPlans(value: unknown): readonly FaultPlan[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_FAULT_PLANS
  ) {
    throw new TypeError('Fault plans must be an array containing at most 100 plans.');
  }
  if (Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError('Fault plans must be a dense array without custom properties.');
  const ids = new Set<string>();
  const plans: FaultPlan[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('Fault plans must contain data elements.');
    const plan = parseFaultPlan(descriptor.value);
    if (ids.has(plan.id)) throw new TypeError('Fault plan IDs must be unique.');
    ids.add(plan.id);
    plans.push(plan);
  }
  return Object.freeze(plans);
}

function parseFaultPlan(value: unknown): FaultPlan {
  const record = plainRecord(value);
  const id = record['id'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id))
    throw new TypeError('Fault plan id must contain 1–64 letters, digits, underscores or hyphens.');
  const kind = record['kind'];
  if (
    kind !== 'delay' &&
    kind !== 'timeout' &&
    kind !== 'http-status' &&
    kind !== 'disconnect' &&
    kind !== 'duplicate'
  )
    throw new TypeError('Unknown fault kind.');
  const count = Object.hasOwn(record, 'count') ? record['count'] : 1;
  if (!Number.isInteger(count) || typeof count !== 'number' || count < 1 || count > MAX_FAULT_COUNT)
    throw new TypeError('Fault count must be an integer from 1 through 100.');
  const http = HTTP_KINDS.has(kind);
  const allowed = new Set([
    ...COMMON_KEYS,
    ...(http ? ['method', 'route'] : ['event']),
    ...(kind === 'delay' || kind === 'timeout' ? ['delayMs'] : []),
    ...(kind === 'http-status' ? ['status'] : []),
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new TypeError('Fault plan contains unknown or inapplicable fields.');
  const method = record['method'];
  if (method !== undefined && (typeof method !== 'string' || !METHODS.has(method)))
    throw new TypeError('Fault method must be a supported uppercase HTTP method.');
  const route = record['route'];
  if (route !== undefined) validateRoutePattern(route);
  const event = record['event'];
  if (event !== undefined) validateEvent(event);
  const delayMs = record['delayMs'];
  if (kind === 'delay' || kind === 'timeout') {
    if (
      typeof delayMs !== 'number' ||
      !Number.isInteger(delayMs) ||
      delayMs < (kind === 'timeout' ? 1 : 0) ||
      delayMs > MAX_FAULT_DELAY_MS
    )
      throw new TypeError(
        'Fault delayMs must be a bounded integer no greater than 30000; timeout requires at least 1 ms.',
      );
  }
  const status = record['status'];
  if (kind === 'http-status' && (typeof status !== 'number' || !STATUSES.has(status)))
    throw new TypeError('Fault HTTP status must be 429, 500, 502 or 503.');
  return Object.freeze({
    id,
    kind,
    count,
    ...(method === undefined ? {} : { method }),
    ...(route === undefined ? {} : { route }),
    ...(event === undefined ? {} : { event }),
    ...(delayMs === undefined ? {} : { delayMs: delayMs as number }),
    ...(status === undefined ? {} : { status: status as FaultHttpStatus }),
  });
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Fault plan must be a plain data object.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Fault plan must be a plain data object.');
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw new TypeError('Fault plan fields must be enumerable data properties.');
    output[key] = descriptor.value as unknown;
  }
  return output;
}

function validateEvent(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value))
    throw new TypeError('Fault event must be an uppercase Gateway event name.');
}

function validateRoutePattern(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 2_048 ||
    !value.startsWith('/') ||
    unsafePath(value)
  )
    throw new TypeError('Fault route must be a bounded absolute API pathname.');
  if (value === '/') return;
  for (const segment of value.slice(1).split('/')) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      (segment.includes('*') && segment !== '*') ||
      (segment.includes(':') && !/^:[A-Za-z][A-Za-z0-9_]*$/u.test(segment))
    )
      throw new TypeError('Fault route allows literal segments, *, or :parameter segments.');
  }
}

function validateHttpRequest(request: { readonly method: string; readonly route: string }): void {
  if (
    request === null ||
    typeof request !== 'object' ||
    !METHODS.has(request.method) ||
    typeof request.route !== 'string' ||
    Buffer.byteLength(request.route) > 8_192 ||
    !request.route.startsWith('/') ||
    unsafePath(request.route)
  )
    throw new TypeError(
      'Fault matching requires an uppercase HTTP method and absolute API pathname.',
    );
}

function matchesRoute(pattern: string, route: string): boolean {
  const expected = pattern.split('/');
  const actual = route.split('/');
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        segment === actual[index] ||
        ((segment === '*' || segment.startsWith(':')) && actual[index] !== ''),
    )
  );
}

function unsafePath(value: string): boolean {
  return /[?#\\]/u.test(value) || [...value].some((character) => character.charCodeAt(0) <= 32);
}
