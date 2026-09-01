import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  GatewayEmulator,
  GatewayIntents,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
} from '../../src/index.js';

describe('core performance budgets', () => {
  it('processes 10,000 state creations and Gateway message events within a broad CI budget', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const random = new SeededRandom(11);
    const snowflakes = new SnowflakeGenerator(clock);
    const state = new VirtualState(clock, snowflakes);
    const gateway = new GatewayEmulator({
      clock,
      random,
      snowflakes,
      fakeToken: 'disrunner.offline.test-only-token-x',
      replayLimit: 100,
    });
    const session = gateway.identify({
      token: 'disrunner.offline.test-only-token-x',
      intents: GatewayIntents.GUILD_MESSAGES,
    });
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      const message = state.create('message', {
        channel_id: '1',
        guild_id: '2',
        content: `message-${index}`,
        embeds: [],
        attachments: [],
        components: [],
      });
      gateway.dispatch(session.sessionId, 'MESSAGE_CREATE', message);
      if (index % 4_096 === 0) clock.advanceBy(1);
    }
    const elapsedMs = performance.now() - started;
    expect(state.list('message')).toHaveLength(10_000);
    expect(gateway.session(session.sessionId)?.sequence).toBe(10_001);
    expect(gateway.replay(session.sessionId, 0)).toHaveLength(100);
    expect(state.mutationHistory()).toHaveLength(1_000);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
