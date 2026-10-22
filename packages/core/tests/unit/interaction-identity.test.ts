import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  InteractionEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  createSimulationProfile,
} from '../../src/index.js';
import type { InteractionContext } from '../../src/index.js';

const APP = '111111111111111111';
const OTHER_APP = '222222222222222222';
const MAX_ID = '18446744073709551615';
const CTX_A: InteractionContext = {
  actorId: '300000000000000001',
  channelId: '400000000000000001',
  guildId: '500000000000000001',
};
const CTX_B: InteractionContext = {
  actorId: '300000000000000002',
  channelId: '400000000000000002',
};
const INVALID_IDS: readonly unknown[] = [
  111,
  '',
  '0',
  '01',
  '-1',
  '1.5',
  ' 1',
  '18446744073709551616',
];

function createEngine(applicationId?: unknown): InteractionEngine {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
  return new InteractionEngine({
    clock,
    random: new SeededRandom(7_301),
    snowflakes: new SnowflakeGenerator(clock),
    profile: createSimulationProfile(),
    ...(applicationId === undefined ? {} : { applicationId: applicationId as string }),
  });
}

describe('interaction application binding', () => {
  it('binds every created interaction to the engine application ID', () => {
    const engine = createEngine(APP);
    const created = engine.create();
    expect(created.applicationId).toBe(APP);
    expect(engine.get(created.id)?.applicationId).toBe(APP);
    expect(engine.getByToken(created.token)?.applicationId).toBe(APP);
  });

  it('does not let interaction input override the bound application ID', () => {
    const engine = createEngine(APP);
    const viaData = engine.create({ data: { applicationId: OTHER_APP } });
    expect(viaData.applicationId).toBe(APP);
    expect(viaData.data).toEqual({ applicationId: OTHER_APP });
    expect(engine.get(viaData.id)?.applicationId).toBe(APP);

    let viaInput: { readonly applicationId?: string } | undefined;
    try {
      viaInput = engine.create({ applicationId: OTHER_APP } as never);
    } catch {
      viaInput = undefined;
    }
    if (viaInput !== undefined) expect(viaInput.applicationId).toBe(APP);
    for (const stored of engine.list()) expect(stored.applicationId).toBe(APP);
  });

  it('accepts only canonical unsigned 64-bit decimal application IDs', () => {
    for (const invalid of INVALID_IDS) {
      expect(() => createEngine(invalid), String(invalid)).toThrow(TypeError);
    }
    expect(createEngine(MAX_ID).create().applicationId).toBe(MAX_ID);
  });

  it('accepts only canonical unsigned 64-bit decimal context IDs', () => {
    const engine = createEngine(APP);
    for (const field of ['actorId', 'channelId', 'guildId'] as const) {
      for (const invalid of INVALID_IDS) {
        const countBefore = engine.list().length;
        const bytesBefore = engine.retainedByteCount();
        expect(
          () => engine.create({ context: { ...CTX_A, [field]: invalid } }),
          `${field}=${String(invalid)}`,
        ).toThrow(TypeError);
        expect(engine.list()).toHaveLength(countBefore);
        expect(engine.retainedByteCount()).toBe(bytesBefore);
      }
      const edge = engine.create({ context: { ...CTX_A, [field]: MAX_ID } });
      expect(engine.get(edge.id)?.context?.[field]).toBe(MAX_ID);
    }
  });
});

describe('interaction ID validation parity with bootstrap profiles', () => {
  const MORE_INVALID_IDS: readonly unknown[] = ['1e5', '1 ', '0x10', 1, 1n, '0100000000000000001'];
  const ACCEPTED_IDS = ['1', MAX_ID] as const;

  it('rejects the remaining bootstrap invalid ID forms for the application ID', () => {
    for (const invalid of MORE_INVALID_IDS) {
      expect(() => createEngine(invalid), String(invalid)).toThrow(TypeError);
    }
  });

  it('accepts the bootstrap ID bounds for the application ID', () => {
    for (const accepted of ACCEPTED_IDS) {
      expect(createEngine(accepted).create().applicationId).toBe(accepted);
    }
  });

  it('applies the same accepted and rejected ID forms to every context field', () => {
    const engine = createEngine(APP);
    for (const field of ['actorId', 'channelId', 'guildId'] as const) {
      for (const invalid of MORE_INVALID_IDS) {
        const countBefore = engine.list().length;
        const bytesBefore = engine.retainedByteCount();
        expect(
          () => engine.create({ context: { ...CTX_A, [field]: invalid } }),
          `${field}=${String(invalid)}`,
        ).toThrow(TypeError);
        expect(engine.list()).toHaveLength(countBefore);
        expect(engine.retainedByteCount()).toBe(bytesBefore);
      }
      for (const accepted of ACCEPTED_IDS) {
        const created = engine.create({ context: { ...CTX_A, [field]: accepted } });
        expect(engine.get(created.id)?.context?.[field]).toBe(accepted);
      }
    }
  });
});

describe('interaction context isolation', () => {
  it('copies the caller context so later caller mutation has no effect', () => {
    const engine = createEngine(APP);
    const ctx: Record<string, unknown> = { ...CTX_A };
    const created = engine.create({ context: ctx as unknown as InteractionContext });
    ctx['actorId'] = '9';
    ctx['extra'] = 1;
    expect(engine.get(created.id)?.context).toEqual(CTX_A);
  });

  it('returns copies that cannot change the stored context or application ID', () => {
    const engine = createEngine(APP);
    const created = engine.create({ context: { ...CTX_A } });
    const results = [created, engine.get(created.id), engine.getByToken(created.token)];
    for (const result of results) {
      expect(result).toBeDefined();
      const context = result?.context;
      expect(context).toBeDefined();
      try {
        Reflect.set(context as object, 'actorId', '9');
      } catch {
        // A frozen copy may throw; either outcome is acceptable.
      }
      try {
        Reflect.set(result as object, 'applicationId', OTHER_APP);
      } catch {
        // A frozen copy may throw; either outcome is acceptable.
      }
      const fresh = engine.get(created.id);
      expect(fresh?.context).toEqual(CTX_A);
      expect(fresh?.applicationId).toBe(APP);
    }
  });

  it('keeps contexts separate between interactions', () => {
    const engine = createEngine(APP);
    const shared: Record<string, unknown> = { ...CTX_A };
    const first = engine.create({ context: shared as unknown as InteractionContext });
    const second = engine.create({ context: shared as unknown as InteractionContext });
    shared['actorId'] = '9';
    shared['guildId'] = '8';
    expect(engine.get(first.id)?.context).toEqual(CTX_A);
    expect(engine.get(second.id)?.context).toEqual(CTX_A);

    const withA = engine.create({ context: { ...CTX_A } });
    const withB = engine.create({ context: { ...CTX_B } });
    expect(engine.get(withA.id)?.context).toEqual(CTX_A);
    const storedB = engine.get(withB.id)?.context;
    expect(storedB).toEqual(CTX_B);
    expect(Object.hasOwn(storedB as object, 'guildId')).toBe(false);
  });
});

describe('model-only engine compatibility', () => {
  it('keeps the model lifecycle working without an application ID', () => {
    const engine = createEngine();
    const plain = engine.create();
    expect(Object.hasOwn(plain, 'applicationId')).toBe(false);
    expect(Object.hasOwn(plain, 'context')).toBe(false);

    const ctx: Record<string, unknown> = { ...CTX_A };
    const withContext = engine.create({ context: ctx as unknown as InteractionContext });
    ctx['actorId'] = '9';
    expect(Object.hasOwn(withContext, 'applicationId')).toBe(false);
    expect(engine.get(withContext.id)?.context).toEqual(CTX_A);

    expect(engine.respond(plain.id, 'defer').status).toBe('deferred');
    const followup = engine.followup(plain.id, { content: 'f1' });
    expect(followup).toMatchObject({ data: { content: 'f1' }, ephemeral: false, deleted: false });
    const edited = engine.editOriginal(plain.id, { content: 'edited' });
    expect(edited.status).toBe('responded');
    expect(edited.initialResponse).toMatchObject({ type: 'message', data: { content: 'edited' } });
    expect(engine.editFollowup(plain.id, followup.id, { content: 'f2' }).data).toEqual({
      content: 'f2',
    });
    engine.deleteFollowup(plain.id, followup.id);
    expect(engine.require(plain.id).followups[0]?.deleted).toBe(true);
    expect(engine.deleteOriginal(plain.id).status).toBe('deleted');
    expect(Object.hasOwn(engine.require(plain.id), 'applicationId')).toBe(false);
  });

  it('binds an interaction created without context and leaves out the context key', () => {
    const engine = createEngine(APP);
    const created = engine.create();
    expect(created.applicationId).toBe(APP);
    expect(Object.hasOwn(created, 'context')).toBe(false);
    expect(Object.hasOwn(engine.get(created.id) as object, 'context')).toBe(false);
  });
});
