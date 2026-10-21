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
import type {
  InteractionEngineOptions,
  InteractionResponseType,
  SimulatedInteraction,
} from '../../src/index.js';

// Expected behavior is documented in docs/interaction-lifecycle-regressions.md. It was written from
// Discord's interaction callback matrix and webhook-message PATCH semantics before the fix.

type EngineLimits = Omit<
  InteractionEngineOptions,
  'clock' | 'random' | 'snowflakes' | 'profile' | 'onRisk'
>;

function createEngine(limits: EngineLimits = {}): {
  readonly clock: VirtualClock;
  readonly engine: InteractionEngine;
} {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 20_000 });
  return {
    clock,
    engine: new InteractionEngine({
      clock,
      random: new SeededRandom(4_242),
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
      ...limits,
    }),
  };
}

interface Snapshot {
  readonly interaction: SimulatedInteraction;
  readonly retainedBytes: number;
}

function snapshot(engine: InteractionEngine, id: string): Snapshot {
  return { interaction: engine.require(id), retainedBytes: engine.retainedByteCount() };
}

function expectApiError(action: () => unknown, status: number, code: number): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DiscordApiError);
  expect((caught as DiscordApiError).status).toBe(status);
  expect((caught as DiscordApiError).code).toBe(code);
}

function serializedTotal(engine: InteractionEngine): number {
  return engine
    .list()
    .reduce((total, retained) => total + Buffer.byteLength(JSON.stringify(retained)), 0);
}

const ALL_CALLBACKS: readonly InteractionResponseType[] = [
  'message',
  'defer',
  'defer-update',
  'update',
  'autocomplete',
  'modal',
];

const CALLBACK_MATRIX: readonly {
  readonly kind: string;
  readonly accepted: readonly InteractionResponseType[];
  readonly rejected: readonly InteractionResponseType[];
}[] = [
  {
    kind: 'command',
    accepted: ['message', 'defer', 'modal'],
    rejected: ['update', 'defer-update', 'autocomplete'],
  },
  {
    kind: 'component',
    accepted: ['message', 'defer', 'defer-update', 'update', 'modal'],
    rejected: ['autocomplete'],
  },
  {
    kind: 'autocomplete',
    accepted: ['autocomplete'],
    rejected: ['message', 'defer', 'defer-update', 'update', 'modal'],
  },
  // modal-submit update/defer-update: modal origin is not yet modeled / not certified. The rows
  // below pin the current simulator policy (accepted), not an official Discord rejection rule.
  {
    kind: 'modal-submit',
    accepted: ['message', 'defer', 'defer-update', 'update'],
    rejected: ['autocomplete', 'modal'],
  },
];

describe('bug 1: initial callback matrix per interaction kind', () => {
  for (const { kind, accepted, rejected } of CALLBACK_MATRIX) {
    for (const responseType of accepted) {
      it(`accepts ${responseType} for ${kind} interactions`, () => {
        const { engine } = createEngine();
        const interaction = engine.create({ type: kind });
        const data = responseType === 'autocomplete' ? { choices: [] } : {};
        const responded = engine.respond(interaction.id, responseType, data);
        expect(responded.initialResponse?.type).toBe(responseType);
        expect(responded.status).toBe(
          responseType === 'defer' || responseType === 'defer-update' ? 'deferred' : 'responded',
        );
      });
    }
    for (const responseType of rejected) {
      it(`rejects ${responseType} for ${kind} interactions without changing state`, () => {
        const { engine } = createEngine();
        const interaction = engine.create({ type: kind });
        const before = snapshot(engine, interaction.id);
        expectApiError(() => engine.respond(interaction.id, responseType, {}), 400, 50035);
        expect(snapshot(engine, interaction.id)).toEqual(before);
        expect(engine.require(interaction.id).status).toBe('pending');
      });
    }
  }

  it('treats the default interaction kind as an application command', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    expect(interaction.type).toBe('command');
    expectApiError(() => engine.respond(interaction.id, 'update', { content: 'x' }), 400, 50035);
    expectApiError(() => engine.respond(interaction.id, 'defer-update'), 400, 50035);
  });

  it('still allows a legal callback after a rejected command update', () => {
    const { engine } = createEngine();
    const interaction = engine.create({ type: 'command' });
    expectApiError(() => engine.respond(interaction.id, 'update', { content: 'x' }), 400, 50035);
    expect(engine.respond(interaction.id, 'message', { content: 'ok' }).status).toBe('responded');
  });

  it('covers every engine callback name in the matrix for modeled kinds', () => {
    for (const { kind, accepted, rejected } of CALLBACK_MATRIX) {
      const covered = new Set([...accepted, ...rejected]);
      const missing = ALL_CALLBACKS.filter((callback) => !covered.has(callback));
      expect({ kind, missing }).toEqual({ kind, missing: [] });
    }
  });
});

describe('interaction kind labels (simulator input validation)', () => {
  const UNKNOWN_LABELS = [
    'ping',
    'button',
    'select',
    'string-select',
    'modal',
    'Command',
    'unknown',
  ];

  for (const label of UNKNOWN_LABELS) {
    for (const responseType of ALL_CALLBACKS) {
      it(`rejects ${responseType} for the unmodeled ${label} label without changing state`, () => {
        const { engine } = createEngine();
        const interaction = engine.create({ type: label });
        const before = snapshot(engine, interaction.id);
        const data = responseType === 'autocomplete' ? { choices: [] } : { content: 'x' };
        expectApiError(() => engine.respond(interaction.id, responseType, data), 400, 50035);
        expect(snapshot(engine, interaction.id)).toEqual(before);
        expect(engine.require(interaction.id).status).toBe('pending');
        expect(engine.require(interaction.id).initialResponse).toBeUndefined();
      });
    }
  }

  it('keeps answering the four modeled kinds', () => {
    const { engine } = createEngine();
    const cases: readonly [string, InteractionResponseType][] = [
      ['command', 'message'],
      ['component', 'update'],
      ['autocomplete', 'autocomplete'],
      ['modal-submit', 'message'],
    ];
    for (const [kind, responseType] of cases) {
      const interaction = engine.create({ type: kind });
      const data = responseType === 'autocomplete' ? { choices: [] } : {};
      expect(engine.respond(interaction.id, responseType, data).status).toBe('responded');
    }
  });
});

describe('bug 2: deleted original response', () => {
  it('does not revive a deleted original through editOriginal', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'original' });
    engine.deleteOriginal(interaction.id);
    const before = snapshot(engine, interaction.id);
    expect(before.interaction.status).toBe('deleted');

    expectApiError(() => engine.editOriginal(interaction.id, { content: 'revived' }), 404, 10008);

    const after = snapshot(engine, interaction.id);
    expect(after).toEqual(before);
    expect(after.interaction.status).toBe('deleted');
    expect(after.interaction.initialResponse?.data).toEqual({ content: 'original' });
    expect(after.retainedBytes).toBe(serializedTotal(engine));
  });

  it('does not revive a deleted deferred original', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'defer');
    engine.deleteOriginal(interaction.id);
    const before = snapshot(engine, interaction.id);
    expectApiError(() => engine.editOriginal(interaction.id, { content: 'late' }), 404, 10008);
    expect(snapshot(engine, interaction.id)).toEqual(before);
  });

  it('rejects deleting an already deleted original without changing state', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'original' });
    engine.deleteOriginal(interaction.id);
    const before = snapshot(engine, interaction.id);
    expectApiError(() => engine.deleteOriginal(interaction.id), 404, 10008);
    expect(snapshot(engine, interaction.id)).toEqual(before);
  });

  it('keeps follow-up ability after the original is deleted while the token is valid', () => {
    const { clock, engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'original' });
    const earlier = engine.followup(interaction.id, { content: 'before delete' });
    engine.deleteOriginal(interaction.id);

    const later = engine.followup(interaction.id, { content: 'after delete' });
    expect(later.deleted).toBe(false);
    const edited = engine.editFollowup(interaction.id, earlier.id, { content: 'edited' });
    expect(edited.data).toEqual({ content: 'edited' });
    engine.deleteFollowup(interaction.id, later.id);
    const current = engine.require(interaction.id);
    expect(current.status).toBe('deleted');
    expect(current.followups.map((followup) => followup.deleted)).toEqual([false, true]);
    expect(engine.retainedByteCount()).toBe(serializedTotal(engine));

    clock.advanceBy(900_000);
    expectApiError(() => engine.followup(interaction.id, { content: 'expired' }), 404, 10015);
  });
});

describe('bug 3: PATCH merge contract for the original response', () => {
  it('keeps unspecified fields', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hello',
      embeds: [{ title: 'one' }],
      components: [{ type: 1, components: [] }],
    });
    const edited = engine.editOriginal(interaction.id, { content: 'changed' });
    expect(edited.initialResponse?.data).toEqual({
      content: 'changed',
      embeds: [{ title: 'one' }],
      components: [{ type: 1, components: [] }],
    });
    expect(edited.status).toBe('responded');
    expect(engine.retainedByteCount()).toBe(serializedTotal(engine));
  });

  it('replaces a provided field as a whole instead of deep-merging it', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hello',
      embeds: [{ title: 'one' }, { title: 'two' }],
    });
    const edited = engine.editOriginal(interaction.id, { embeds: [{ description: 'only' }] });
    expect(edited.initialResponse?.data).toEqual({
      content: 'hello',
      embeds: [{ description: 'only' }],
    });
  });

  it('clears a field set to explicit null and keeps the others', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'hello', embeds: [{ title: 'one' }] });
    const edited = engine.editOriginal(interaction.id, { content: null });
    expect(edited.initialResponse?.data).toEqual({ embeds: [{ title: 'one' }] });
    expect(Object.hasOwn(edited.initialResponse?.data ?? {}, 'content')).toBe(false);
  });

  it('clears a list set to an empty array and keeps the others', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hello',
      embeds: [{ title: 'one' }],
      components: [{ type: 1, components: [] }],
    });
    const edited = engine.editOriginal(interaction.id, { embeds: [] });
    expect(edited.initialResponse?.data).toEqual({
      content: 'hello',
      embeds: [],
      components: [{ type: 1, components: [] }],
    });
  });

  it('merges onto a deferred original and keeps its ephemeral identity', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'defer', { flags: 64 });
    const edited = engine.editOriginal(interaction.id, { content: 'done' });
    expect(edited.status).toBe('responded');
    expect(edited.initialResponse?.ephemeral).toBe(true);
    expect(edited.initialResponse?.data).toEqual({ flags: 64, content: 'done' });
  });

  it('keeps the EPHEMERAL flag when the PATCH omits flags', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'secret', flags: 64 });
    const edited = engine.editOriginal(interaction.id, { content: 'still secret' });
    expect(edited.initialResponse?.ephemeral).toBe(true);
    expect(edited.initialResponse?.data).toEqual({ content: 'still secret', flags: 64 });
  });

  it('accepts a flags PATCH that keeps the ephemeral bit', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'secret', flags: 64 });
    const edited = engine.editOriginal(interaction.id, { flags: 64 | 4 });
    expect(edited.initialResponse?.ephemeral).toBe(true);
    expect(edited.initialResponse?.data).toEqual({ content: 'secret', flags: 68 });
  });

  // Simulator policy: an EPHEMERAL bit flip is ignored, other legal changes still apply, and the
  // stored flags always agree with the ephemeral identity. Expected values are hand-written.
  const FLAG_CASES: readonly {
    readonly name: string;
    readonly created: Readonly<Record<string, unknown>>;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly expected: Readonly<Record<string, unknown>>;
    readonly ephemeral: boolean;
  }[] = [
    {
      name: 'public -> 64',
      created: { content: 'public' },
      patch: { content: 'hide', flags: 64 },
      expected: { content: 'hide', flags: 0 },
      ephemeral: false,
    },
    {
      name: 'public -> 64|4',
      created: { content: 'public' },
      patch: { flags: 64 | 4 },
      expected: { content: 'public', flags: 4 },
      ephemeral: false,
    },
    {
      name: 'public -> null',
      created: { content: 'public', flags: 4 },
      patch: { flags: null },
      expected: { content: 'public' },
      ephemeral: false,
    },
    {
      name: 'private -> 0',
      created: { content: 'secret', flags: 64 },
      patch: { content: 'still secret', flags: 0 },
      expected: { content: 'still secret', flags: 64 },
      ephemeral: true,
    },
    {
      name: 'private -> null',
      created: { content: 'secret', flags: 64 },
      patch: { content: 'still secret', flags: null },
      expected: { content: 'still secret', flags: 64 },
      ephemeral: true,
    },
    {
      name: 'private -> 4',
      created: { content: 'secret', flags: 64 },
      patch: { flags: 4 },
      expected: { content: 'secret', flags: 68 },
      ephemeral: true,
    },
  ];

  for (const { name, created, patch, expected, ephemeral } of FLAG_CASES) {
    it(`ignores the EPHEMERAL flip and applies the rest for original ${name}`, () => {
      const { engine } = createEngine();
      const interaction = engine.create();
      engine.respond(interaction.id, 'message', created);
      const edited = engine.editOriginal(interaction.id, patch);
      expect(edited.initialResponse?.data).toEqual(expected);
      expect(edited.initialResponse?.ephemeral).toBe(ephemeral);
      expect(engine.retainedByteCount()).toBe(serializedTotal(engine));
    });
  }

  it('re-evaluates allowed_mentions when content is edited without allowed_mentions', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
    });
    const edited = engine.editOriginal(interaction.id, { content: 'bye <@1>' });
    expect(edited.initialResponse?.data).toEqual({ content: 'bye <@1>' });
  });

  it('re-evaluates allowed_mentions when content is cleared without allowed_mentions', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hi <@1>',
      embeds: [{ title: 'one' }],
      allowed_mentions: { parse: [] },
    });
    const edited = engine.editOriginal(interaction.id, { content: null });
    expect(edited.initialResponse?.data).toEqual({ embeds: [{ title: 'one' }] });
  });

  it('keeps stored allowed_mentions for an embeds-only edit', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
    });
    const edited = engine.editOriginal(interaction.id, { embeds: [{ title: 'e' }] });
    expect(edited.initialResponse?.data).toEqual({
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
      embeds: [{ title: 'e' }],
    });
  });

  it('uses an explicit allowed_mentions sent with a content edit', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', {
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
    });
    const edited = engine.editOriginal(interaction.id, {
      content: 'bye <@1>',
      allowed_mentions: { parse: ['users'] },
    });
    expect(edited.initialResponse?.data).toEqual({
      content: 'bye <@1>',
      allowed_mentions: { parse: ['users'] },
    });
    const cleared = engine.editOriginal(interaction.id, {
      embeds: [],
      allowed_mentions: null,
    });
    expect(cleared.initialResponse?.data).toEqual({ content: 'bye <@1>', embeds: [] });
  });

  it('applies the payload limit to the merged result and leaves no partial edit', () => {
    const { engine } = createEngine({ maxPayloadBytes: 128 });
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'a'.repeat(50) });
    const before = snapshot(engine, interaction.id);
    const patch = { embeds: [{ description: 'b'.repeat(60) }] };
    expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThan(128);
    expect(
      Buffer.byteLength(JSON.stringify({ content: 'a'.repeat(50), ...patch })),
    ).toBeGreaterThan(128);
    expect(() => engine.editOriginal(interaction.id, patch)).toThrow(InteractionCapacityError);
    expect(snapshot(engine, interaction.id)).toEqual(before);
  });

  it('applies the retained limit to the merged result and leaves no partial edit', () => {
    const merged = { content: 'a'.repeat(200), embeds: [{ description: 'b'.repeat(200) }] };
    const probe = createEngine().engine;
    const probeInteraction = probe.create();
    probe.respond(probeInteraction.id, 'message', merged);
    const mergedBytes = probe.retainedByteCount();

    const { engine } = createEngine({ maxRetainedBytesPerInteraction: mergedBytes - 1 });
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: merged.content });
    const before = snapshot(engine, interaction.id);
    expect(() => engine.editOriginal(interaction.id, { embeds: merged.embeds })).toThrow(
      InteractionCapacityError,
    );
    expect(snapshot(engine, interaction.id)).toEqual(before);
    expect(engine.retainedByteCount()).toBeLessThanOrEqual(mergedBytes - 1);
  });

  it('leaves no partial edit when the patch itself is invalid', () => {
    const { engine } = createEngine();
    const interaction = engine.create();
    engine.respond(interaction.id, 'message', { content: 'hello' });
    const before = snapshot(engine, interaction.id);
    expect(() =>
      engine.editOriginal(interaction.id, { content: 'x', embeds: [Number.NaN] }),
    ).toThrow(TypeError);
    expect(snapshot(engine, interaction.id)).toEqual(before);
  });
});

describe('bug 3: PATCH merge contract for follow-ups', () => {
  function withFollowup(
    data: Readonly<Record<string, unknown>>,
    limits: EngineLimits = {},
  ): {
    readonly engine: InteractionEngine;
    readonly interactionId: string;
    readonly followupId: string;
  } {
    const { engine } = createEngine(limits);
    const interaction = engine.create();
    engine.respond(interaction.id, 'defer');
    const followup = engine.followup(interaction.id, data);
    return { engine, interactionId: interaction.id, followupId: followup.id };
  }

  it('keeps unspecified fields, clears null, and clears empty arrays', () => {
    const { engine, interactionId, followupId } = withFollowup({
      content: 'hello',
      embeds: [{ title: 'one' }],
      components: [{ type: 1, components: [] }],
      allowed_mentions: { parse: [] },
    });
    const edited = engine.editFollowup(interactionId, followupId, {
      content: 'changed',
      components: [],
      allowed_mentions: null,
    });
    expect(edited.data).toEqual({
      content: 'changed',
      embeds: [{ title: 'one' }],
      components: [],
    });
    expect(engine.require(interactionId).followups[0]?.data).toEqual(edited.data);
    expect(engine.retainedByteCount()).toBe(serializedTotal(engine));
  });

  it('keeps the ephemeral identity of a follow-up and ignores EPHEMERAL flips', () => {
    const { engine, interactionId, followupId } = withFollowup({ content: 'secret', flags: 64 });
    const edited = engine.editFollowup(interactionId, followupId, { content: 'still secret' });
    expect(edited.ephemeral).toBe(true);
    expect(edited.data).toEqual({ content: 'still secret', flags: 64 });

    const flipped = engine.editFollowup(interactionId, followupId, { content: 'x', flags: 0 });
    expect(flipped.ephemeral).toBe(true);
    expect(flipped.data).toEqual({ content: 'x', flags: 64 });

    const nulled = engine.editFollowup(interactionId, followupId, { flags: null });
    expect(nulled.data).toEqual({ content: 'x', flags: 64 });

    const suppressed = engine.editFollowup(interactionId, followupId, { flags: 64 | 4 });
    expect(suppressed.data).toEqual({ content: 'x', flags: 68 });
    expect(engine.retainedByteCount()).toBe(serializedTotal(engine));
  });

  it('ignores an EPHEMERAL flip on a public follow-up', () => {
    const { engine, interactionId, followupId } = withFollowup({ content: 'public' });
    const edited = engine.editFollowup(interactionId, followupId, { flags: 64 | 4 });
    expect(edited.ephemeral).toBe(false);
    expect(edited.data).toEqual({ content: 'public', flags: 4 });
    const hidden = engine.editFollowup(interactionId, followupId, { flags: 64 });
    expect(hidden.data).toEqual({ content: 'public', flags: 0 });
  });

  it('re-evaluates follow-up allowed_mentions only on content edits', () => {
    const { engine, interactionId, followupId } = withFollowup({
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
    });
    const embedsOnly = engine.editFollowup(interactionId, followupId, {
      embeds: [{ title: 'e' }],
    });
    expect(embedsOnly.data).toEqual({
      content: 'hi <@1>',
      allowed_mentions: { parse: [] },
      embeds: [{ title: 'e' }],
    });
    const contentEdit = engine.editFollowup(interactionId, followupId, { content: 'bye <@1>' });
    expect(contentEdit.data).toEqual({ content: 'bye <@1>', embeds: [{ title: 'e' }] });
    const explicit = engine.editFollowup(interactionId, followupId, {
      content: 'again <@1>',
      allowed_mentions: { parse: ['users'] },
    });
    expect(explicit.data).toEqual({
      content: 'again <@1>',
      embeds: [{ title: 'e' }],
      allowed_mentions: { parse: ['users'] },
    });
  });

  it('applies the payload limit to the merged follow-up and leaves no partial edit', () => {
    const { engine, interactionId, followupId } = withFollowup(
      { content: 'a'.repeat(50) },
      { maxPayloadBytes: 128 },
    );
    const before = snapshot(engine, interactionId);
    expect(() =>
      engine.editFollowup(interactionId, followupId, {
        embeds: [{ description: 'b'.repeat(60) }],
      }),
    ).toThrow(InteractionCapacityError);
    expect(snapshot(engine, interactionId)).toEqual(before);
  });
});
