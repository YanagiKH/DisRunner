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

describe('LocalRestEmulator', () => {
  it('serves resource and interaction routes only on loopback with auth and dynamic 429s', async () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
    const random = new SeededRandom(9);
    const snowflakes = new SnowflakeGenerator(clock);
    const state = new VirtualState(clock, snowflakes);
    state.create('guild', { id: '1000', name: 'Lab' });
    state.create('channel', { id: '2000', guild_id: '1000', name: 'bot-testing', type: 0 });
    const profile = createSimulationProfile({ seed: 9 });
    const interactions = new InteractionEngine({ clock, random, snowflakes, profile });
    const gateway = new GatewayEmulator({
      clock,
      random,
      snowflakes,
      fakeToken: 'disrunner.offline.test-only-token-x',
    });
    const rateLimits = new RateLimitEngine(clock, [
      {
        id: 'message-create',
        method: 'POST',
        route: '/channels/:channelId/messages',
        limit: 1,
        windowMs: 1_250,
        scope: 'shared',
      },
    ]);
    const trace = new TraceCollector({ clock, random });
    const server = new LocalRestEmulator({
      state,
      interactions,
      gateway,
      rateLimits,
      fakeToken: 'disrunner.offline.test-only-token-x',
      trace,
    });
    const address = await server.start();
    try {
      expect(address.host).toBe('127.0.0.1');
      const unauthorized = await fetch(`${address.apiBaseUrl}/channels/2000`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ code: 0, message: '401: Unauthorized' });

      const channel = await fetch(`${address.apiBaseUrl}/channels/2000`, {
        headers: { Authorization: 'Bot disrunner.offline.test-only-token-x' },
      });
      expect(channel.status).toBe(200);
      expect(await channel.json()).toMatchObject({
        id: '2000',
        guild_id: '1000',
        name: 'bot-testing',
      });

      const firstMessage = await fetch(`${address.apiBaseUrl}/channels/2000/messages`, {
        method: 'POST',
        headers: {
          Authorization: 'Bot disrunner.offline.test-only-token-x',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'hello' }),
      });
      expect(firstMessage.status).toBe(200);

      const messageListHeaders = {
        Authorization: 'Bot disrunner.offline.test-only-token-x',
      };
      const validList = await fetch(`${address.apiBaseUrl}/channels/2000/messages?limit=100`, {
        headers: messageListHeaders,
      });
      expect(validList.status).toBe(200);
      expect(await validList.json()).toHaveLength(1);
      for (const invalidLimit of ['foo', '0', '101', '1.5']) {
        const invalidList = await fetch(
          `${address.apiBaseUrl}/channels/2000/messages?limit=${encodeURIComponent(invalidLimit)}`,
          { headers: messageListHeaders },
        );
        expect(invalidList.status).toBe(400);
        expect(await invalidList.json()).toEqual({
          code: 50035,
          message: 'limit must be an integer between 1 and 100.',
        });
      }

      const limited = await fetch(`${address.apiBaseUrl}/channels/2000/messages`, {
        method: 'POST',
        headers: {
          Authorization: 'Bot disrunner.offline.test-only-token-x',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'again' }),
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        message: 'You are being rate limited.',
        retry_after: 1.25,
        global: false,
      });

      const interaction = interactions.create();
      clock.advanceBy(2_999);
      const callback = await fetch(
        `${address.apiBaseUrl}/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 4, data: { content: 'pong' } }),
        },
      );
      expect(callback.status).toBe(204);
      expect(interactions.require(interaction.id).status).toBe('responded');
      expect(trace.spans().some((span) => span.kind === 'rest')).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('authenticates before rate limiting and ignores Authorization on token routes', async () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
    const random = new SeededRandom(10);
    const snowflakes = new SnowflakeGenerator(clock);
    const state = new VirtualState(clock, snowflakes);
    state.create('channel', { id: '2000', guild_id: '1000', name: 'bot-testing', type: 0 });
    const interactions = new InteractionEngine({
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile({ seed: 10 }),
    });
    const interaction = interactions.create();
    interactions.respond(interaction.id, 'message', { content: 'initial' });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({ clock, random, snowflakes, fakeToken: token });
    const rateLimits = new RateLimitEngine(clock, [
      {
        id: 'protected-user',
        method: 'POST',
        route: '/channels/:channelId/messages',
        limit: 1,
        windowMs: 5_000,
        scope: 'user',
      },
      {
        id: 'webhook-user',
        method: 'POST',
        route: '/webhooks/:webhookId/:token',
        limit: 1,
        windowMs: 5_000,
        scope: 'user',
      },
    ]);
    const server = new LocalRestEmulator({
      state,
      interactions,
      gateway,
      rateLimits,
      fakeToken: token,
    });
    const address = await server.start();
    const postMessage = (authorization: string) =>
      fetch(`${address.apiBaseUrl}/channels/2000/messages`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      });
    try {
      expect((await postMessage('Bot rotating-wrong-one')).status).toBe(401);
      expect((await postMessage('Bot rotating-wrong-two')).status).toBe(401);
      expect((await postMessage(`Bot ${token}`)).status).toBe(200);
      expect((await postMessage(`Bot ${token}`)).status).toBe(429);

      const webhookUrl = `${address.apiBaseUrl}/webhooks/1/${encodeURIComponent(interaction.token)}`;
      const followup = (authorization: string) =>
        fetch(webhookUrl, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'follow-up' }),
        });
      const bucketsBeforeInvalidTokens = rateLimits.buckets().length;
      for (let index = 0; index < 32; index += 1) {
        const invalid = await fetch(`${address.apiBaseUrl}/webhooks/1/invalid-${index}`, {
          method: 'POST',
          headers: { Authorization: `Bot attacker-${index}` },
        });
        expect(invalid.status).toBe(404);
      }
      expect(rateLimits.buckets()).toHaveLength(bucketsBeforeInvalidTokens);
      expect((await followup('Bot attacker-controlled-one')).status).toBe(200);
      const bucketsAfterValidToken = rateLimits.buckets().length;
      for (let index = 2; index < 34; index += 1) {
        const rotatedWebhookId = await fetch(
          `${address.apiBaseUrl}/webhooks/${index}/${encodeURIComponent(interaction.token)}`,
          {
            method: 'POST',
            headers: { Authorization: `Bot attacker-valid-${index}` },
          },
        );
        expect(rotatedWebhookId.status).toBe(429);
      }
      expect(rateLimits.buckets()).toHaveLength(bucketsAfterValidToken);
      expect((await followup('Bot attacker-controlled-two')).status).toBe(429);
    } finally {
      await server.stop();
    }
  });

  it('accepts an interaction callback at 2,999 ms and rejects it at 3,000 ms', async () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
    const random = new SeededRandom(11);
    const snowflakes = new SnowflakeGenerator(clock);
    const risks: string[] = [];
    const interactions = new InteractionEngine({
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile({ seed: 11 }),
      onRisk: (finding) => risks.push(finding.ruleId),
    });
    const gateway = new GatewayEmulator({ clock, random, snowflakes });
    const server = new LocalRestEmulator({
      state: new VirtualState(clock, snowflakes),
      interactions,
      gateway,
      rateLimits: new RateLimitEngine(clock),
    });
    const address = await server.start();
    const callback = (interaction: { readonly id: string; readonly token: string }) =>
      fetch(
        `${address.apiBaseUrl}/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 4, data: { content: 'pong' } }),
        },
      );
    try {
      const justInTime = interactions.create();
      clock.advanceBy(2_999);
      expect((await callback(justInTime)).status).toBe(204);

      const late = interactions.create();
      clock.advanceBy(3_000);
      const rejected = await callback(late);
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toEqual({ code: 10062, message: 'Unknown interaction.' });
      expect(risks).toContain('INTERACTION_TIMEOUT');
      expect(risks).not.toContain('DOUBLE_INTERACTION_RESPONSE');
    } finally {
      await server.stop();
    }
  });
});
