import { describe, expect, it, vi } from 'vitest';

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

const TOKEN = 'disrunner.offline.interaction_abcdefghijklmnopqrstuvwx';
const ENCODED_TOKEN = 'disrunner%2Eoffline%2Einteraction_abcdefghijklmnopqrstuvwx';
const WEBHOOK_TEMPLATE = '/webhooks/:webhookId/:token';
const CALLBACK_TEMPLATE = '/interactions/:interactionId/:token/callback';

const cases = [
  [
    'invalid application ID',
    'POST',
    `/webhooks/private-id-sentinel/${ENCODED_TOKEN}`,
    WEBHOOK_TEMPLATE,
    401,
    0,
  ],
  [
    'invalid interaction ID',
    'POST',
    `/interactions/private-id-sentinel/${ENCODED_TOKEN}/callback`,
    CALLBACK_TEMPLATE,
    401,
    0,
  ],
  [
    'webhook suffix',
    'POST',
    `/webhooks/111/${ENCODED_TOKEN}/private-suffix-sentinel`,
    WEBHOOK_TEMPLATE,
    401,
    0,
  ],
  [
    'callback suffix',
    'POST',
    `/interactions/111/${ENCODED_TOKEN}/callback/private-suffix-sentinel`,
    CALLBACK_TEMPLATE,
    401,
    0,
  ],
  [
    'unsupported method',
    'GET',
    `/webhooks/private-id-sentinel/${ENCODED_TOKEN}`,
    WEBHOOK_TEMPLATE,
    401,
    0,
  ],
  [
    'malformed URI in unsupported route',
    'POST',
    '/interactions/private-id-sentinel/%e0%a4%a/callback',
    CALLBACK_TEMPLATE,
    401,
    0,
  ],
  [
    'malformed URI in supported route',
    'POST',
    '/webhooks/111/%e0%a4%a',
    WEBHOOK_TEMPLATE,
    400,
    50035,
  ],
  [
    'supported wrong application',
    'POST',
    `/webhooks/222/${ENCODED_TOKEN}`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'original read with wrong application',
    'GET',
    `/webhooks/222/${ENCODED_TOKEN}/messages/@original`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'original edit with wrong application',
    'PATCH',
    `/webhooks/222/${ENCODED_TOKEN}/messages/@original`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'original delete with wrong application',
    'DELETE',
    `/webhooks/222/${ENCODED_TOKEN}/messages/@original`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'followup read with wrong application',
    'GET',
    `/webhooks/222/${ENCODED_TOKEN}/messages/333`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'followup edit with wrong application',
    'PATCH',
    `/webhooks/222/${ENCODED_TOKEN}/messages/333`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'followup delete with wrong application',
    'DELETE',
    `/webhooks/222/${ENCODED_TOKEN}/messages/333`,
    WEBHOOK_TEMPLATE,
    404,
    10015,
  ],
  [
    'malformed URI in original route',
    'GET',
    '/webhooks/111/%e0%a4%a/messages/@original',
    WEBHOOK_TEMPLATE,
    400,
    50035,
  ],
] as const;

describe('sensitive interaction route trace templates', () => {
  it.each(cases)(
    'does not reflect secrets for %s',
    async (_label, method, path, template, status, code) => {
      const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
      const random = new SeededRandom(901);
      const snowflakes = new SnowflakeGenerator(clock);
      const interactions = new InteractionEngine({
        applicationId: '111',
        clock,
        random,
        snowflakes,
        profile: createSimulationProfile(),
      });
      interactions.create({ token: TOKEN });
      const rateLimits = new RateLimitEngine(clock);
      const acquire = vi.spyOn(rateLimits, 'acquire');
      const trace = new TraceCollector({ clock, random });
      const server = new LocalRestEmulator({
        state: new VirtualState(clock, snowflakes),
        interactions,
        gateway: new GatewayEmulator({ clock, random, snowflakes }),
        rateLimits,
        trace,
      });
      const address = await server.start();
      try {
        const before = rateLimits.buckets();
        const response = await fetch(`${address.apiBaseUrl}${path}`, {
          method,
          ...(method === 'POST' || method === 'PATCH' ? { body: '{invalid-json' } : {}),
        });
        const body: unknown = await response.json();
        expect(response.status).toBe(status);
        expect(body).toMatchObject({ code });
        expect(rateLimits.buckets()).toEqual(before);
        expect(acquire).not.toHaveBeenCalled();
        const spans = trace.spans();
        expect(spans).toHaveLength(1);
        const serialized = JSON.stringify({ spans, body });
        for (const sentinel of [
          TOKEN,
          ENCODED_TOKEN,
          'private-id-sentinel',
          'private-suffix-sentinel',
          '%e0%a4%a',
        ]) {
          expect(serialized.includes(sentinel)).toBe(false);
        }
        expect(spans[0]?.name).toBe(`${method} ${template}`);
        expect(spans[0]?.metadata['path']).toBe(template);
      } finally {
        await server.stop();
      }
    },
  );
});
