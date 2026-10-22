import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  DiscordApiError,
  GatewayEmulator,
  InteractionEngine,
  MessageDomainService,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
} from '../../src/index.js';
import type {
  GatewayEmulatorOptions,
  InteractionEngineOptions,
  ResourceRecord,
  VirtualStateOptions,
} from '../../src/index.js';

// Handwritten outcomes were frozen before this file was written. No production projection is
// used to construct expected records. These tests require the actual revisioned VirtualState.
const START = DISCORD_EPOCH_MS + 100_000;
const TIME = '2015-01-01T00:01:40.000Z';
const AUTHOR = { id: '10', username: 'local-bot', discriminator: '0', avatar: null, bot: true };
const CONTEXT = { actorId: '11', channelId: '200', guildId: '100' };
const PROFILE = 'chat-input-messages-v1' as const;
const PRIVATE = 'private-schema-marker-5f9b';

afterEach(() => vi.restoreAllMocks());

function setup(
  options: {
    readonly engine?: Partial<InteractionEngineOptions>;
    readonly gateway?: Partial<GatewayEmulatorOptions>;
    readonly state?: VirtualStateOptions;
    readonly lenient?: boolean;
  } = {},
) {
  const clock = new VirtualClock({ nowMs: START, mode: 'paused' });
  const random = new SeededRandom(4_242);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(
    clock,
    snowflakes,
    [
      { resourceType: 'user', ...AUTHOR },
      { resourceType: 'user', id: '11', username: 'actor', bot: false },
      { resourceType: 'guild', id: '100', name: 'guild' },
      { resourceType: 'channel', id: '200', type: 0, guild_id: '100' },
      { resourceType: 'channel', id: '201', type: 0, guild_id: '100' },
      { resourceType: 'channel', id: '202', type: 1 },
      { resourceType: 'channel', id: '203', type: 2, guild_id: '100' },
    ],
    options.state,
  );
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    botUserId: '10',
    applicationId: '99',
    ...options.gateway,
  });
  const risks: unknown[] = [];
  const engine = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile({ mode: options.lenient ? 'lenient' : 'strict' }),
    applicationId: '99',
    messageAuthority: { state, gateway, author: AUTHOR, context: { runId: 'authority-test' } },
    onRisk: (finding) => risks.push(finding),
    ...options.engine,
  });
  const ordinary = new MessageDomainService({
    state,
    gateway,
    author: AUTHOR,
    context: { runId: 'authority-test' },
  });
  return { clock, random, snowflakes, state, gateway, engine, ordinary, risks };
}

function command(engine: InteractionEngine, context = CONTEXT) {
  return engine.create({
    type: 'command',
    data: { type: 1, name: 'hello' },
    context,
    messageProfile: PROFILE,
  });
}

function respond(engine: InteractionEngine, interactionId: string, data: Record<string, unknown>) {
  return engine.executeMessage({
    operation: 'respond',
    interactionId,
    responseType: 'message',
    data,
  });
}

function record(
  id: string,
  interactionId: string,
  changes: Record<string, unknown> = {},
): ResourceRecord {
  return {
    resourceType: 'message',
    id,
    channel_id: '200',
    guild_id: '100',
    author: AUTHOR,
    content: 'hello',
    embeds: [],
    attachments: [],
    components: [],
    flags: 0,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    pinned: false,
    type: 20,
    timestamp: TIME,
    edited_timestamp: null,
    application_id: '99',
    webhook_id: '99',
    message_origin: 'interaction',
    interaction_id: interactionId,
    interaction_message_kind: 'original',
    visibility: 'channel',
    ...changes,
  };
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected this operation to reject.');
}

function apiError(action: () => unknown, status: number, code: number): DiscordApiError {
  const error = thrown(action);
  expect(error).toBeInstanceOf(DiscordApiError);
  expect(error).toMatchObject({ status, code });
  return error as DiscordApiError;
}

function baseline(fixture: ReturnType<typeof setup>, id: string) {
  return {
    state: fixture.state.revisionedSnapshot(),
    history: fixture.state.mutationHistory(),
    interaction: fixture.engine.require(id),
    bytes: fixture.engine.retainedByteCount(),
  };
}

function noChange(
  fixture: ReturnType<typeof setup>,
  id: string,
  before: ReturnType<typeof baseline>,
) {
  expect(baseline(fixture, id)).toEqual(before);
}

describe('authoritative profile selection and real resource identity', () => {
  it('creates one literal type-20 original and atomically acknowledges it at actual revision one', () => {
    const f = setup();
    const interaction = command(f.engine);
    expect(f.state.revision).toBe(0);
    const result = respond(f.engine, interaction.id, { content: 'hello' });
    const id = result.message!.id;
    expect(id).toMatch(/^[1-9][0-9]*$/);
    expect(id).not.toBe(interaction.id);
    expect(result.message).toEqual(record(id, interaction.id));
    expect(f.state.require('message', id)).toEqual(record(id, interaction.id));
    expect(f.engine.getOriginalMessage(interaction.id)).toEqual(record(id, interaction.id));
    expect(result.interaction).toMatchObject({
      status: 'responded',
      messageProfile: PROFILE,
      originalMessageId: id,
      acknowledgedAtMs: START,
      initialResponse: { type: 'message', ephemeral: false, data: { content: 'hello' } },
      followups: [],
    });
    expect(result.stateRevision).toBe(1);
    expect(f.state.revision).toBe(1);
    expect(result.eventId).toEqual(expect.any(String));
    expect(result.delivery).toEqual({
      status: 'accepted',
      accepted: 0,
      filtered: 0,
      failed: 0,
      transportFailed: 0,
    });
  });

  it('stores ephemeral originals only in authoritative token-readable state', () => {
    const f = setup();
    const session = f.gateway.identify({ token: f.gateway.sessionToken, intents: 512 });
    const interaction = command(f.engine);
    const result = respond(f.engine, interaction.id, { content: PRIVATE, flags: 64 });
    const expected = record(result.message!.id, interaction.id, {
      content: PRIVATE,
      flags: 64,
      visibility: 'ephemeral',
      recipient_id: '11',
    });
    expect(result.message).toEqual(expected);
    expect(f.state.require('message', result.message!.id)).toEqual(expected);
    expect(f.engine.getOriginalMessage(interaction.id)).toEqual(expected);
    expect(result).toMatchObject({ stateRevision: 1, eventId: null, delivery: null });
    expect(f.gateway.replay(session.sessionId, 1)).toEqual([]);
    expect(f.ordinary.evidence().records).toEqual([]);
  });

  it('copies context and returns detached payload/resource views hydrated from current state', () => {
    const f = setup();
    const context = { ...CONTEXT };
    const interaction = command(f.engine, context);
    context.channelId = '201';
    const result = respond(f.engine, interaction.id, {
      content: 'hello',
      embeds: [{ title: 'initial' }],
    });
    const id = result.message!.id;
    for (const view of [result.message!, f.engine.getOriginalMessage(interaction.id)]) {
      Reflect.set(view, 'content', 'caller mutation');
      const embeds = view['embeds'] as { title: string }[];
      Reflect.set(embeds[0]!, 'title', 'caller mutation');
    }
    const snapshot = f.engine.require(interaction.id);
    Reflect.set(snapshot.initialResponse!.data, 'content', 'snapshot mutation');
    expect(f.state.require('message', id)).toMatchObject({
      content: 'hello',
      channel_id: '200',
      embeds: [{ title: 'initial', type: 'rich' }],
    });
    // A direct test fixture mutation proves the engine is not retaining a second body authority.
    f.state.update('message', id, { content: 'authoritative fixture edit' });
    expect(f.engine.require(interaction.id).initialResponse?.data['content']).toBe(
      'authoritative fixture edit',
    );
    expect(f.engine.getOriginalMessage(interaction.id)['content']).toBe(
      'authoritative fixture edit',
    );
    expect(f.engine.require(interaction.id).context).toEqual(CONTEXT);
  });

  it('requires matching gateway bot/application identities at construction', () => {
    expect(() => setup({ gateway: { applicationId: '98' } })).toThrow();
    expect(() => setup({ gateway: { botUserId: '12' } })).toThrow();
    const f = setup();
    expect(f.gateway.applicationId).toBe('99');
    expect(
      () =>
        new InteractionEngine({
          clock: f.clock,
          random: f.random,
          snowflakes: f.snowflakes,
          profile: createSimulationProfile(),
          messageAuthority: {
            state: f.state,
            gateway: f.gateway,
            author: AUTHOR,
            context: { runId: 'authority-test' },
          },
        }),
    ).toThrow();
  });

  it.each([
    ['missing context', undefined, 'command', { type: 1 }],
    ['missing actor', { ...CONTEXT, actorId: '12' }, 'command', { type: 1 }],
    ['missing channel', { ...CONTEXT, channelId: '999' }, 'command', { type: 1 }],
    ['unsupported channel', { ...CONTEXT, channelId: '203' }, 'command', { type: 1 }],
    ['wrong guild', { ...CONTEXT, guildId: '101' }, 'command', { type: 1 }],
    ['guild channel without guild', { actorId: '11', channelId: '200' }, 'command', { type: 1 }],
    ['DM with guild', { ...CONTEXT, channelId: '202' }, 'command', { type: 1 }],
    ['component', CONTEXT, 'component', { type: 1 }],
    ['user context command', CONTEXT, 'command', { type: 2 }],
    ['untyped command', CONTEXT, 'command', {}],
  ] as const)('rejects authoritative creation: %s', (_label, context, type, data) => {
    const f = setup();
    const before = f.state.revisionedSnapshot();
    expect(() =>
      f.engine.create({
        messageProfile: PROFILE,
        type,
        data,
        ...(context === undefined ? {} : { context }),
      }),
    ).toThrow();
    expect(f.engine.list()).toEqual([]);
    expect(f.engine.retainedByteCount()).toBe(0);
    expect(f.state.revisionedSnapshot()).toEqual(before);
  });

  it('never silently falls back to model mode when authority was not configured', () => {
    const f = setup();
    const engine = new InteractionEngine({
      clock: f.clock,
      random: f.random,
      snowflakes: f.snowflakes,
      profile: createSimulationProfile(),
      applicationId: '99',
    });
    expect(() => command(engine)).toThrow();
    expect(engine.list()).toEqual([]);
    const model = f.engine.create();
    expect(model.messageProfile).toBeUndefined();
    apiError(() => f.engine.getOriginalMessage(model.id), 501, 0);
    apiError(() => respond(f.engine, model.id, { content: 'not authority' }), 501, 0);
    expect(
      f.engine.respond(model.id, 'message', { content: 'model' }).initialResponse?.data,
    ).toEqual({ content: 'model' });
    expect(f.engine.followup(model.id, { content: 'wrapper' })).toMatchObject({
      data: { content: 'wrapper' },
      ephemeral: false,
      deleted: false,
    });
    expect(f.state.list('message')).toEqual([]);
  });
});

describe('original, defer, followup and deletion lifecycle', () => {
  it.each([0, 64])('materializes stable deferred original with visibility flag %i', (flags) => {
    const f = setup();
    const interaction = command(f.engine);
    const deferred = f.engine.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'defer',
      data: { flags },
    });
    const id = deferred.message!.id;
    expect(deferred.message).toEqual(
      record(id, interaction.id, {
        content: '',
        flags: 128 + flags,
        visibility: flags === 64 ? 'ephemeral' : 'channel',
        ...(flags === 64 ? { recipient_id: '11' } : {}),
      }),
    );
    expect(deferred).toMatchObject({
      stateRevision: 1,
      eventId: null,
      delivery: null,
      interaction: { status: 'deferred', originalMessageId: id },
    });
    const before = baseline(f, interaction.id);
    apiError(
      () =>
        f.engine.executeMessage({
          operation: 'edit-original',
          interactionId: interaction.id,
          data: { content: null },
        }),
      400,
      50006,
    );
    noChange(f, interaction.id, before);
    const done = f.engine.executeMessage({
      operation: 'edit-original',
      interactionId: interaction.id,
      data: { content: 'ready', flags: flags === 64 ? 0 : 64 },
    });
    expect(done.message).toMatchObject({
      id,
      content: 'ready',
      flags,
      type: 20,
      visibility: flags === 64 ? 'ephemeral' : 'channel',
    });
    expect(done.stateRevision).toBe(2);
    expect(done.interaction).toMatchObject({
      status: 'responded',
      originalMessageId: id,
      followups: [],
    });
    if (flags === 64) expect(done).toMatchObject({ eventId: null, delivery: null });
    else expect(done.eventId).toEqual(expect.any(String));
  });

  it('uses first followup to materialize defer, then permits mixed visibility followups', () => {
    const f = setup();
    const interaction = command(f.engine);
    const deferred = f.engine.respond(interaction.id, 'defer', { flags: 64 });
    const id = deferred.originalMessageId!;
    const first = f.engine.executeMessage({
      operation: 'create-followup',
      interactionId: interaction.id,
      data: { content: 'materialized', flags: 4096, tts: true },
    });
    expect(first.message).toMatchObject({
      id,
      type: 20,
      flags: 4160,
      tts: true,
      visibility: 'ephemeral',
      recipient_id: '11',
    });
    expect(first.interaction.followups).toEqual([]);
    expect(first).toMatchObject({ stateRevision: 2, eventId: null, delivery: null });
    const second = f.engine.executeMessage({
      operation: 'create-followup',
      interactionId: interaction.id,
      data: { content: 'public followup' },
    });
    expect(second.message!.id).not.toBe(id);
    expect(second.message).toEqual(
      record(second.message!.id, interaction.id, {
        content: 'public followup',
        type: 0,
        interaction_message_kind: 'followup',
      }),
    );
    expect(second.interaction.followups).toHaveLength(1);
    expect(second.interaction.followups[0]).toMatchObject({
      id: second.message!.id,
      data: { content: 'public followup' },
      ephemeral: false,
      deleted: false,
    });
    expect(second.stateRevision).toBe(3);
    const third = f.engine.followup(interaction.id, { content: 'private followup', flags: 64 });
    expect(third).toMatchObject({ ephemeral: true, deleted: false });
    expect(f.engine.getFollowupMessage(interaction.id, third.id)).toMatchObject({
      type: 0,
      flags: 64,
      visibility: 'ephemeral',
      recipient_id: '11',
    });
  });

  it('allows a modal ACK without manufacturing an original, then a genuine followup', () => {
    const f = setup();
    const interaction = command(f.engine);
    const modal = f.engine.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'modal',
      data: { custom_id: 'modal', title: 'Example', components: [] },
    });
    expect(modal).toMatchObject({
      message: null,
      stateRevision: 0,
      eventId: null,
      delivery: null,
      interaction: { status: 'responded' },
    });
    expect(modal.interaction.originalMessageId).toBeUndefined();
    expect(f.state.list('message')).toEqual([]);
    apiError(() => f.engine.getOriginalMessage(interaction.id), 404, 10008);
    apiError(
      () => f.engine.editOriginal(interaction.id, { content: 'not an original' }),
      404,
      10008,
    );
    apiError(() => f.engine.deleteOriginal(interaction.id), 404, 10008);
    const followup = f.engine.followup(interaction.id, { content: 'after modal' });
    expect(f.engine.getFollowupMessage(interaction.id, followup.id)).toMatchObject({
      type: 0,
      interaction_message_kind: 'followup',
    });
    expect(f.engine.require(interaction.id).originalMessageId).toBeUndefined();
  });

  it('normalizes equivalent PATCH to a true no-op and allows clearing the final content', () => {
    const f = setup();
    const interaction = command(f.engine);
    const created = respond(f.engine, interaction.id, {
      content: 'hello',
      embeds: [{ title: 'title' }],
      flags: 64,
    });
    f.clock.advanceBy(20);
    const before = baseline(f, interaction.id);
    const same = f.engine.executeMessage({
      operation: 'edit-original',
      interactionId: interaction.id,
      data: { content: 'hello', embeds: [{ title: 'title', type: 'rich' }], flags: 0 },
    });
    expect(same).toMatchObject({
      message: created.message,
      stateRevision: 1,
      eventId: null,
      delivery: null,
    });
    noChange(f, interaction.id, before);
    const cleared = f.engine.executeMessage({
      operation: 'edit-original',
      interactionId: interaction.id,
      data: { content: null, embeds: null, components: null, attachments: null },
    });
    expect(cleared.message).toMatchObject({
      content: '',
      embeds: [],
      components: [],
      attachments: [],
      flags: 64,
      edited_timestamp: '2015-01-01T00:01:40.020Z',
    });
    expect(cleared.stateRevision).toBe(2);
  });

  it('preserves creation-only flags and tts, and strips old allowed_mentions on content replacement', () => {
    const f = setup();
    const interaction = command(f.engine);
    respond(f.engine, interaction.id, {
      content: 'hello',
      flags: 4164,
      tts: true,
      allowed_mentions: { parse: [] },
    });
    expect(f.engine.editOriginal(interaction.id, { flags: 0 }).initialResponse?.data).toMatchObject(
      { flags: 4160, tts: true, allowed_mentions: { parse: [] } },
    );
    expect(f.engine.editOriginal(interaction.id, { flags: 4 }).initialResponse?.data['flags']).toBe(
      4164,
    );
    expect(
      f.engine.editOriginal(interaction.id, { flags: null }).initialResponse?.data['flags'],
    ).toBe(4160);
    f.engine.editOriginal(interaction.id, { content: 'replaced' });
    expect(f.engine.getOriginalMessage(interaction.id)).not.toHaveProperty('allowed_mentions');
    for (const data of [{ tts: false }, { flags: 4096 }]) {
      const before = baseline(f, interaction.id);
      apiError(() => f.engine.editOriginal(interaction.id, data), 400, 50035);
      noChange(f, interaction.id, before);
    }
  });

  it('isolates item ownership, detaches followup views, clears deletion data and retains tombstones', () => {
    const f = setup();
    const a = command(f.engine);
    const b = command(f.engine);
    const original = respond(f.engine, a.id, { content: 'hello' }).message!;
    respond(f.engine, b.id, { content: 'other' });
    const followup = f.engine.followup(a.id, { content: 'followup' });
    for (const [owner, messageId] of [
      [b.id, followup.id],
      [a.id, original.id],
    ]) {
      apiError(() => f.engine.getFollowupMessage(owner!, messageId!), 404, 10008);
      apiError(() => f.engine.editFollowup(owner!, messageId!, { content: 'stolen' }), 404, 10008);
      apiError(() => f.engine.deleteFollowup(owner!, messageId!), 404, 10008);
    }
    Reflect.set(followup.data, 'content', 'caller mutation');
    expect(f.engine.getFollowupMessage(a.id, followup.id)['content']).toBe('followup');
    expect(f.engine.editFollowup(a.id, followup.id, { content: 'changed' }).data['content']).toBe(
      'changed',
    );
    expect(f.engine.getFollowupMessage(a.id, followup.id)['content']).toBe('changed');
    f.engine.deleteFollowup(a.id, followup.id);
    expect(f.engine.require(a.id).followups[0]).toMatchObject({
      id: followup.id,
      deleted: true,
      data: {},
    });
    apiError(() => f.engine.getFollowupMessage(a.id, followup.id), 404, 10008);
    apiError(
      () => f.engine.editFollowup(a.id, followup.id, { content: 'resurrection' }),
      404,
      10008,
    );
    const deleted = f.engine.executeMessage({ operation: 'delete-original', interactionId: a.id });
    expect(deleted.message).toEqual(original);
    expect(deleted.interaction).toMatchObject({
      status: 'deleted',
      originalMessageId: original.id,
      initialResponse: { data: {} },
    });
    expect(f.state.get('message', original.id)).toBeUndefined();
    apiError(() => f.engine.getOriginalMessage(a.id), 404, 10008);
    apiError(() => f.engine.editOriginal(a.id, { content: 'resurrection' }), 404, 10008);
    apiError(() => f.engine.deleteOriginal(a.id), 404, 10008);
    expect(f.engine.followup(a.id, { content: 'after deletion' }).deleted).toBe(false);
    expect(f.engine.require(a.id).originalMessageId).toBe(original.id);
  });

  it('deleting an unmaterialized loading original advances state without public delivery', () => {
    const f = setup();
    const interaction = command(f.engine);
    f.engine.respond(interaction.id, 'defer');
    const result = f.engine.executeMessage({
      operation: 'delete-original',
      interactionId: interaction.id,
    });
    expect(result).toMatchObject({ stateRevision: 2, eventId: null, delivery: null });
    expect(result.message).toMatchObject({ flags: 128, content: '' });
    expect(f.state.list('message')).toEqual([]);
  });

  it('derives authority expiry on reads without retained-accounting or risk side effects', () => {
    const f = setup();
    const acknowledged = command(f.engine);
    const pending = command(f.engine);
    const created = respond(f.engine, acknowledged.id, { content: 'durable' }).message!;
    const bytes = f.engine.retainedByteCount();
    const state = f.state.revisionedSnapshot();
    const history = f.state.mutationHistory();
    f.clock.advanceBy(3_000);
    expect(f.engine.get(pending.id)?.status).toBe('expired');
    expect(f.engine.getByToken(pending.token)?.status).toBe('expired');
    expect(f.engine.require(pending.id).status).toBe('expired');
    expect(f.engine.retainedByteCount()).toBe(bytes);
    expect(f.risks).toEqual([]);
    f.clock.advanceBy(15 * 60_000);
    expect(f.engine.get(acknowledged.id)?.status).toBe('expired');
    expect(f.engine.getByToken(acknowledged.token)?.status).toBe('expired');
    expect(f.engine.retainedByteCount()).toBe(bytes);
    expect(() => f.engine.getOriginalMessage(acknowledged.id)).toThrow();
    expect(() => f.engine.editOriginal(acknowledged.id, { content: 'too late' })).toThrow();
    expect(f.state.require('message', created.id)['content']).toBe('durable');
    expect(f.state.revisionedSnapshot()).toEqual({
      ...state,
      snapshot: { ...state.snapshot, takenAtMs: START + 903_000 },
    });
    expect(f.state.mutationHistory()).toEqual(history);
    expect(f.engine.retainedByteCount()).toBe(bytes);
  });
});

const badPayloads: readonly [string, Record<string, unknown>][] = [
  ['unknown private key', { content: 'ok', [PRIVATE]: true }],
  ['metadata id', { content: 'ok', id: '999' }],
  ['metadata author', { content: 'ok', author: { id: PRIVATE } }],
  ['metadata context', { content: 'ok', channel_id: '201' }],
  ['metadata type', { content: 'ok', type: 0 }],
  ['metadata provenance', { content: 'ok', message_origin: PRIVATE }],
  ['metadata timestamp', { content: 'ok', timestamp: TIME }],
  ['metadata mentions', { content: 'ok', mentions: [] }],
  ['numeric content', { content: 123 }],
  ['null content', { content: null }],
  ['long content', { content: 'x'.repeat(2001) }],
  ['surrogate content length', { content: '😀'.repeat(1001) }],
  ['null embeds', { content: 'ok', embeds: null }],
  ['scalar embeds', { embeds: PRIVATE }],
  ['nonobject embed', { embeds: [PRIVATE] }],
  ['null embed', { embeds: [null] }],
  ['empty embed', { embeds: [{ color: 0, type: 'rich' }] }],
  ['embed unknown key', { embeds: [{ title: 'ok', [PRIVATE]: true }] }],
  ['embed provider', { embeds: [{ title: 'ok', provider: { name: PRIVATE } }] }],
  ['embed video', { embeds: [{ title: 'ok', video: { url: 'https://example.com' } }] }],
  ['embed nonrich type', { embeds: [{ title: 'ok', type: 'article' }] }],
  ['embed empty title', { embeds: [{ title: '' }] }],
  ['embed title over limit', { embeds: [{ title: 'x'.repeat(257) }] }],
  ['embed description over limit', { embeds: [{ description: 'x'.repeat(4097) }] }],
  ['embed null footer', { embeds: [{ title: 'ok', footer: null }] }],
  ['embed footer unknown key', { embeds: [{ footer: { text: 'ok', [PRIVATE]: true } }] }],
  ['embed footer text over limit', { embeds: [{ footer: { text: 'x'.repeat(2049) } }] }],
  ['embed author name over limit', { embeds: [{ author: { name: 'x'.repeat(257) } }] }],
  [
    'embed image extra dimensions',
    { embeds: [{ image: { url: 'https://example.com', width: 1 } }] },
  ],
  ['embed image scalar', { embeds: [{ image: PRIVATE }] }],
  ['embed thumbnail null', { embeds: [{ thumbnail: null }] }],
  ['embed fractional color', { embeds: [{ title: 'ok', color: 0.5 }] }],
  ['embed high color', { embeds: [{ title: 'ok', color: 16_777_216 }] }],
  ['embed negative color', { embeds: [{ title: 'ok', color: -1 }] }],
  ['embed timestamp format', { embeds: [{ title: 'ok', timestamp: '2015-01-01T00:00:00Z' }] }],
  ['embed impossible date', { embeds: [{ title: 'ok', timestamp: '2015-02-30T00:00:00.000Z' }] }],
  ['embed fields null', { embeds: [{ title: 'ok', fields: null }] }],
  ['embed field null', { embeds: [{ fields: [null] }] }],
  ['embed field missing value', { embeds: [{ fields: [{ name: 'ok' }] }] }],
  [
    'embed field unknown key',
    { embeds: [{ fields: [{ name: 'ok', value: 'ok', [PRIVATE]: true }] }] },
  ],
  [
    'embed field nonboolean inline',
    { embeds: [{ fields: [{ name: 'ok', value: 'ok', inline: 1 }] }] },
  ],
  [
    'embed field count',
    { embeds: [{ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }] },
  ],
  ['embed count', { embeds: Array.from({ length: 11 }, () => ({ title: 'ok' })) }],
  [
    'combined embed text',
    { embeds: [{ description: 'x'.repeat(4000) }, { description: 'x'.repeat(2001) }] },
  ],
  ['relative URL', { embeds: [{ image: { url: '/private' } }] }],
  ['attachment URL', { embeds: [{ image: { url: 'attachment://private' } }] }],
  ['data URL', { embeds: [{ image: { url: `data:text/plain,${PRIVATE}` } }] }],
  ['credential URL', { embeds: [{ image: { url: `https://${PRIVATE}:secret@example.com` } }] }],
  ['whitespace URL', { embeds: [{ image: { url: 'https://example.com/white space' } }] }],
  ['nonempty attachment', { content: 'ok', attachments: [{ id: '1', filename: PRIVATE }] }],
  ['numeric tts', { content: 'ok', tts: 1 }],
  ['server loading flag', { content: 'ok', flags: 128 }],
  ['negative flags', { content: 'ok', flags: -1 }],
  ['fractional flags', { content: 'ok', flags: 0.5 }],
  ['unsafe integer flags', { content: 'ok', flags: Number.MAX_SAFE_INTEGER + 1 }],
  ['large bit flags', { content: 'ok', flags: 4_294_967_296 }],
  ['broad mentions', { content: 'ok', allowed_mentions: { parse: ['users'] } }],
  ['extra mention fields', { content: 'ok', allowed_mentions: { parse: [], users: [] } }],
  ['null create mentions', { content: 'ok', allowed_mentions: null }],
  ['null components', { content: 'ok', components: null }],
  ['row nonobject', { components: [PRIVATE] }],
  ['row no buttons', { components: [{ type: 1, components: [] }] }],
  [
    'row unknown key',
    {
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go' }],
          [PRIVATE]: true,
        },
      ],
    },
  ],
  [
    'select menu',
    { components: [{ type: 1, components: [{ type: 3, custom_id: PRIVATE, options: [] }] }] },
  ],
  [
    'emoji button',
    {
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Go', custom_id: 'go', emoji: { name: PRIVATE } },
          ],
        },
      ],
    },
  ],
  [
    'premium button',
    {
      components: [{ type: 1, components: [{ type: 2, style: 6, label: 'Go', custom_id: 'go' }] }],
    },
  ],
  [
    'button numeric style',
    {
      components: [
        { type: 1, components: [{ type: 2, style: '1', label: 'Go', custom_id: 'go' }] },
      ],
    },
  ],
  [
    'button nonboolean disabled',
    {
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go', disabled: 0 }] },
      ],
    },
  ],
  [
    'button missing label',
    { components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'go' }] }] },
  ],
  [
    'button label over limit',
    {
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'x'.repeat(81), custom_id: 'go' }] },
      ],
    },
  ],
  [
    'button id over limit',
    {
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'x'.repeat(101) }] },
      ],
    },
  ],
  [
    'interactive button URL',
    {
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Go', custom_id: 'go', url: 'https://example.com' },
          ],
        },
      ],
    },
  ],
  [
    'link button custom id',
    {
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: 'Go', custom_id: 'go', url: 'https://example.com' },
          ],
        },
      ],
    },
  ],
  [
    'link button missing URL',
    { components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Go' }] }] },
  ],
  [
    'message-wide duplicate custom id',
    {
      components: [1, 2].map(() => ({
        type: 1,
        components: [{ type: 2, style: 1, label: 'Go', custom_id: PRIVATE }],
      })),
    },
  ],
];

describe('strict bounded data-only authoritative validation', () => {
  it.each(badPayloads)(
    'rejects %s without ACK, state, accounting or private-marker leakage',
    (_label, data) => {
      const f = setup({ lenient: true });
      const session = f.gateway.identify({ token: f.gateway.sessionToken, intents: 512 });
      const interaction = command(f.engine);
      const before = baseline(f, interaction.id);
      const error = apiError(() => respond(f.engine, interaction.id, data), 400, 50035);
      expect(error.message).toBe('Invalid interaction message payload.');
      noChange(f, interaction.id, before);
      expect(
        JSON.stringify({
          error: error.toJSON(),
          state: f.state.snapshot(),
          interaction: f.engine.require(interaction.id),
          risks: f.risks,
          replay: f.gateway.replay(session.sessionId, 0),
          evidence: f.ordinary.evidence(),
        }),
      ).not.toContain(PRIVATE);
      expect(f.gateway.replay(session.sessionId, 1)).toEqual([]);
    },
  );

  it.each([
    {},
    { content: '' },
    { embeds: [] },
    { components: [] },
    { content: '', embeds: [], components: [] },
  ])('rejects empty create data %#', (data) => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    apiError(() => respond(f.engine, interaction.id, data), 400, 50006);
    noChange(f, interaction.id, before);
  });

  it.each([null, [], PRIVATE, 42, true])('rejects a non-object callback data value %#', (value) => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    for (const responseType of ['message', 'defer', 'modal'] as const) {
      apiError(
        () =>
          f.engine.executeMessage({
            operation: 'respond',
            interactionId: interaction.id,
            responseType,
            data: value as never,
          }),
        400,
        50035,
      );
      noChange(f, interaction.id, before);
    }
  });

  it('rejects cyclic, accessor and non-JSON values without invoking a submitted getter', () => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    const cyclic: Record<string, unknown> = { content: 'ok' };
    cyclic['self'] = cyclic;
    let invoked = false;
    const accessor = Object.defineProperty({}, 'content', {
      enumerable: true,
      get: () => {
        invoked = true;
        return PRIVATE;
      },
    });
    for (const payload of [
      cyclic,
      accessor,
      { content: undefined },
      { content: () => PRIVATE },
      { content: 1n },
    ]) {
      const error = apiError(() => respond(f.engine, interaction.id, payload), 400, 50035);
      expect(error.message).toBe('Invalid interaction message payload.');
      noChange(f, interaction.id, before);
    }
    expect(invoked).toBe(false);
  });

  it.each([
    { content: 'not defer' },
    { embeds: [] },
    { flags: 4 },
    { flags: 4096 },
    { flags: null },
  ])('rejects unsupported defer data %# before ACK', (data) => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    apiError(() => f.engine.respond(interaction.id, 'defer', data), 400, 50035);
    noChange(f, interaction.id, before);
  });

  it('accepts exact nested schemas, normalizes rich type and preserves original accepted URLs', () => {
    const f = setup();
    const interaction = command(f.engine);
    const embed = {
      title: 'title',
      description: 'description',
      url: 'HTTPS://example.com/a%2Fb',
      timestamp: TIME,
      color: 16_777_215,
      footer: { text: 'footer', icon_url: 'https://example.com/f' },
      author: { name: 'author', url: 'https://example.com/a', icon_url: 'https://example.com/i' },
      image: { url: 'https://example.com/image' },
      thumbnail: { url: 'http://example.com/thumb' },
      fields: [{ name: 'field', value: 'value', inline: false }],
    };
    const components = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Go', custom_id: 'a', disabled: false },
          { type: 2, style: 5, label: 'Open', url: 'https://example.com' },
        ],
      },
    ];
    const result = respond(f.engine, interaction.id, {
      content: '😀'.repeat(1000),
      embeds: [embed],
      components,
      attachments: [],
      tts: true,
      flags: 4100,
      allowed_mentions: { parse: [] },
    });
    expect(result.message).toEqual(
      record(result.message!.id, interaction.id, {
        content: '😀'.repeat(1000),
        embeds: [{ ...embed, type: 'rich' }],
        components,
        tts: true,
        flags: 4100,
        allowed_mentions: { parse: [] },
      }),
    );
  });

  it.each([
    ['button', 512, 513],
    ['embed', 2048, 2049],
  ] as const)('enforces the independent %s URL boundary', (kind, accepted, rejected) => {
    const f = setup();
    const prefix = 'https://example.com/';
    const payload = (length: number) => {
      const url = prefix + 'x'.repeat(length - prefix.length);
      return kind === 'button'
        ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open', url }] }] }
        : { embeds: [{ image: { url } }] };
    };
    const valid = command(f.engine);
    expect(() => respond(f.engine, valid.id, payload(accepted))).not.toThrow();
    const invalid = command(f.engine);
    const before = baseline(f, invalid.id);
    apiError(() => respond(f.engine, invalid.id, payload(rejected)), 400, 50035);
    noChange(f, invalid.id, before);
  });

  it('accepts all stated embed count/text boundaries without silently dropping fields', () => {
    const cases = [
      [{ title: 'x'.repeat(256), description: 'x'.repeat(4096) }],
      [{ footer: { text: 'x'.repeat(2048) }, author: { name: 'x'.repeat(256) } }],
      [{ fields: [{ name: 'x'.repeat(256), value: 'x'.repeat(1024), inline: true }] }],
      [{ fields: Array.from({ length: 25 }, () => ({ name: 'n', value: 'v' })) }],
      Array.from({ length: 10 }, () => ({ title: 'x' })),
      [{ description: 'x'.repeat(4000) }, { description: 'x'.repeat(2000) }],
    ];
    for (const embeds of cases) {
      const f = setup();
      const interaction = command(f.engine);
      const result = respond(f.engine, interaction.id, { embeds });
      expect(result.message?.['embeds']).toEqual(
        embeds.map((embed) => ({ ...embed, type: 'rich' })),
      );
    }
  });

  it('accepts five rows of five unique buttons and rejects either count overflow', () => {
    const f = setup();
    const rows = Array.from({ length: 5 }, (_, row) => ({
      type: 1,
      components: Array.from({ length: 5 }, (_, col) => ({
        type: 2,
        style: 1,
        label: 'x'.repeat(80),
        custom_id: `${row}-${col}`.padEnd(100, 'x'),
      })),
    }));
    const interaction = command(f.engine);
    expect(respond(f.engine, interaction.id, { components: rows }).message?.['components']).toEqual(
      rows,
    );
    for (const components of [
      [...rows, rows[0]],
      [
        {
          type: 1,
          components: [
            ...rows[0]!.components,
            { type: 2, style: 1, label: 'extra', custom_id: 'extra' },
          ],
        },
      ],
    ]) {
      const invalid = command(f.engine);
      apiError(() => respond(f.engine, invalid.id, { components }), 400, 50035);
      expect(f.engine.require(invalid.id).status).toBe('pending');
    }
  });
});

describe('atomic authority, observers and failure rollback', () => {
  it('rejects resource capacity without ACK/accounting and recovers after the resource limit is freed', () => {
    const f = setup({ state: { maxResources: 7 } });
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    expect(() => respond(f.engine, interaction.id, { content: 'hello' })).toThrow();
    noChange(f, interaction.id, before);
    f.state.delete('channel', '203');
    expect(respond(f.engine, interaction.id, { content: 'hello' }).stateRevision).toBe(2);
  });

  it('preflights projection inside the transaction and rolls back resource plus registry on rejection', () => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    const preflight = vi.spyOn(f.gateway, 'preflightBroadcast').mockImplementationOnce(() => {
      throw new Error('injected preflight failure');
    });
    expect(() => respond(f.engine, interaction.id, { content: 'hello' })).toThrow();
    expect(preflight).toHaveBeenCalledOnce();
    noChange(f, interaction.id, before);
    expect(respond(f.engine, interaction.id, { content: 'hello' }).stateRevision).toBe(1);
    expect(f.ordinary.create('200', { content: 'ordinary' }).stateRevision).toBe(2);
    expect(
      f.ordinary.evidence().records.map(({ event }) => [event.sequence, event.origin]),
    ).toEqual([
      [1, 'interaction'],
      [2, 'rest'],
    ]);
  });

  it('restores installed ACK/references/accounting when native transaction finalization throws', () => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    const now = f.clock.now.bind(f.clock);
    let faultArmed = true;
    vi.spyOn(f.clock, 'now').mockImplementation(() => {
      // Native VirtualState finalization reads its clock after the callback has returned and
      // transactionActive becomes false, but before the revision/notifications are committed.
      if (
        faultArmed &&
        !f.state.transactionActive &&
        f.state.revision === 0 &&
        f.state.list('message').length === 1
      ) {
        faultArmed = false;
        throw new Error('injected native finalization failure');
      }
      return now();
    });
    expect(() => respond(f.engine, interaction.id, { content: 'hello' })).toThrow();
    expect(faultArmed).toBe(false);
    noChange(f, interaction.id, before);
    expect(respond(f.engine, interaction.id, { content: 'hello' }).stateRevision).toBe(1);
  });

  it('rolls back edit and delete reference candidates when their finalization fails', () => {
    for (const operation of ['edit-original', 'delete-original'] as const) {
      const f = setup();
      const interaction = command(f.engine);
      respond(f.engine, interaction.id, { content: 'hello' });
      const before = baseline(f, interaction.id);
      const now = f.clock.now.bind(f.clock);
      let fail = true;
      const spy = vi.spyOn(f.clock, 'now').mockImplementation(() => {
        const current = f.state.list('message')[0];
        if (
          fail &&
          !f.state.transactionActive &&
          f.state.revision === 1 &&
          (current === undefined || current['content'] === 'changed')
        ) {
          fail = false;
          throw new Error('injected native finalization failure');
        }
        return now();
      });
      expect(() =>
        f.engine.executeMessage(
          operation === 'edit-original'
            ? { operation, interactionId: interaction.id, data: { content: 'changed' } }
            : { operation, interactionId: interaction.id },
        ),
      ).toThrow();
      expect(fail).toBe(false);
      noChange(f, interaction.id, before);
      spy.mockRestore();
    }
  });

  it('rejects caller-owned transactions even if the caller catches the error', () => {
    const f = setup();
    const interaction = command(f.engine);
    const before = baseline(f, interaction.id);
    f.state.transaction('caller owned', () => {
      expect(() => respond(f.engine, interaction.id, { content: 'uncommitted' })).toThrow();
    });
    noChange(f, interaction.id, before);
  });

  it('commit observers see coherent ACK/reference/message and cannot reenter either domain or lifecycle', () => {
    const f = setup();
    const interaction = command(f.engine);
    const model = f.engine.create();
    f.engine.respond(model.id, 'message', { content: 'model' });
    const seen: unknown[] = [];
    const failures: unknown[] = [];
    const mutate = [
      () => f.ordinary.create('200', { content: 'reentrant ordinary' }),
      () => f.engine.followup(interaction.id, { content: 'reentrant authority' }),
      () => f.engine.followup(model.id, { content: 'reentrant model' }),
      () => f.engine.create(),
      () => f.engine.sweepExpired(),
    ];
    f.state.subscribeCommits(() => {
      const view = f.engine.require(interaction.id);
      seen.push({
        status: view.status,
        id: view.originalMessageId,
        content: f.engine.getOriginalMessage(interaction.id)['content'],
        revision: f.state.revision,
      });
      for (const action of mutate) {
        try {
          action();
          failures.push('accepted');
        } catch (error) {
          failures.push(error);
        }
      }
      throw new Error('isolated observer error');
    });
    const result = respond(f.engine, interaction.id, { content: 'hello' });
    expect(seen).toEqual([
      { status: 'responded', id: result.message!.id, content: 'hello', revision: 1 },
    ]);
    expect(failures).toHaveLength(mutate.length);
    for (const failure of failures) expect(failure).toBeInstanceOf(Error);
    expect(f.engine.list()).toHaveLength(2);
    expect(f.engine.require(model.id).followups).toEqual([]);
    expect(f.engine.require(interaction.id).followups).toEqual([]);
    expect(f.state.list('message')).toHaveLength(1);
  });

  it('blocks authority entry during ordinary notification and preserves coherent passive model reads', () => {
    const f = setup();
    const interaction = command(f.engine);
    const model = f.engine.create();
    let failure: unknown;
    let bytesBeforeRead = 0;
    let bytesAfterRead = 0;
    f.state.subscribeCommits(() => {
      f.clock.advanceBy(3_000);
      bytesBeforeRead = f.engine.retainedByteCount();
      try {
        f.engine.get(model.id);
      } catch {
        /* A guarded refreshing model read may reject. */
      }
      bytesAfterRead = f.engine.retainedByteCount();
      try {
        respond(f.engine, interaction.id, { content: 'reentry' });
      } catch (error) {
        failure = error;
      }
    });
    f.ordinary.create('200', { content: 'ordinary' });
    expect(failure).toBeInstanceOf(Error);
    expect(bytesAfterRead).toBe(bytesBeforeRead);
    expect(f.state.list('message').map((message) => message['content'])).toEqual(['ordinary']);
    expect(f.state.revision).toBe(1);
    expect(f.risks).toEqual([]);
  });

  it('preserves state and ACK after a postcommit broadcast failure and consumes exactly one sequence', () => {
    const f = setup();
    const interaction = command(f.engine);
    const broadcast = vi.spyOn(f.gateway, 'broadcast').mockImplementationOnce(() => {
      throw new Error(PRIVATE);
    });
    const result = respond(f.engine, interaction.id, { content: 'hello' });
    expect(result).toMatchObject({
      stateRevision: 1,
      delivery: { status: 'partial' },
      interaction: { status: 'responded' },
    });
    expect(f.state.require('message', result.message!.id)['content']).toBe('hello');
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(broadcast).toHaveBeenCalledOnce();
    apiError(
      () => respond(f.engine, interaction.id, { content: 'retry must not duplicate' }),
      400,
      40060,
    );
    f.ordinary.create('200', { content: 'next' });
    expect(
      f.ordinary.evidence().records.map(({ event }) => [event.sequence, event.origin]),
    ).toEqual([
      [1, 'interaction'],
      [2, 'rest'],
    ]);
    expect(f.state.list('message')).toHaveLength(2);
  });

  it('does not evict an expired candidate interaction when a retained-capacity expansion fails', () => {
    const probe = setup();
    const probeExpired = command(probe.engine);
    const initialBytes = probe.engine.retainedByteCount();
    probe.clock.advanceBy(3_000);
    const probeLive = command(probe.engine);
    const twoBytes = probe.engine.retainedByteCount();
    expect(probeExpired.id).not.toBe(probeLive.id);
    const f = setup({
      engine: { maxRetainedBytes: twoBytes + 200, maxRetainedBytesPerInteraction: 10_000 },
    });
    const expired = command(f.engine);
    expect(f.engine.retainedByteCount()).toBe(initialBytes);
    f.clock.advanceBy(3_000);
    const live = command(f.engine);
    const bytes = f.engine.retainedByteCount();
    const state = f.state.revisionedSnapshot();
    expect(() => respond(f.engine, live.id, { content: 'x'.repeat(2000) })).toThrow();
    expect(f.engine.get(expired.id)).toBeDefined();
    expect(f.engine.getByToken(expired.token)).toBeDefined();
    expect(f.engine.require(live.id).status).toBe('pending');
    expect(f.engine.retainedByteCount()).toBe(bytes);
    expect(f.state.revisionedSnapshot()).toEqual(state);
  });
});

describe('shared bounded evidence and mixed-profile capacity', () => {
  it('reclaims an effectively expired authoritative pending entry for default model creation', () => {
    const f = setup({ engine: { maxInteractions: 1 } });
    const expired = command(f.engine);
    f.clock.advanceBy(3_000);
    const model = f.engine.create();
    expect(model.messageProfile).toBeUndefined();
    expect(model.status).toBe('pending');
    expect(f.engine.get(expired.id)).toBeUndefined();
    expect(f.engine.getByToken(expired.token)).toBeUndefined();
    expect(f.engine.list()).toHaveLength(1);
    expect(f.risks).toEqual([]);
  });

  it('plans mixed-profile byte eviction atomically and retains committed messages after eviction', () => {
    const f = setup({ engine: { maxRetainedBytes: 2000, maxRetainedBytesPerInteraction: 10_000 } });
    const original = command(f.engine);
    const message = respond(f.engine, original.id, { content: 'd'.repeat(100) }).message!;
    f.clock.advanceBy(15 * 60_000);
    const model = f.engine.create();
    const beforeBytes = f.engine.retainedByteCount();
    const beforeState = f.state.revisionedSnapshot();
    expect(() => f.engine.respond(model.id, 'message', { content: 'x'.repeat(4000) })).toThrow();
    expect(f.engine.retainedByteCount()).toBe(beforeBytes);
    expect(f.engine.get(original.id)).toBeDefined();
    expect(f.engine.getByToken(original.token)).toBeDefined();
    expect(f.engine.require(model.id).status).toBe('pending');
    expect(f.state.revisionedSnapshot()).toEqual(beforeState);
    f.engine.respond(model.id, 'message', { content: 'x'.repeat(1000) });
    expect(f.engine.get(original.id)).toBeUndefined();
    expect(f.engine.getByToken(original.token)).toBeUndefined();
    expect(f.engine.require(model.id).status).toBe('responded');
    expect(f.state.require('message', message.id)).toEqual(message);
    expect(f.state.revisionedSnapshot()).toEqual(beforeState);
  });

  it('caps run registration at128 without evicting existing evidence or resetting counters', () => {
    const f = setup();
    const services = Array.from(
      { length: 129 },
      (_, index) =>
        new MessageDomainService({
          state: f.state,
          gateway: f.gateway,
          author: AUTHOR,
          context: { runId: `registered-${index}` },
        }),
    );
    for (let index = 0; index < 128; index += 1)
      services[index]!.create('200', { content: 'public' });
    const before = f.state.revisionedSnapshot();
    const evidence = services[0]!.evidence();
    const error = apiError(() => services[128]!.create('200', { content: PRIVATE }), 503, 0);
    expect(error.message).toBe('Message run registration capacity exceeded.');
    expect(f.state.revisionedSnapshot()).toEqual(before);
    expect(services[128]!.evidence()).toEqual({ records: [], dropped: 0 });
    expect(services[0]!.evidence()).toEqual(evidence);
    services[0]!.create('200', { content: 'still active' });
    expect(
      services[0]!
        .evidence()
        .records.map(({ event }) => [event.sequence, event.stateRevision, event.origin]),
    ).toEqual([
      [1, 1, 'rest'],
      [2, 129, 'rest'],
    ]);
    expect(services[127]!.evidence().records[0]?.event.sequence).toBe(1);
    expect(f.state.revision).toBe(129);
  });
});

describe('committed revision across postcommit fanout', () => {
  it('keeps the message commit revision when a listener directly changes unrelated state', () => {
    const f = setup();
    const session = f.gateway.identify({ token: f.gateway.sessionToken, intents: 512 });
    const interaction = command(f.engine);
    const unsubscribe = f.gateway.subscribeBroadcast(() => {
      f.state.create('channel', { id: '999', type: 1 });
    });
    const result = respond(f.engine, interaction.id, { content: 'hello' });
    unsubscribe();
    expect(f.state.revision).toBe(2);
    expect(result.stateRevision).toBe(1);
    expect(f.state.require('channel', '999')).toEqual({
      resourceType: 'channel',
      id: '999',
      type: 1,
    });
    expect(
      f.ordinary
        .evidence()
        .records.map(({ event }) => [
          event.sequence,
          event.stateRevision,
          event.origin,
          event.payload.type,
        ]),
    ).toEqual([[1, 1, 'interaction', 'MESSAGE_CREATE']]);
    expect(f.gateway.replay(session.sessionId, 1)).toHaveLength(1);
    expect(f.state.list('message')).toHaveLength(1);
  });
});

describe('legacy followup metadata projection', () => {
  it('uses captured commit times even when fanout advances the virtual clock', () => {
    const f = setup();
    f.gateway.identify({ token: f.gateway.sessionToken, intents: 512 });
    const immediate = command(f.engine);
    respond(f.engine, immediate.id, { content: 'initial' });
    let unsubscribe = f.gateway.subscribeBroadcast(() => {
      f.clock.advanceBy(500);
    });
    const followup = f.engine.followup(immediate.id, { content: 'followup' });
    unsubscribe();
    expect(f.clock.now()).toBe(START + 500);
    expect(followup.atMs).toBe(START);
    expect(f.engine.require(immediate.id).followups[0]?.atMs).toBe(START);
    const deferred = command(f.engine);
    f.engine.respond(deferred.id, 'defer');
    unsubscribe = f.gateway.subscribeBroadcast(() => {
      f.clock.advanceBy(500);
    });
    const materialized = f.engine.followup(deferred.id, { content: 'materialized' });
    unsubscribe();
    expect(f.clock.now()).toBe(START + 1000);
    expect(materialized.atMs).toBe(START + 500);
    expect(f.engine.require(deferred.id).initialResponse?.atMs).toBe(START + 500);
    expect(f.engine.require(deferred.id).followups).toEqual([]);
  });
});
