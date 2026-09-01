import { createHash } from 'node:crypto';

import type { VirtualClock } from './clock.js';

export type RateLimitScope = 'user' | 'shared' | 'global';

export interface RateLimitRule {
  readonly id?: string;
  readonly method?: string;
  readonly route: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly scope?: RateLimitScope;
  readonly majorParameters?: readonly string[];
}

export interface RateLimitRequest {
  readonly method: string;
  readonly path: string;
  readonly identity?: string;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly status: 200 | 429;
  readonly bucketKey: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly retryAfterMs: number;
  readonly global: boolean;
  readonly scope: RateLimitScope;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: {
    readonly message: string;
    readonly retry_after: number;
    readonly global: boolean;
  };
}

export interface RateLimitBucketSnapshot {
  readonly key: string;
  readonly ruleId: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly scope: RateLimitScope;
}

interface CompiledRule {
  readonly id: string;
  readonly method?: string;
  readonly route: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly scope: RateLimitScope;
  readonly majorParameters: readonly string[];
  readonly matcher: RegExp;
  readonly parameterNames: readonly string[];
}

interface MutableBucket {
  key: string;
  ruleId: string;
  limit: number;
  remaining: number;
  resetAtMs: number;
  scope: RateLimitScope;
  windowMs: number;
}

export interface RateLimitEngineOptions {
  readonly maxBuckets?: number;
  readonly maxObservedRequests?: number;
}

export class RateLimitCapacityError extends Error {
  public constructor(resource: 'buckets' | 'observed requests') {
    super(`Rate-limit ${resource} capacity was reached.`);
    this.name = 'RateLimitCapacityError';
  }
}

const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_MAX_OBSERVED_REQUESTS = 10_000;
const MAX_RATE_LIMIT_IDENTIFIER_BYTES = 256;

export class RateLimitEngine {
  readonly #clock: VirtualClock;
  readonly #rules: CompiledRule[] = [];
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #observedRequests = new Map<string, string>();
  readonly #maxBuckets: number;
  readonly #maxObservedRequests: number;
  #globalResetAtMs = 0;

  public constructor(
    clock: VirtualClock,
    rules: readonly RateLimitRule[] = [],
    options: RateLimitEngineOptions = {},
  ) {
    this.#clock = clock;
    this.#maxBuckets = positiveSafeCapacity(
      options.maxBuckets ?? DEFAULT_MAX_BUCKETS,
      'maxBuckets',
    );
    this.#maxObservedRequests = positiveSafeCapacity(
      options.maxObservedRequests ?? DEFAULT_MAX_OBSERVED_REQUESTS,
      'maxObservedRequests',
    );
    for (const rule of rules) this.configure(rule);
  }

  public configure(rule: RateLimitRule): string {
    validateRule(rule);
    const compiled = compileRule(rule);
    const index = this.#rules.findIndex((current) => current.id === compiled.id);
    if (index >= 0) this.#rules[index] = compiled;
    else this.#rules.push(compiled);
    return compiled.id;
  }

  public removeRule(ruleId: string): boolean {
    const index = this.#rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return false;
    this.#rules.splice(index, 1);
    for (const [key, bucket] of this.#buckets) {
      if (bucket.ruleId === ruleId) this.#buckets.delete(key);
    }
    this.#removeStaleObservedRequests();
    return true;
  }

  public acquire(request: RateLimitRequest): RateLimitResult {
    const nowMs = this.#clock.now();
    if (nowMs < this.#globalResetAtMs) {
      return this.#deniedGlobal(this.#globalResetAtMs - nowMs);
    }
    const observedKey = this.#observedRequests.get(requestFingerprint(request));
    if (observedKey !== undefined) {
      const observed = this.#buckets.get(observedKey);
      if (observed !== undefined) {
        if (nowMs >= observed.resetAtMs) {
          observed.remaining = observed.limit;
          observed.resetAtMs = nowMs + observed.windowMs;
        }
        if (observed.remaining <= 0)
          return deniedResult(observed, nowMs, observed.scope === 'global');
        observed.remaining -= 1;
        return allowedResult(observed, nowMs);
      }
      this.#observedRequests.delete(requestFingerprint(request));
    }
    const match = this.#matchRule(request);
    if (match === undefined) {
      return unrestrictedResult(nowMs);
    }
    const { rule, parameters } = match;
    const key = makeBucketKey(rule, parameters, request.identity);
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      this.#ensureBucketCapacity(nowMs);
      bucket = {
        key,
        ruleId: rule.id,
        limit: rule.limit,
        remaining: rule.limit,
        resetAtMs: nowMs + rule.windowMs,
        scope: rule.scope,
        windowMs: rule.windowMs,
      };
      this.#buckets.set(key, bucket);
    } else if (nowMs >= bucket.resetAtMs) {
      bucket.limit = rule.limit;
      bucket.remaining = rule.limit;
      bucket.resetAtMs = nowMs + rule.windowMs;
      bucket.windowMs = rule.windowMs;
    }

    if (bucket.remaining <= 0) return deniedResult(bucket, nowMs, false);
    bucket.remaining -= 1;
    return allowedResult(bucket, nowMs);
  }

  public injectGlobalLimit(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new RangeError('Global rate-limit duration must be a non-negative safe integer.');
    }
    const resetAtMs = this.#clock.now() + durationMs;
    if (!Number.isSafeInteger(resetAtMs)) {
      throw new RangeError('Global rate-limit reset time exceeds the safe integer range.');
    }
    this.#globalResetAtMs = Math.max(this.#globalResetAtMs, resetAtMs);
  }

  /** Update a bucket from Discord-compatible response headers instead of fixed local constants. */
  public observe(request: RateLimitRequest, headers: Readonly<Record<string, string>>): void {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const limit = parseNonNegativeNumber(normalized['x-ratelimit-limit']);
    const remaining = parseNonNegativeNumber(normalized['x-ratelimit-remaining']);
    const resetAfterSeconds = parseNonNegativeNumber(normalized['x-ratelimit-reset-after']);
    const bucketId = normalized['x-ratelimit-bucket'];
    if (
      limit === undefined ||
      remaining === undefined ||
      resetAfterSeconds === undefined ||
      bucketId === undefined
    ) {
      throw new TypeError(
        'Observed rate-limit headers must include limit, remaining, reset-after, and bucket.',
      );
    }
    const scope = parseScope(normalized['x-ratelimit-scope']);
    assertBoundedIdentifier(bucketId, 'Observed bucket identifier');
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(remaining)) {
      throw new TypeError('Observed rate-limit limit and remaining values must be safe integers.');
    }
    const windowMs = resetAfterSeconds * 1_000;
    const resetAtMs = this.#clock.now() + windowMs;
    if (!Number.isSafeInteger(windowMs) || !Number.isSafeInteger(resetAtMs)) {
      throw new TypeError('Observed rate-limit reset time exceeds the safe integer range.');
    }
    const fingerprint = requestFingerprint(request);
    const key = `${bucketId}:${digestKey(scope === 'user' ? (request.identity ?? 'anonymous') : 'shared')}`;
    if (!this.#buckets.has(key)) this.#ensureBucketCapacity(this.#clock.now());
    if (!this.#observedRequests.has(fingerprint)) this.#ensureObservedCapacity(this.#clock.now());
    this.#buckets.set(key, {
      key,
      ruleId: bucketId,
      limit: Math.floor(limit),
      remaining: Math.floor(remaining),
      resetAtMs,
      scope,
      windowMs,
    });
    this.#observedRequests.set(fingerprint, key);
    if (normalized['x-ratelimit-global'] === 'true') {
      this.#globalResetAtMs = resetAtMs;
    }
  }

  public buckets(): readonly RateLimitBucketSnapshot[] {
    return [...this.#buckets.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((bucket) => ({ ...bucket }));
  }

  #ensureBucketCapacity(nowMs: number): void {
    if (this.#buckets.size < this.#maxBuckets) return;
    this.#pruneExpired(nowMs);
    if (this.#buckets.size >= this.#maxBuckets) throw new RateLimitCapacityError('buckets');
  }

  #ensureObservedCapacity(nowMs: number): void {
    if (this.#observedRequests.size < this.#maxObservedRequests) return;
    this.#pruneExpired(nowMs);
    if (this.#observedRequests.size >= this.#maxObservedRequests) {
      throw new RateLimitCapacityError('observed requests');
    }
  }

  #pruneExpired(nowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (nowMs >= bucket.resetAtMs) this.#buckets.delete(key);
    }
    this.#removeStaleObservedRequests();
  }

  #removeStaleObservedRequests(): void {
    for (const [fingerprint, key] of this.#observedRequests) {
      if (!this.#buckets.has(key)) this.#observedRequests.delete(fingerprint);
    }
  }

  #matchRule(
    request: RateLimitRequest,
  ):
    | { readonly rule: CompiledRule; readonly parameters: Readonly<Record<string, string>> }
    | undefined {
    const method = request.method.toUpperCase();
    const path = normalizePath(request.path);
    for (const rule of this.#rules) {
      if (rule.method !== undefined && rule.method !== method) continue;
      const match = rule.matcher.exec(path);
      if (match === null) continue;
      const parameters: Record<string, string> = {};
      rule.parameterNames.forEach((name, index) => {
        parameters[name] = decodeURIComponent(match[index + 1] as string);
      });
      return { rule, parameters };
    }
    return undefined;
  }

  #deniedGlobal(retryAfterMs: number): RateLimitResult {
    const resetAtMs = this.#clock.now() + retryAfterMs;
    const bucket: MutableBucket = {
      key: 'global',
      ruleId: 'global',
      limit: 0,
      remaining: 0,
      resetAtMs,
      scope: 'global',
      windowMs: retryAfterMs,
    };
    return deniedResult(bucket, this.#clock.now(), true);
  }
}

function compileRule(rule: RateLimitRule): CompiledRule {
  const parameterNames: string[] = [];
  const parts = normalizePath(rule.route)
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(':')) {
        const name = part.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
          throw new TypeError(`Invalid route parameter: ${part}`);
        parameterNames.push(name);
        return '([^/]+)';
      }
      return escapeRegExp(part);
    });
  const route = normalizePath(rule.route);
  const method = rule.method?.toUpperCase();
  const id =
    rule.id ??
    createHash('sha256')
      .update(`${method ?? '*'}:${route}`)
      .digest('hex')
      .slice(0, 16);
  return {
    id,
    ...(method === undefined ? {} : { method }),
    route,
    limit: rule.limit,
    windowMs: rule.windowMs,
    scope: rule.scope ?? 'user',
    majorParameters: rule.majorParameters ?? inferMajorParameters(parameterNames),
    matcher: new RegExp(`^/${parts.join('/')}/?$`),
    parameterNames,
  };
}

function makeBucketKey(
  rule: CompiledRule,
  parameters: Readonly<Record<string, string>>,
  identity: string | undefined,
): string {
  const major = rule.majorParameters.map((name) => `${name}=${parameters[name] ?? ''}`).join('&');
  const subject = rule.scope === 'user' ? (identity ?? 'anonymous') : rule.scope;
  return `${rule.id}:${digestKey(`${major}\0${subject}`)}`;
}

function allowedResult(bucket: MutableBucket, nowMs: number): RateLimitResult {
  const retryAfterMs = Math.max(0, bucket.resetAtMs - nowMs);
  return {
    allowed: true,
    status: 200,
    bucketKey: bucket.key,
    limit: bucket.limit,
    remaining: bucket.remaining,
    resetAtMs: bucket.resetAtMs,
    retryAfterMs,
    global: false,
    scope: bucket.scope,
    headers: rateLimitHeaders(bucket, retryAfterMs, false),
  };
}

function deniedResult(bucket: MutableBucket, nowMs: number, global: boolean): RateLimitResult {
  const retryAfterMs = Math.max(0, bucket.resetAtMs - nowMs);
  return {
    allowed: false,
    status: 429,
    bucketKey: bucket.key,
    limit: bucket.limit,
    remaining: 0,
    resetAtMs: bucket.resetAtMs,
    retryAfterMs,
    global,
    scope: global ? 'global' : bucket.scope,
    headers: {
      ...rateLimitHeaders(bucket, retryAfterMs, global),
      'Retry-After': String(retryAfterMs / 1_000),
    },
    body: {
      message: 'You are being rate limited.',
      retry_after: retryAfterMs / 1_000,
      global,
    },
  };
}

function rateLimitHeaders(
  bucket: MutableBucket,
  retryAfterMs: number,
  global: boolean,
): Readonly<Record<string, string>> {
  return {
    'X-RateLimit-Limit': String(bucket.limit),
    'X-RateLimit-Remaining': String(Math.max(0, bucket.remaining)),
    'X-RateLimit-Reset': String(bucket.resetAtMs / 1_000),
    'X-RateLimit-Reset-After': String(retryAfterMs / 1_000),
    'X-RateLimit-Bucket': bucket.ruleId,
    'X-RateLimit-Scope': global ? 'global' : bucket.scope,
    ...(global
      ? { 'X-RateLimit-Global': 'true', 'Retry-After': String(retryAfterMs / 1_000) }
      : {}),
  };
}

function unrestrictedResult(nowMs: number): RateLimitResult {
  return {
    allowed: true,
    status: 200,
    bucketKey: 'unrestricted',
    limit: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
    resetAtMs: nowMs,
    retryAfterMs: 0,
    global: false,
    scope: 'user',
    headers: {},
  };
}

function validateRule(rule: RateLimitRule): void {
  if (!Number.isSafeInteger(rule.limit) || rule.limit <= 0) {
    throw new RangeError('Rate-limit rule limit must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs <= 0) {
    throw new RangeError('Rate-limit rule window must be a positive safe integer.');
  }
  if (!rule.route.startsWith('/')) throw new TypeError('Rate-limit route must start with /.');
  if (Buffer.byteLength(rule.route) > 8_192) {
    throw new RangeError('Rate-limit route is too large.');
  }
  if (rule.id !== undefined) assertBoundedIdentifier(rule.id, 'Rate-limit rule identifier');
}

function normalizePath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? '/';
  return `/${pathname.split('/').filter(Boolean).join('/')}`;
}

function inferMajorParameters(names: readonly string[]): readonly string[] {
  const majors = new Set([
    'channelId',
    'channel_id',
    'guildId',
    'guild_id',
    'webhookId',
    'webhook_id',
    'token',
  ]);
  return names.filter((name) => majors.has(name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseScope(value: string | undefined): RateLimitScope {
  return value === 'shared' || value === 'global' ? value : 'user';
}

function requestFingerprint(request: RateLimitRequest): string {
  return digestKey(
    `${request.method.toUpperCase()}\0${normalizePath(request.path)}\0${request.identity ?? 'anonymous'}`,
  );
}

function digestKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function assertBoundedIdentifier(value: string, name: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_RATE_LIMIT_IDENTIFIER_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-control string.`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function positiveSafeCapacity(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
