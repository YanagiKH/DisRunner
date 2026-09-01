import { describe, expect, it } from 'vitest';

import {
  BotRunner,
  ClockCapacityError,
  DISCORD_EPOCH_MS,
  InteractionCapacityError,
  InteractionEngine,
  SeededRandom,
  SnowflakeGenerator,
  StateCapacityError,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
  parseScenario,
  runScenario,
  sanitizeBotEnvironment,
  validateMessagePayload,
} from '../../src/index.js';

function createInteractionEngine(options: {
  readonly maxInteractions?: number;
  readonly maxFollowupsPerInteraction?: number;
  readonly maxPayloadBytes?: number;
  readonly maxRetainedBytesPerInteraction?: number;
  readonly maxRetainedBytes?: number;
}): { readonly clock: VirtualClock; readonly engine: InteractionEngine } {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 20_000 });
  return {
    clock,
    engine: new InteractionEngine({
      clock,
      random: new SeededRandom(101),
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
      ...options,
    }),
  };
}

describe('growth and capacity boundaries', () => {
  it('bounds scheduled tasks, frees cancelled slots, and stops zero-delay callback churn', () => {
    const clock = new VirtualClock({
      nowMs: 0,
      maxScheduledTasks: 2,
      maxCallbacksPerAdvance: 5,
    });
    const first = clock.schedule(100, () => undefined);
    clock.schedule(200, () => undefined);
    expect(() => clock.schedule(300, () => undefined)).toThrow(ClockCapacityError);
    expect(clock.cancel(first)).toBe(true);
    expect(() => clock.schedule(300, () => undefined)).not.toThrow();
    expect(clock.pendingTasks()).toBe(2);

    const churn = new VirtualClock({ nowMs: 0, maxCallbacksPerAdvance: 5 });
    let callbacks = 0;
    const reschedule = (): void => {
      callbacks += 1;
      churn.schedule(0, reschedule);
    };
    expect(() => churn.schedule(0, reschedule)).toThrow(ClockCapacityError);
    expect(callbacks).toBe(5);
    expect(churn.pendingTasks()).toBe(1);
  });

  it('applies scenario byte limits to object input and caps retained Gateway events', async () => {
    expect(() =>
      parseScenario(
        { version: 1, name: 'x'.repeat(1_000), steps: [] },
        { limits: { maxInputBytes: 128 } },
      ),
    ).toThrow(/maxInputBytes/);

    const cyclic: Record<string, unknown> = { version: 1, name: 'cycle', steps: [] };
    cyclic['self'] = cyclic;
    expect(() => parseScenario(cyclic as never)).toThrow(/cyclic/);

    await expect(
      runScenario(
        {
          version: 1,
          name: 'event-cap',
          steps: [
            {
              type: 'send-message',
              channelId: '1',
              authorId: '2',
              content: 'bounded',
            },
          ],
        },
        { limits: { maxEvents: 1 } },
      ),
    ).rejects.toThrow(/Gateway events/);

    await expect(
      runScenario(
        { version: 1, name: 'event-byte-cap', steps: [] },
        { limits: { maxEventBytes: 1 } },
      ),
    ).rejects.toThrow(/maxEventBytes/);
  });

  it('bounds per-interaction and aggregate retained payload bytes', () => {
    const perInteraction = createInteractionEngine({
      maxInteractions: 100,
      maxFollowupsPerInteraction: 100,
      maxPayloadBytes: 128,
      maxRetainedBytesPerInteraction: 1_024,
      maxRetainedBytes: 8_192,
    }).engine;
    const interaction = perInteraction.create({ data: { content: 'x'.repeat(80) } });
    perInteraction.respond(interaction.id, 'message', { content: 'ready' });
    let acceptedFollowups = 0;
    let firstFollowupId: string | undefined;
    for (;;) {
      try {
        const followup = perInteraction.followup(interaction.id, {
          content: 'y'.repeat(80),
        });
        firstFollowupId ??= followup.id;
        acceptedFollowups += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(InteractionCapacityError);
        break;
      }
    }
    expect(acceptedFollowups).toBeGreaterThan(0);
    expect(acceptedFollowups).toBeLessThan(100);
    expect(perInteraction.retainedByteCount()).toBeLessThanOrEqual(1_024);
    while (true) {
      try {
        perInteraction.followup(interaction.id, {});
      } catch (error) {
        expect(error).toBeInstanceOf(InteractionCapacityError);
        break;
      }
    }
    const beforeRejectedEdit = perInteraction.require(interaction.id);
    const beforeRejectedEditBytes = perInteraction.retainedByteCount();
    expect(() => perInteraction.editOriginal(interaction.id, { content: 'q'.repeat(110) })).toThrow(
      InteractionCapacityError,
    );
    expect(perInteraction.require(interaction.id)).toEqual(beforeRejectedEdit);
    expect(perInteraction.retainedByteCount()).toBe(beforeRejectedEditBytes);
    expect(firstFollowupId).toBeDefined();
    perInteraction.editFollowup(interaction.id, firstFollowupId as string, {
      content: 'small',
    });
    expect(perInteraction.retainedByteCount()).toBe(
      perInteraction
        .list()
        .reduce((total, retained) => total + Buffer.byteLength(JSON.stringify(retained)), 0),
    );

    const { clock, engine: aggregate } = createInteractionEngine({
      maxInteractions: 100,
      maxPayloadBytes: 128,
      maxRetainedBytesPerInteraction: 1_024,
      maxRetainedBytes: 1_024,
    });
    let retainedInteractions = 0;
    for (;;) {
      try {
        aggregate.create({ data: { content: 'z'.repeat(80) } });
        retainedInteractions += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(InteractionCapacityError);
        break;
      }
    }
    expect(retainedInteractions).toBeGreaterThan(0);
    expect(retainedInteractions).toBeLessThan(100);
    expect(aggregate.retainedByteCount()).toBeLessThanOrEqual(1_024);
    const beforeRejectedCreate = aggregate.list();
    const beforeRejectedCreateBytes = aggregate.retainedByteCount();
    expect(() => aggregate.create({ data: { content: 'z'.repeat(80) } })).toThrow(
      InteractionCapacityError,
    );
    expect(aggregate.list()).toEqual(beforeRejectedCreate);
    expect(aggregate.retainedByteCount()).toBe(beforeRejectedCreateBytes);
    clock.advanceBy(3_000);
    expect(() => aggregate.create({ data: { content: 'replacement' } })).not.toThrow();
    expect(aggregate.retainedByteCount()).toBeLessThanOrEqual(1_024);
  });

  it('rejects sparse and custom-property arrays before cloning or worklist expansion', () => {
    const sparse = new Array(1_000_000_000) as unknown[];
    const custom: unknown[] = [];
    Object.defineProperty(custom, 'hidden', {
      value: new Map([['payload', 'x'.repeat(1_000_000)]]),
      enumerable: true,
    });

    const { clock, engine } = createInteractionEngine({
      maxPayloadBytes: 128,
      maxRetainedBytesPerInteraction: 1_024,
      maxRetainedBytes: 1_024,
    });
    expect(() => engine.create({ data: { sparse } })).toThrow(InteractionCapacityError);
    expect(() => engine.create({ data: { custom } })).toThrow(TypeError);
    let getterCalled = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'payload', {
      get: () => {
        getterCalled = true;
        return 'unexpected';
      },
      enumerable: true,
    });
    expect(() => engine.create({ data: accessor })).toThrow(/data properties/);
    expect(getterCalled).toBe(false);
    expect(() => engine.create({ data: { toJSON: () => ({ hidden: custom }) } })).toThrow(
      TypeError,
    );
    expect(engine.list()).toEqual([]);

    const state = new VirtualState(clock, new SnowflakeGenerator(clock));
    expect(() => state.create('message', { id: '1', sparse })).toThrow(StateCapacityError);
    expect(() => state.create('message', { id: '2', custom })).toThrow(TypeError);
    expect(() => state.create('message', accessor)).toThrow(/data properties/);
    expect(getterCalled).toBe(false);
    expect(state.list()).toEqual([]);

    expect(() => parseScenario({ version: 1, name: 'sparse', steps: sparse } as never)).toThrow(
      /maxNodes/,
    );

    const validation = validateMessagePayload({ components: sparse });
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'COMPONENT_SCAN_LIMIT')).toBe(true);
  });

  it('rejects invalid BotRunner and retained-byte limits at construction', () => {
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new BotRunner({ maxOutputEntries: value })).toThrow(RangeError);
    }
    expect(() => new BotRunner({ maxOutputBytes: 128, maxOutputLineBytes: 256 })).toThrow(
      /maxOutputLineBytes/,
    );
    expect(() => createInteractionEngine({ maxRetainedBytesPerInteraction: 0 })).toThrow(
      RangeError,
    );
    expect(() => createInteractionEngine({ maxRetainedBytes: 0 })).toThrow(RangeError);

    const sparseKeys = new Array(1_000_000_000) as string[];
    expect(() =>
      sanitizeBotEnvironment(
        {},
        {
          inheritEnv: sparseKeys,
          restBaseUrl: 'http://127.0.0.1:1',
          gatewayUrl: 'ws://127.0.0.1:2',
        },
      ),
    ).toThrow(/Inherited environment keys/);

    let getterCalled = false;
    const accessorEnvironment: Record<string, string> = {};
    Object.defineProperty(accessorEnvironment, 'SAFE', {
      get: () => {
        getterCalled = true;
        return 'unexpected';
      },
      enumerable: true,
    });
    expect(() =>
      sanitizeBotEnvironment(
        {},
        {
          env: accessorEnvironment,
          restBaseUrl: 'http://127.0.0.1:1',
          gatewayUrl: 'ws://127.0.0.1:2',
        },
      ),
    ).toThrow(/data properties/);
    expect(getterCalled).toBe(false);
  });
});
