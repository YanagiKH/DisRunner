import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  GatewayEmulator,
  InteractionEngine,
  LocalRestEmulator,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  TraceCollector,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
} from '../../src/index.js';
import type { InteractionContext, SimulatedInteraction } from '../../src/index.js';

const APP = '111111111111111111';
const OTHER_APP = '222222222222222222';
const LEADING_ZERO_APP = '0111111111111111111';
const ABOVE_UINT64_APP = '18446744073709551616';
const MISSING_INTERACTION = '999999999999999999';
const WRONG_TOKEN = 'disrunner.offline.interaction_wrongwrongwrongwrongwrong';
const BAD_ENCODING = '%e0%a4%a';
const CTX_A: InteractionContext = {
  actorId: '300000000000000001',
  channelId: '400000000000000001',
  guildId: '500000000000000001',
};
const CTX_B: InteractionContext = {
  actorId: '300000000000000002',
  channelId: '400000000000000002',
};

const enc = encodeURIComponent;

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

interface Stack {
  readonly clock: VirtualClock;
  readonly engine: InteractionEngine;
  readonly rateLimits: RateLimitEngine;
  readonly trace: TraceCollector;
  readonly server: LocalRestEmulator;
  readonly replies: Reply[];
  api: string;
}

async function startStack(bound: boolean): Promise<Stack> {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
  const random = new SeededRandom(7_302);
  const snowflakes = new SnowflakeGenerator(clock);
  const engine = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
    ...(bound ? { applicationId: APP } : {}),
  });
  const rateLimits = new RateLimitEngine(clock, [
    {
      id: 'cb',
      method: 'POST',
      route: '/interactions/:interactionId/:token/callback',
      limit: 1,
      windowMs: 5_000,
      scope: 'user',
    },
    {
      id: 'wh',
      method: 'POST',
      route: '/webhooks/:webhookId/:token',
      limit: 1,
      windowMs: 5_000,
      scope: 'user',
    },
  ]);
  const trace = new TraceCollector({ clock, random });
  const server = new LocalRestEmulator({
    state: new VirtualState(clock, snowflakes),
    interactions: engine,
    gateway: new GatewayEmulator({ clock, random, snowflakes }),
    rateLimits,
    trace,
  });
  const address = await server.start();
  return { clock, engine, rateLimits, trace, server, replies: [], api: address.apiBaseUrl };
}

async function post(stack: Stack, path: string, body: unknown): Promise<Reply> {
  const response = await fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    parsed = undefined;
  }
  const reply = { status: response.status, text, body: parsed };
  stack.replies.push(reply);
  return reply;
}

function webhook(stack: Stack, appId: string, token: string, content = 'f'): Promise<Reply> {
  return post(stack, `/webhooks/${appId}/${token}`, { content });
}

function callback(stack: Stack, id: string, token: string): Promise<Reply> {
  return post(stack, `/interactions/${id}/${token}/callback`, {
    type: 4,
    data: { content: 'pong' },
  });
}

function snap(stack: Stack, ids: readonly string[]): unknown {
  return structuredClone({
    interactions: ids.map((id) => stack.engine.get(id)),
    retainedBytes: stack.engine.retainedByteCount(),
  });
}

function rl(stack: Stack): unknown {
  return structuredClone(stack.rateLimits.buckets());
}

function expectError(reply: Reply, status: number, code: number): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toMatchObject({ code });
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((child) => hasKeyDeep(child, key));
}

function expectNoTokenLeak(stack: Stack, tokens: readonly string[]): void {
  const spans = JSON.stringify(stack.trace.spans());
  for (const token of tokens) {
    for (const reply of stack.replies) expect(reply.text).not.toContain(token);
    expect(spans).not.toContain(token);
    expect(spans).not.toContain(enc(token));
  }
}

async function withStack(bound: boolean, run: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await startStack(bound);
  try {
    await run(stack);
  } finally {
    await stack.server.stop();
  }
}

function seed(stack: Stack): {
  readonly i: SimulatedInteraction;
  readonly j: SimulatedInteraction;
} {
  const i = stack.engine.create({ context: CTX_A });
  const j = stack.engine.create({ context: CTX_B });
  stack.engine.respond(i.id, 'message', { content: 'initial' });
  return { i, j };
}

describe('interaction token routes with application identity', () => {
  it('accepts the bound application ID with the correct token', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      const cb = await callback(stack, j.id, enc(j.token));
      expect(cb.status).toBe(204);
      const answered = stack.engine.get(j.id);
      expect(answered?.status).toBe('responded');
      expect(answered?.initialResponse?.data['content']).toBe('pong');

      const wh = await webhook(stack, APP, enc(i.token), 'f1');
      expect(wh.status).toBe(200);
      expect(wh.body).toMatchObject({ data: { content: 'f1' } });
      expect(hasKeyDeep(wh.body, 'token')).toBe(false);
      expect(stack.engine.get(i.id)?.followups).toHaveLength(1);
      expectNoTokenLeak(stack, [i.token, j.token]);
    });
  });

  it('rejects a correct token sent under another application ID without side effects', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      const engineBefore = snap(stack, [i.id, j.id]);
      const bucketsBefore = rl(stack);
      for (const appId of [OTHER_APP, LEADING_ZERO_APP, ABOVE_UINT64_APP]) {
        expectError(await webhook(stack, appId, enc(i.token)), 404, 10015);
      }
      expect(stack.engine.get(i.id)?.followups).toHaveLength(0);
      expect(stack.engine.get(i.id)?.initialResponse?.data['content']).toBe('initial');
      expect(snap(stack, [i.id, j.id])).toEqual(engineBefore);
      expect(rl(stack)).toEqual(bucketsBefore);
      expect((await webhook(stack, APP, enc(i.token))).status).toBe(200);
      expectNoTokenLeak(stack, [i.token, j.token]);
    });
  });

  it('rejects wrong and expired tokens without side effects', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      let engineBefore = snap(stack, [i.id, j.id]);
      let bucketsBefore = rl(stack);
      expectError(await webhook(stack, APP, enc(WRONG_TOKEN)), 404, 10015);
      expectError(await callback(stack, j.id, enc(WRONG_TOKEN)), 404, 10062);
      expect(snap(stack, [i.id, j.id])).toEqual(engineBefore);
      expect(rl(stack)).toEqual(bucketsBefore);

      stack.clock.advanceBy(900_000);
      stack.engine.get(i.id);
      engineBefore = snap(stack, [i.id, j.id]);
      bucketsBefore = rl(stack);
      expectError(await webhook(stack, APP, enc(i.token)), 404, 10015);
      expect(rl(stack)).toEqual(bucketsBefore);
      expect(stack.engine.get(i.id)?.followups).toHaveLength(0);
      expect(snap(stack, [i.id, j.id])).toEqual(engineBefore);

      const k = stack.engine.create({ context: CTX_A });
      stack.clock.advanceBy(3_000);
      stack.engine.get(k.id);
      engineBefore = snap(stack, [i.id, j.id, k.id]);
      bucketsBefore = rl(stack);
      expectError(await callback(stack, k.id, enc(k.token)), 404, 10062);
      expect(snap(stack, [i.id, j.id, k.id])).toEqual(engineBefore);
      expect(rl(stack)).toEqual(bucketsBefore);
      expectNoTokenLeak(stack, [i.token, j.token, k.token, WRONG_TOKEN]);
    });
  });

  it('rejects a token sent with the wrong or an unknown interaction ID', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      const engineBefore = snap(stack, [i.id, j.id]);
      const bucketsBefore = rl(stack);
      expectError(await callback(stack, j.id, enc(i.token)), 404, 10062);
      expectError(await callback(stack, MISSING_INTERACTION, enc(i.token)), 404, 10062);
      expect(snap(stack, [i.id, j.id])).toEqual(engineBefore);
      expect(rl(stack)).toEqual(bucketsBefore);
      expect(stack.engine.get(i.id)?.context).toEqual(CTX_A);
      expect(stack.engine.get(j.id)?.context).toEqual(CTX_B);
      expectNoTokenLeak(stack, [i.token, j.token]);
    });
  });

  it('rejects malformed token encoding without side effects', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      const engineBefore = snap(stack, [i.id, j.id]);
      const bucketsBefore = rl(stack);
      expectError(await webhook(stack, APP, BAD_ENCODING), 400, 50035);
      expectError(await callback(stack, j.id, BAD_ENCODING), 400, 50035);
      expect(snap(stack, [i.id, j.id])).toEqual(engineBefore);
      expect(rl(stack)).toEqual(bucketsBefore);
      expectNoTokenLeak(stack, [i.token, j.token]);
    });
  });

  it('fails closed for interactions that are not bound to an application', async () => {
    await withStack(false, async (stack) => {
      const u = stack.engine.create();
      stack.engine.respond(u.id, 'message', { content: 'initial' });
      const bucketsBefore = rl(stack);
      expectError(await webhook(stack, APP, enc(u.token)), 404, 10015);
      expectError(await webhook(stack, u.id, enc(u.token)), 404, 10015);
      expect(stack.engine.get(u.id)?.followups).toHaveLength(0);
      expect(rl(stack)).toEqual(bucketsBefore);

      const u2 = stack.engine.create();
      expectError(await callback(stack, u2.id, enc(u2.token)), 404, 10062);
      expect(stack.engine.get(u2.id)?.status).toBe('pending');
      expect(rl(stack)).toEqual(bucketsBefore);
      expectNoTokenLeak(stack, [u.token, u2.token]);
    });
  });

  it('does not spend the legitimate quota on wrong-identity requests', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      const initialBuckets = stack.rateLimits.buckets().length;
      const wrongWebhooks: readonly (readonly [string, number, number])[] = [
        [`/webhooks/${OTHER_APP}/${enc(i.token)}`, 404, 10015],
        [`/webhooks/${LEADING_ZERO_APP}/${enc(i.token)}`, 404, 10015],
        [`/webhooks/${ABOVE_UINT64_APP}/${enc(i.token)}`, 404, 10015],
        [`/webhooks/${APP}/${enc(WRONG_TOKEN)}`, 404, 10015],
        [`/webhooks/${APP}/${BAD_ENCODING}`, 400, 50035],
        [`/webhooks/${i.id}/${enc(i.token)}`, 404, 10015],
        [`/webhooks/${OTHER_APP}/${enc(WRONG_TOKEN)}`, 404, 10015],
        [`/webhooks/${APP}/${enc(j.token)}x`, 404, 10015],
      ];
      for (const [path, status, code] of wrongWebhooks) {
        expectError(await post(stack, path, { content: 'f' }), status, code);
        expect(stack.rateLimits.buckets().length, path).toBeLessThanOrEqual(initialBuckets);
      }
      expect((await webhook(stack, APP, enc(i.token))).status).toBe(200);
      expect((await webhook(stack, APP, enc(i.token))).status).toBe(429);

      const callbackBuckets = stack.rateLimits.buckets().length;
      const wrongCallbacks: readonly (readonly [string, number, number])[] = [
        [`/interactions/${j.id}/${enc(WRONG_TOKEN)}/callback`, 404, 10062],
        [`/interactions/${j.id}/${enc(i.token)}/callback`, 404, 10062],
        [`/interactions/${MISSING_INTERACTION}/${enc(j.token)}/callback`, 404, 10062],
        [`/interactions/${i.id}/${enc(j.token)}/callback`, 404, 10062],
        [`/interactions/${j.id}/${BAD_ENCODING}/callback`, 400, 50035],
        [`/interactions/${j.id}/${enc(j.token)}x/callback`, 404, 10062],
        [`/interactions/${MISSING_INTERACTION}/${enc(WRONG_TOKEN)}/callback`, 404, 10062],
        [`/interactions/${j.id}/${enc(WRONG_TOKEN)}x/callback`, 404, 10062],
      ];
      for (const [path, status, code] of wrongCallbacks) {
        expectError(await post(stack, path, { type: 4, data: { content: 'pong' } }), status, code);
        expect(stack.rateLimits.buckets().length, path).toBeLessThanOrEqual(callbackBuckets);
      }
      expect((await callback(stack, j.id, enc(j.token))).status).toBe(204);
      expectNoTokenLeak(stack, [i.token, j.token, WRONG_TOKEN]);
    });
  });

  it('keeps rate-limit buckets bounded when the webhook path ID rotates', async () => {
    await withStack(true, async (stack) => {
      const { i } = seed(stack);
      const bucketCount = stack.rateLimits.buckets().length;
      for (let n = 2; n < 34; n += 1) {
        expectError(await webhook(stack, String(n), enc(i.token)), 404, 10015);
      }
      expect(stack.rateLimits.buckets()).toHaveLength(bucketCount);
      expect(stack.engine.get(i.id)?.followups).toHaveLength(0);
      expectNoTokenLeak(stack, [i.token]);
    });
  });

  it('keeps tokens out of responses and trace span names', async () => {
    await withStack(true, async (stack) => {
      const { i, j } = seed(stack);
      await callback(stack, j.id, enc(j.token));
      await webhook(stack, APP, enc(i.token));
      await webhook(stack, OTHER_APP, enc(i.token));
      await webhook(stack, APP, enc(WRONG_TOKEN));
      await callback(stack, j.id, enc(WRONG_TOKEN));
      await webhook(stack, APP, BAD_ENCODING);
      const restSpans = stack.trace.spans().filter((span) => span.kind === 'rest');
      expect(restSpans.length).toBeGreaterThan(0);
      for (const span of restSpans) {
        if (span.name.includes('/webhooks/') || span.name.includes('/interactions/')) {
          expect(span.name).toContain(':token');
        }
      }
      expectNoTokenLeak(stack, [i.token, j.token, WRONG_TOKEN]);
    });
  });

  it('allows a bound interaction without context on both token routes', async () => {
    await withStack(true, async (stack) => {
      const n = stack.engine.create();
      expect((await callback(stack, n.id, enc(n.token))).status).toBe(204);
      const wh = await webhook(stack, APP, enc(n.token), 'f1');
      expect(wh.status).toBe(200);
      expect(stack.engine.get(n.id)?.followups).toHaveLength(1);
      expectNoTokenLeak(stack, [n.token]);
    });
  });
});
