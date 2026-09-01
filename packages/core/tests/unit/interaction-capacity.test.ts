import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  DiscordApiError,
  InteractionCapacityError,
  InteractionEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  createSimulationProfile,
} from '../../src/index.js';

function boundedEngine(
  options: {
    readonly maxInteractions?: number;
    readonly maxFollowupsPerInteraction?: number;
    readonly maxPayloadBytes?: number;
  } = {},
): { readonly clock: VirtualClock; readonly engine: InteractionEngine } {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 10_000 });
  return {
    clock,
    engine: new InteractionEngine({
      clock,
      random: new SeededRandom(88),
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
      ...options,
    }),
  };
}

describe('InteractionEngine capacity limits', () => {
  it('bounds retained interactions and reclaims expired entries deterministically', () => {
    const { clock, engine } = boundedEngine({ maxInteractions: 2 });
    const first = engine.create();
    const second = engine.create();
    expect(() => engine.create()).toThrow(InteractionCapacityError);

    clock.advanceBy(3_000);
    const replacement = engine.create();
    expect(engine.get(first.id)).toBeUndefined();
    expect(engine.getByToken(first.token)).toBeUndefined();
    expect(engine.get(second.id)?.status).toBe('expired');
    expect(engine.get(replacement.id)?.status).toBe('pending');
    expect(engine.list()).toHaveLength(2);
  });

  it('rejects duplicate tokens and bounds follow-up retention', () => {
    const { engine } = boundedEngine({ maxFollowupsPerInteraction: 2 });
    const token = 'disrunner.offline.interaction_duplicate-token';
    const interaction = engine.create({ token });
    expect(() => engine.create({ token })).toThrow(DiscordApiError);
    engine.respond(interaction.id, 'message', { content: 'ready' });
    engine.followup(interaction.id, { content: 'one' });
    engine.followup(interaction.id, { content: 'two' });
    expect(() => engine.followup(interaction.id, { content: 'three' })).toThrow(
      InteractionCapacityError,
    );
    expect(engine.require(interaction.id).followups).toHaveLength(2);
  });

  it('rejects oversized, cyclic, and deeply nested payloads before mutation', () => {
    const { engine } = boundedEngine({ maxPayloadBytes: 128 });
    expect(() => engine.create({ data: { content: 'x'.repeat(256) } })).toThrow(
      InteractionCapacityError,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => engine.create({ data: cyclic })).toThrow(TypeError);

    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 34; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor['child'] = child;
      cursor = child;
    }
    expect(() => engine.create({ data: root })).toThrow(InteractionCapacityError);
    expect(engine.list()).toEqual([]);
  });

  it('does not acknowledge an interaction when response validation fails', () => {
    const { engine } = boundedEngine({ maxPayloadBytes: 128 });
    const interaction = engine.create();
    expect(() => engine.respond(interaction.id, 'message', { content: 'x'.repeat(256) })).toThrow(
      InteractionCapacityError,
    );
    expect(engine.require(interaction.id)).toMatchObject({ status: 'pending' });
  });

  it('validates configured limits', () => {
    expect(() => boundedEngine({ maxInteractions: 0 })).toThrow(RangeError);
    expect(() => boundedEngine({ maxFollowupsPerInteraction: 0 })).toThrow(RangeError);
    expect(() => boundedEngine({ maxPayloadBytes: 127 })).toThrow(RangeError);
  });
});
