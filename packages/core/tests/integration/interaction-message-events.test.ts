import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  DISCORD_EPOCH_MS,
  GatewayEmulator,
  InteractionEngine,
  LocalGatewayServer,
  LocalRestEmulator,
  MessageDomainService,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
  mapMessageEvent,
} from '../../src/index.js';
import type { MessageDomainEvent } from '../../src/index.js';

// Literal independent wire expectations. Never call a production projector to build an oracle.
const TIME = '2015-01-01T00:01:40.000Z';
const AUTHOR = { id: '10', username: 'local-bot', discriminator: '0', avatar: null, bot: true };
const PRIVATE = 'private-event-marker-708b';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Authority acceptance cleanup failed.');
});

function setup() {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000, mode: 'paused' });
  const random = new SeededRandom(8_126);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'user', ...AUTHOR },
    { resourceType: 'user', id: '11', username: 'actor', bot: false },
    { resourceType: 'guild', id: '100', name: 'guild' },
    { resourceType: 'channel', id: '200', type: 0, guild_id: '100' },
    { resourceType: 'channel', id: '201', type: 0, guild_id: '100' },
    { resourceType: 'channel', id: '202', type: 1 },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    botUserId: '10',
    applicationId: '99',
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
    applicationId: '99',
    messageAuthority: {
      state,
      gateway,
      author: AUTHOR,
      context: { runId: 'authority-test', clockDomain: 'virtual' },
    },
  });
  const ordinary = new MessageDomainService({
    state,
    gateway,
    author: AUTHOR,
    context: { runId: 'authority-test' },
  });
  const rest = new LocalRestEmulator({
    state,
    gateway,
    interactions,
    rateLimits: new RateLimitEngine(clock),
    messageDomain: { runId: 'authority-test' },
  });
  const ws = new LocalGatewayServer({ gateway });
  cleanup.push(
    () => rest.stop(),
    () => ws.stop(),
  );
  return { clock, state, gateway, interactions, ordinary, rest, ws };
}

function command(engine: InteractionEngine, dm = false) {
  return engine.create({
    type: 'command',
    data: { type: 1, name: 'hello' },
    messageProfile: 'chat-input-messages-v1',
    context: dm
      ? { actorId: '11', channelId: '202' }
      : { actorId: '11', channelId: '200', guildId: '100' },
  });
}

function wire(id: string, changes: Record<string, unknown> = {}) {
  return {
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
    ...changes,
  };
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected independent WebSocket packet did not arrive.');
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  const packets: Record<string, unknown>[] = [];
  socket.on('message', (bytes) => {
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : Buffer.from(bytes);
    packets.push(JSON.parse(buffer.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.terminate();
    });
  });
  return { socket, packets };
}

async function identify(url: string, gateway: GatewayEmulator, intents = 512) {
  const connected = await connect(url);
  connected.socket.send(JSON.stringify({ op: 2, d: { token: gateway.sessionToken, intents } }));
  await until(() => connected.packets.some((packet) => packet['t'] === 'READY'));
  const ready = connected.packets.find((packet) => packet['t'] === 'READY')!;
  const sessionId = String((ready['d'] as Record<string, unknown>)['session_id']);
  return { ...connected, sessionId };
}

function messageFrames(packets: readonly Record<string, unknown>[]) {
  return packets.filter((packet) => String(packet['t']).startsWith('MESSAGE_'));
}

function request(base: string, token: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('baseline-semantic authority boundary controls', () => {
  it('rejects ordinary bot mutation of a seeded interaction-owned public type-0 record', () => {
    const f = setup();
    f.state.create('message', {
      ...wire('901', { type: 0, content: 'owned followup' }),
      visibility: 'channel',
      message_origin: 'interaction',
      interaction_id: '800',
      interaction_message_kind: 'followup',
    });
    const before = f.state.revisionedSnapshot();
    for (const action of [
      () => f.ordinary.update('200', '901', { content: 'wrong mutation route' }),
      () => f.ordinary.delete('200', '901'),
    ]) {
      let error: unknown;
      try {
        action();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ status: 403 });
      expect(f.state.revisionedSnapshot()).toEqual(before);
      expect(f.ordinary.evidence().records).toEqual([]);
    }
  });

  it('allocates consecutive domain sequences for independent same-state/same-run services', () => {
    const f = setup();
    const second = new MessageDomainService({
      state: f.state,
      gateway: f.gateway,
      author: AUTHOR,
      context: { runId: 'authority-test' },
    });
    f.ordinary.create('200', { content: 'first service' });
    second.create('200', { content: 'second service' });
    f.ordinary.create('200', { content: 'first service again' });
    expect(
      f.ordinary.evidence().records.map(({ event }) => [event.sequence, event.origin]),
    ).toEqual([
      [1, 'rest'],
      [2, 'rest'],
      [3, 'rest'],
    ]);
    expect(second.evidence()).toEqual(f.ordinary.evidence());
    expect(f.state.revision).toBe(3);
  });
});

describe('authoritative interaction public event integration', () => {
  it('joins real VirtualState commits to exact independent WebSocket original/followup frames', async () => {
    const f = setup();
    const address = await f.ws.start();
    const client = await identify(address.url, f.gateway);
    const interaction = command(f.interactions);
    const created = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'hello' },
    });
    const id = created.message!.id;
    const edited = f.interactions.executeMessage({
      operation: 'edit-original',
      interactionId: interaction.id,
      data: { content: 'edited' },
    });
    const noop = f.interactions.executeMessage({
      operation: 'edit-original',
      interactionId: interaction.id,
      data: { content: 'edited' },
    });
    const followup = f.interactions.executeMessage({
      operation: 'create-followup',
      interactionId: interaction.id,
      data: { content: 'followup' },
    });
    const followupId = followup.message!.id;
    const deletedFollowup = f.interactions.executeMessage({
      operation: 'delete-followup',
      interactionId: interaction.id,
      messageId: followupId,
    });
    const deletedOriginal = f.interactions.executeMessage({
      operation: 'delete-original',
      interactionId: interaction.id,
    });
    await until(() => messageFrames(client.packets).length === 5);
    const expected = [
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: wire(id) },
      {
        op: 0,
        t: 'MESSAGE_UPDATE',
        s: 3,
        d: wire(id, { content: 'edited', edited_timestamp: TIME }),
      },
      { op: 0, t: 'MESSAGE_CREATE', s: 4, d: wire(followupId, { content: 'followup', type: 0 }) },
      {
        op: 0,
        t: 'MESSAGE_DELETE',
        s: 5,
        d: { id: followupId, channel_id: '200', guild_id: '100' },
      },
      { op: 0, t: 'MESSAGE_DELETE', s: 6, d: { id, channel_id: '200', guild_id: '100' } },
    ];
    expect(messageFrames(client.packets)).toEqual(expected);
    expect(f.gateway.replay(client.sessionId, 1)).toEqual(expected);
    expect([
      created.stateRevision,
      edited.stateRevision,
      noop.stateRevision,
      followup.stateRevision,
      deletedFollowup.stateRevision,
      deletedOriginal.stateRevision,
    ]).toEqual([1, 2, 2, 3, 4, 5]);
    expect(noop).toMatchObject({ eventId: null, delivery: null });
    expect(f.state.revision).toBe(5);
    expect(f.state.list('message')).toEqual([]);
    const publicText = JSON.stringify({
      frames: client.packets,
      replay: f.gateway.replay(client.sessionId, 0),
    });
    for (const forbidden of [
      interaction.token,
      'message_origin',
      'interaction_id',
      'interaction_message_kind',
      'recipient_id',
      'resourceType',
    ])
      expect(publicText).not.toContain(forbidden);
  });

  it('emits create only at public defer materialization and never publishes private/loading operations', async () => {
    const f = setup();
    const address = await f.ws.start();
    const client = await identify(address.url, f.gateway);
    const deferred = command(f.interactions);
    const loading = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: deferred.id,
      responseType: 'defer',
    });
    expect(loading).toMatchObject({ stateRevision: 1, eventId: null, delivery: null });
    const id = loading.message!.id;
    const privateInteraction = command(f.interactions);
    const privateOriginal = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: privateInteraction.id,
      responseType: 'message',
      data: { content: PRIVATE, flags: 64 },
    });
    f.interactions.editOriginal(privateInteraction.id, { content: `${PRIVATE}-edit` });
    const privateFollowup = f.interactions.followup(privateInteraction.id, {
      content: `${PRIVATE}-followup`,
      flags: 64,
    });
    f.interactions.deleteFollowup(privateInteraction.id, privateFollowup.id);
    f.interactions.deleteOriginal(privateInteraction.id);
    expect(privateOriginal).toMatchObject({ stateRevision: 2, eventId: null, delivery: null });
    expect(f.gateway.replay(client.sessionId, 1)).toEqual([]);
    expect(messageFrames(client.packets)).toEqual([]);
    const materialized = f.interactions.executeMessage({
      operation: 'create-followup',
      interactionId: deferred.id,
      data: { content: 'ready', tts: true, flags: 4096 },
    });
    expect(materialized.message!.id).toBe(id);
    expect(materialized.interaction.followups).toEqual([]);
    expect(materialized.stateRevision).toBe(7);
    await until(() => messageFrames(client.packets).length === 1);
    const expected = {
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id,
        channel_id: '200',
        guild_id: '100',
        author: AUTHOR,
        content: 'ready',
        flags: 4096,
        tts: true,
        type: 20,
        application_id: '99',
        webhook_id: '99',
      },
    };
    expect(messageFrames(client.packets)).toMatchObject([expected]);
    expect(f.gateway.replay(client.sessionId, 1)).toMatchObject([expected]);
    expect(JSON.stringify(client.packets)).not.toContain(PRIVATE);
    expect(JSON.stringify(f.gateway.replay(client.sessionId, 0))).not.toContain(PRIVATE);
  });

  it('retains committed public mutations once for a real reconnect/resume without leaking ephemeral data', async () => {
    const f = setup();
    const address = await f.ws.start();
    const first = await identify(address.url, f.gateway);
    first.socket.close();
    await until(() => f.gateway.session(first.sessionId)?.state === 'disconnected');
    const interaction = command(f.interactions);
    const original = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'offline' },
    });
    const id = original.message!.id;
    f.interactions.editOriginal(interaction.id, { content: 'offline edit' });
    f.interactions.followup(interaction.id, { content: PRIVATE, flags: 64 });
    const loading = command(f.interactions);
    f.interactions.respond(loading.id, 'defer');
    f.interactions.deleteOriginal(loading.id);
    const second = await connect(address.url);
    second.socket.send(
      JSON.stringify({
        op: 6,
        d: { token: f.gateway.sessionToken, session_id: first.sessionId, seq: 1 },
      }),
    );
    await until(() => second.packets.some((packet) => packet['t'] === 'RESUMED'));
    expect(messageFrames(second.packets)).toEqual([
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: wire(id, { content: 'offline' }) },
      {
        op: 0,
        t: 'MESSAGE_UPDATE',
        s: 3,
        d: wire(id, { content: 'offline edit', edited_timestamp: TIME }),
      },
    ]);
    expect(JSON.stringify(second.packets)).not.toContain(PRIVATE);
    expect(JSON.stringify(second.packets)).not.toContain(interaction.token);
    expect(f.state.revision).toBe(5);
  });

  it('shares one monotonic public domain sequence across service instances and private/no-op gaps', () => {
    const f = setup();
    const otherOrdinary = new MessageDomainService({
      state: f.state,
      gateway: f.gateway,
      author: AUTHOR,
      context: { runId: 'authority-test' },
    });
    const ordinary = f.ordinary.create('200', { content: 'ordinary' });
    const privateInteraction = command(f.interactions);
    const privateResult = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: privateInteraction.id,
      responseType: 'message',
      data: { content: PRIVATE, flags: 64 },
    });
    const publicInteraction = command(f.interactions);
    expect(() =>
      f.interactions.respond(publicInteraction.id, 'message', {
        content: 'bad',
        author: { id: PRIVATE },
      }),
    ).toThrow();
    const publicResult = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: publicInteraction.id,
      responseType: 'message',
      data: { content: 'public' },
    });
    const noop = f.interactions.executeMessage({
      operation: 'edit-original',
      interactionId: publicInteraction.id,
      data: { content: 'public' },
    });
    const ordinaryEdit = otherOrdinary.update('200', ordinary.message.id, {
      content: 'ordinary edit',
    });
    const publicEdit = f.interactions.executeMessage({
      operation: 'edit-original',
      interactionId: publicInteraction.id,
      data: { content: 'public edit' },
    });
    const tail = f.ordinary.create('200', { content: 'tail' });
    expect([
      ordinary.stateRevision,
      privateResult.stateRevision,
      publicResult.stateRevision,
      noop.stateRevision,
      ordinaryEdit.stateRevision,
      publicEdit.stateRevision,
      tail.stateRevision,
    ]).toEqual([1, 2, 3, 3, 4, 5, 6]);
    expect(privateResult).toMatchObject({ eventId: null, delivery: null });
    expect(noop).toMatchObject({ eventId: null, delivery: null });
    expect(
      f.ordinary
        .evidence()
        .records.map(({ event }) => [
          event.sequence,
          event.stateRevision,
          event.origin,
          event.runId,
        ]),
    ).toEqual([
      [1, 1, 'rest', 'authority-test'],
      [2, 3, 'interaction', 'authority-test'],
      [3, 4, 'rest', 'authority-test'],
      [4, 5, 'interaction', 'authority-test'],
      [5, 6, 'rest', 'authority-test'],
    ]);
    expect(
      otherOrdinary.evidence().records.map(({ event }) => [event.sequence, event.stateRevision]),
    ).toEqual([
      [1, 1],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ]);
    expect(f.rest.messageEvidence()).toEqual(f.ordinary.evidence());
    const interactionEvent = f.ordinary.evidence().records[1]!.event;
    expect(interactionEvent.correlationId).toBe(publicInteraction.id);
    expect(interactionEvent.eventId).toBe(publicResult.eventId);
    expect(
      new Set([
        interactionEvent.causationId,
        interactionEvent.eventId,
        publicInteraction.id,
        publicResult.message!.id,
      ]).size,
    ).toBe(4);
    expect(interactionEvent.payload.message).toEqual({
      ...wire(publicResult.message!.id, { content: 'public' }),
      resourceType: 'message',
      visibility: 'channel',
    });
    expect(JSON.stringify(f.ordinary.evidence())).not.toContain(PRIVATE);
    expect(JSON.stringify(f.ordinary.evidence())).not.toContain(publicInteraction.token);
    expect(interactionEvent.payload.message).not.toHaveProperty('interaction_id');
    const identities = [publicInteraction.id, publicResult.message!.id, publicResult.eventId];
    expect(new Set(identities).size).toBe(3);
    expect(publicResult.eventId).not.toBe(publicInteraction.token);
  });

  it('publishes only eligible guild/DM audiences and preserves original type 20 in each', async () => {
    const f = setup();
    const address = await f.ws.start();
    const guild = await identify(address.url, f.gateway, 512);
    const dm = await identify(address.url, f.gateway, 4096);
    const a = command(f.interactions);
    const b = command(f.interactions, true);
    const guildResult = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: a.id,
      responseType: 'message',
      data: { content: 'guild' },
    });
    const dmResult = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: b.id,
      responseType: 'message',
      data: { content: 'dm' },
    });
    expect(guildResult.delivery).toEqual({
      status: 'accepted',
      accepted: 1,
      filtered: 1,
      failed: 0,
      transportFailed: 0,
    });
    expect(dmResult.delivery).toEqual({
      status: 'accepted',
      accepted: 1,
      filtered: 1,
      failed: 0,
      transportFailed: 0,
    });
    await until(
      () => messageFrames(guild.packets).length === 1 && messageFrames(dm.packets).length === 1,
    );
    expect(messageFrames(guild.packets)).toEqual([
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: wire(guildResult.message!.id, { content: 'guild' }) },
    ]);
    const expectedDm: Record<string, unknown> = wire(dmResult.message!.id, {
      content: 'dm',
      channel_id: '202',
    });
    delete expectedDm['guild_id'];
    expect(messageFrames(dm.packets)).toEqual([
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: expectedDm },
    ]);
    expect(dmResult.message).not.toHaveProperty('guild_id');
  });

  it('makes public originals/followups channel-readable but rejects bot-token mutation of both', async () => {
    const f = setup();
    const address = await f.rest.start();
    const interaction = command(f.interactions);
    const original = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'hello' },
    });
    const followup = f.interactions.followup(interaction.id, { content: 'followup' });
    const privateFollowup = f.interactions.followup(interaction.id, {
      content: PRIVATE,
      flags: 64,
    });
    const expected = [
      wire(original.message!.id),
      wire(followup.id, { content: 'followup', type: 0 }),
    ];
    for (const message of expected) {
      const read = await request(
        address.apiBaseUrl,
        f.gateway.sessionToken,
        `/channels/200/messages/${message.id}`,
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(message);
      const before = f.state.revisionedSnapshot();
      for (const method of ['PATCH', 'DELETE']) {
        const rejected = await request(
          address.apiBaseUrl,
          f.gateway.sessionToken,
          `/channels/200/messages/${message.id}`,
          method,
          method === 'PATCH' ? { content: 'unauthorized route' } : undefined,
        );
        expect(rejected.status).toBe(403);
        expect(f.state.revisionedSnapshot()).toEqual(before);
      }
    }
    const list = await request(
      address.apiBaseUrl,
      f.gateway.sessionToken,
      '/channels/200/messages',
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as Record<string, unknown>[];
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining(expected));
    const hidden = await request(
      address.apiBaseUrl,
      f.gateway.sessionToken,
      `/channels/200/messages/${privateFollowup.id}`,
    );
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(listed)).not.toContain(PRIVATE);
    expect(
      f.rest
        .messageEvidence()
        .records.map(({ event }) => [event.sequence, event.origin, event.payload.message.id]),
    ).toEqual([
      [1, 'interaction', original.message!.id],
      [2, 'interaction', followup.id],
    ]);
    expect(JSON.stringify(f.rest.messageEvidence())).not.toContain(PRIVATE);
  });

  it('returns partial delivery after listener failure while actual WebSocket clients still receive committed data', async () => {
    const f = setup();
    const address = await f.ws.start();
    const a = await identify(address.url, f.gateway);
    const b = await identify(address.url, f.gateway);
    const remove = f.gateway.subscribeBroadcast(() => {
      throw new Error(PRIVATE);
    });
    const interaction = command(f.interactions);
    const result = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'hello' },
    });
    remove();
    expect(result.delivery).toEqual({
      status: 'partial',
      accepted: 2,
      filtered: 0,
      failed: 0,
      transportFailed: 2,
    });
    expect(result.stateRevision).toBe(1);
    expect(f.interactions.require(interaction.id).originalMessageId).toBe(result.message!.id);
    expect(f.state.require('message', result.message!.id)['content']).toBe('hello');
    await until(
      () => messageFrames(a.packets).length === 1 && messageFrames(b.packets).length === 1,
    );
    const expected = [{ op: 0, t: 'MESSAGE_CREATE', s: 2, d: wire(result.message!.id) }];
    expect(messageFrames(a.packets)).toEqual(expected);
    expect(messageFrames(b.packets)).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    f.ordinary.create('200', { content: 'after partial' });
    expect(
      f.ordinary.evidence().records.map(({ event }) => [event.sequence, event.origin]),
    ).toEqual([
      [1, 'interaction'],
      [2, 'rest'],
    ]);
    expect(f.ordinary.evidence().records[0]?.delivery).toEqual(result.delivery);
  });

  it('guards reentry during fanout, not just during state observers', () => {
    const f = setup();
    f.gateway.identify({ token: f.gateway.sessionToken, intents: 512 });
    const interaction = command(f.interactions);
    const nested: unknown[] = [];
    const remove = f.gateway.subscribeBroadcast(() => {
      for (const action of [
        () => f.ordinary.create('200', { content: 'nested ordinary' }),
        () => f.interactions.followup(interaction.id, { content: 'nested followup' }),
        () => f.interactions.create(),
      ]) {
        try {
          action();
          nested.push('accepted');
        } catch (error) {
          nested.push(error);
        }
      }
    });
    const result = f.interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'hello' },
    });
    remove();
    expect(nested).toHaveLength(3);
    for (const error of nested) expect(error).toBeInstanceOf(Error);
    expect(result.delivery?.status).toBe('accepted');
    expect(f.state.list('message')).toHaveLength(1);
    expect(f.interactions.require(interaction.id).followups).toEqual([]);
    expect(f.interactions.list()).toHaveLength(1);
  });

  it('does not manufacture dispatches from generic state fixtures or model callback data', async () => {
    const f = setup();
    const address = await f.ws.start();
    const client = await identify(address.url, f.gateway);
    const model = f.interactions.create();
    f.interactions.respond(model.id, 'message', { content: 'model only' });
    f.state.create('message', {
      id: '900',
      channel_id: '200',
      guild_id: '100',
      author: AUTHOR,
      content: 'fixture only',
      flags: 0,
      visibility: 'channel',
    });
    expect(f.gateway.replay(client.sessionId, 1)).toEqual([]);
    expect(messageFrames(client.packets)).toEqual([]);
    expect(f.ordinary.evidence().records).toEqual([]);
  });
});

describe('public interaction event mapping accepts a handwritten domain envelope', () => {
  function event(overrides: Record<string, unknown> = {}): MessageDomainEvent {
    return {
      schemaVersion: 1,
      runId: 'authority-test',
      eventId: 'event-1',
      sequence: 1,
      stateRevision: 3,
      correlationId: 'interaction-1',
      causationId: 'command-1',
      origin: 'interaction',
      clockDomain: 'virtual',
      timestamp: DISCORD_EPOCH_MS + 100_000,
      payload: {
        type: 'MESSAGE_CREATE',
        visibility: 'channel',
        message: {
          ...wire('900'),
          resourceType: 'message',
          visibility: 'channel',
          message_origin: 'interaction',
          interaction_id: 'interaction-1',
          interaction_message_kind: 'original',
          token: PRIVATE,
          arbitrary_fixture_field: PRIVATE,
          ...overrides,
        },
      },
    };
  }

  it('projects type-20 identity without protected provenance, tokens or arbitrary fixture fields', () => {
    expect(mapMessageEvent(event())).toEqual({ eventName: 'MESSAGE_CREATE', data: wire('900') });
    const followup = event({ type: 0, interaction_message_kind: 'followup' });
    expect(mapMessageEvent(followup)).toEqual({
      eventName: 'MESSAGE_CREATE',
      data: wire('900', { type: 0 }),
    });
  });

  it.each([
    { flags: 64, visibility: 'ephemeral', recipient_id: '11', content: PRIVATE },
    { flags: 128 },
    { flags: 192, visibility: 'ephemeral', recipient_id: '11' },
    { visibility: 'unknown' },
  ])('does not map private/loading/unknown-visibility records %#', (overrides) => {
    expect(mapMessageEvent(event(overrides))).toBeUndefined();
  });

  it('maps deletion to only id/channel/guild, not stale pre-delete content', () => {
    const source = event();
    expect(
      mapMessageEvent({ ...source, payload: { ...source.payload, type: 'MESSAGE_DELETE' } }),
    ).toEqual({
      eventName: 'MESSAGE_DELETE',
      data: { id: '900', channel_id: '200', guild_id: '100' },
    });
  });
});
