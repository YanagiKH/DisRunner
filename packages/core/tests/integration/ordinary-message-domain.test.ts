import { afterEach, describe, expect, it } from 'vitest';
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

// Product acceptance requires the real revisioned VirtualState implementation.
// No local revision counter or legacy fallback is permitted in this suite.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Local acceptance cleanup failed.');
});
function setup(gatewayOptions: Record<string, unknown> = {}) {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 100_000 });
  const random = new SeededRandom(12);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'user', id: '10', bot: true, username: 'local-bot' },
    { resourceType: 'user', id: '11', bot: false, username: 'someone-else' },
    { resourceType: 'guild', id: '100', name: 'guild' },
    { resourceType: 'channel', id: '200', type: 0, guild_id: '100' },
    { resourceType: 'channel', id: '201', type: 0, guild_id: '100' },
    { resourceType: 'channel', id: '202', type: 1 },
    { resourceType: 'channel', id: '203' },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    botUserId: '10',
    ...gatewayOptions,
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
  });
  const rest = new LocalRestEmulator({
    state,
    interactions,
    gateway,
    rateLimits: new RateLimitEngine(clock),
    messageDomain: { runId: 'test-run', clockDomain: 'virtual' },
  });
  const ws = new LocalGatewayServer({ gateway });
  cleanup.push(
    () => rest.stop(),
    () => ws.stop(),
  );
  const service = new MessageDomainService({ state, gateway, context: { runId: 'test-run' } });
  return { clock, state, gateway, rest, ws, service };
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  const packets: Record<string, unknown>[] = [];
  socket.on('message', (bytes) =>
    packets.push(
      JSON.parse(
        (Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes)
        ).toString(),
      ) as Record<string, unknown>,
    ),
  );
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
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Expected local packet did not arrive.');
}
function request(base: string, token: string, path: string, method: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('ordinary message domain (real revisioned authority)', () => {
  it('joins real HTTP create/edit/delete to explicit WS frames with identical authority and revisions', async () => {
    const { rest, ws, gateway, state } = setup();
    const addr = await rest.start();
    const socketAddr = await ws.start();
    const { socket, packets } = await connect(socketAddr.url);
    socket.send(JSON.stringify({ op: 2, d: { token: gateway.sessionToken, intents: 512 } }));
    await until(() => packets.some((p) => p['t'] === 'READY'));
    const response = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { content: 'one' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-disrunner-state-revision')).toBe('1');
    const message = (await response.json()) as Record<string, unknown>;
    expect(message).toEqual({
      id: message['id'],
      channel_id: '200',
      guild_id: '100',
      author: { id: '10', bot: true, username: 'local-bot' },
      content: 'one',
      embeds: [],
      attachments: [],
      components: [],
      flags: 0,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      pinned: false,
      type: 0,
      timestamp: '2015-01-01T00:01:40.000Z',
      edited_timestamp: null,
    });
    expect(typeof message['id']).toBe('string');
    const id = String(message['id']);
    expect(state.revision).toBe(1);
    expect(state.require('message', id)).toEqual({
      ...message,
      resourceType: 'message',
      visibility: 'channel',
    });
    const patch = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      `/channels/200/messages/${id}`,
      'PATCH',
      { content: 'two' },
    );
    expect(patch.status).toBe(200);
    expect(patch.headers.get('x-disrunner-state-revision')).toBe('2');
    const edited = { ...message, content: 'two', edited_timestamp: '2015-01-01T00:01:40.000Z' };
    expect(await patch.json()).toEqual(edited);
    expect(state.revision).toBe(2);
    expect(state.require('message', id)).toEqual({
      ...edited,
      resourceType: 'message',
      visibility: 'channel',
    });
    const deleted = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      `/channels/200/messages/${id}`,
      'DELETE',
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('x-disrunner-state-revision')).toBe('3');
    await until(() => packets.filter((p) => String(p['t']).startsWith('MESSAGE_')).length === 3);
    expect(packets.filter((p) => String(p['t']).startsWith('MESSAGE_'))).toEqual([
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: message },
      { op: 0, t: 'MESSAGE_UPDATE', s: 3, d: edited },
      { op: 0, t: 'MESSAGE_DELETE', s: 4, d: { id, channel_id: '200', guild_id: '100' } },
    ]);
    expect(state.get('message', id)).toBeUndefined();
    expect(state.revision).toBe(3);
    expect(
      rest
        .messageEvidence()
        .records.map(({ event }) => [
          event.stateRevision,
          event.sequence,
          event.origin,
          event.runId,
        ]),
    ).toEqual([
      [1, 1, 'rest', 'test-run'],
      [2, 2, 'rest', 'test-run'],
      [3, 3, 'rest', 'test-run'],
    ]);
  });

  it('rejects wrong channel, unauthorized actor, spoofing, invalid flags and unknown context without state or events', async () => {
    const { rest, gateway, state } = setup();
    const addr = await rest.start();
    const session = gateway.identify({ token: gateway.sessionToken, intents: 512 });
    const first = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { content: 'one' },
    );
    const message = (await first.json()) as Record<string, unknown>;
    const id = String(message['id']);
    const baseline = state.snapshot();
    for (const [path, method, body, token, status] of [
      [`/channels/201/messages/${id}`, 'PATCH', { content: 'bad' }, gateway.sessionToken, 404],
      ['/channels/200/messages', 'POST', { content: 'bad' }, 'disrunner.offline.wrong', 401],
      [
        '/channels/200/messages',
        'POST',
        { content: 'bad', author: { id: '11' } },
        gateway.sessionToken,
        400,
      ],
      ['/channels/200/messages', 'POST', { content: 'bad', flags: 64 }, gateway.sessionToken, 400],
      ['/channels/200/messages', 'POST', { content: 'bad', id: '999' }, gateway.sessionToken, 400],
      [
        '/channels/200/messages',
        'POST',
        { content: 'bad', channel_id: '201' },
        gateway.sessionToken,
        400,
      ],
      [
        '/channels/200/messages',
        'POST',
        { content: 'bad', guild_id: '999' },
        gateway.sessionToken,
        400,
      ],
      ['/channels/203/messages', 'POST', { content: 'bad' }, gateway.sessionToken, 400],
    ] as const) {
      const result = await request(addr.apiBaseUrl, token, path, method, body);
      expect(result.status).toBe(status);
      expect(state.snapshot()).toEqual(baseline);
      expect(state.revision).toBe(1);
      expect(rest.messageEvidence().records).toHaveLength(1);
      expect(gateway.replay(session.sessionId, 1)).toHaveLength(1);
    }
    state.create('message', {
      id: '999',
      channel_id: '200',
      guild_id: '100',
      author: { id: '11' },
      flags: 0,
      visibility: 'channel',
    });
    const beforeDeniedDelete = state.revisionedSnapshot();
    expect(
      (await request(addr.apiBaseUrl, gateway.sessionToken, '/channels/200/messages/999', 'DELETE'))
        .status,
    ).toBe(403);
    expect(state.revisionedSnapshot()).toEqual(beforeDeniedDelete);
    expect(gateway.replay(session.sessionId, 1)).toHaveLength(1);
  });

  it('retains disconnected mutations exactly once for resume and does not broadcast generic store mutations', async () => {
    const { rest, ws, gateway, state } = setup();
    const addr = await rest.start();
    const socketAddr = await ws.start();
    const first = await connect(socketAddr.url);
    first.socket.send(JSON.stringify({ op: 2, d: { token: gateway.sessionToken, intents: 512 } }));
    await until(() => first.packets.some((p) => p['t'] === 'READY'));
    const ready = first.packets.find((p) => p['t'] === 'READY')!;
    const sessionId = (ready['d'] as Record<string, unknown>)['session_id'];
    first.socket.close();
    await until(() => gateway.session(String(sessionId))?.state === 'disconnected');
    state.create('message', { id: '901', channel_id: '200', flags: 64, content: 'private' });
    expect(gateway.replay(String(sessionId), 1)).toEqual([]);
    expect(rest.messageEvidence().records).toEqual([]);
    const created = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { content: 'offline' },
    );
    expect(created.status).toBe(200);
    expect(created.headers.get('x-disrunner-state-revision')).toBe('2');
    expect(state.revision).toBe(2);
    expect(rest.messageEvidence().records.map(({ event }) => event.stateRevision)).toEqual([2]);
    const second = await connect(socketAddr.url);
    second.socket.send(
      JSON.stringify({ op: 6, d: { token: gateway.sessionToken, session_id: sessionId, seq: 1 } }),
    );
    await until(() => second.packets.some((p) => p['t'] === 'RESUMED'));
    expect(second.packets.filter((p) => p['t'] === 'MESSAGE_CREATE')).toHaveLength(1);
    expect(
      (second.packets.find((p) => p['t'] === 'MESSAGE_CREATE')!['d'] as Record<string, unknown>)[
        'content'
      ],
    ).toBe('offline');
  });

  it('keeps committed HTTP success on transport failure; rejects reentry before mutation and reflects audience drift', async () => {
    const { rest, gateway, state } = setup();
    const addr = await rest.start();
    gateway.identify({ token: gateway.sessionToken, intents: 512 });
    let nestedStatus: unknown;
    const direct = new MessageDomainService({ state, gateway });
    const unsubscribe = state.subscribeCommits(() => {
      try {
        direct.create('200', { content: 'reenter' });
      } catch (error) {
        nestedStatus = error;
      }
      gateway.identify({ token: gateway.sessionToken, intents: 512 });
    });
    const first = direct.create('200', { content: 'outer' });
    expect(nestedStatus).toBeInstanceOf(Error);
    expect(nestedStatus).toMatchObject({
      message: 'Reentrant message commands are not supported.',
    });
    expect(state.revision).toBe(1);
    expect(first.delivery.accepted).toBe(2);
    expect(state.list('message').map((message) => message['content'])).toEqual(['outer']);
    unsubscribe();
    gateway.subscribeBroadcast(() => {
      throw new Error('secret observer failure');
    });
    const response = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { content: 'committed' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-disrunner-delivery')).toBe('partial');
    const body = (await response.json()) as Record<string, unknown>;
    expect(state.get('message', String(body['id']))).toBeDefined();
    expect(JSON.stringify(rest.messageEvidence())).not.toContain('secret observer failure');
  });

  it('preflight rejection rolls back and no-op PATCH publishes nothing; explicit DM uses direct-message intent', () => {
    const { service, gateway, state } = setup({ maxDispatchBytes: 500 });
    const session = gateway.identify({ token: gateway.sessionToken, intents: 4096 });
    const created = service.create('202', { content: 'dm' });
    expect(created.message['guild_id']).toBeUndefined();
    expect(created.delivery.accepted).toBe(1);
    const replayBeforeNoop = gateway.replay(session.sessionId, 1);
    const same = service.update('202', created.message.id, { content: 'dm' });
    expect(gateway.replay(session.sessionId, 1)).toEqual(replayBeforeNoop);
    expect(same.delivery.status).toBe('unchanged');
    expect(state.revision).toBe(1);
    const baseline = state.snapshot();
    expect(() => service.create('202', { content: 'x'.repeat(1000) })).toThrow();
    expect(state.snapshot()).toEqual(baseline);
    expect(state.revision).toBe(1);
    expect(service.evidence().records).toHaveLength(1);
  });

  it('routes explicit guild and DM messages only to their eligible intent audiences', () => {
    const { service, gateway, state } = setup();
    const guildSession = gateway.identify({ token: gateway.sessionToken, intents: 512 });
    const dmSession = gateway.identify({ token: gateway.sessionToken, intents: 4096 });
    const guildMessage = service.create('200', { content: 'guild' });
    const dmMessage = service.create('202', { content: 'dm' });
    expect(guildMessage.delivery).toMatchObject({ accepted: 1, filtered: 1 });
    expect(dmMessage.delivery).toMatchObject({ accepted: 1, filtered: 1 });
    expect(gateway.replay(guildSession.sessionId, 1)).toEqual([
      expect.objectContaining({
        t: 'MESSAGE_CREATE',
        s: 2,
        d: expect.objectContaining({
          id: guildMessage.message.id,
          channel_id: '200',
          guild_id: '100',
        }) as unknown,
      }),
    ]);
    expect(gateway.replay(dmSession.sessionId, 1)).toEqual([
      expect.objectContaining({
        t: 'MESSAGE_CREATE',
        s: 2,
        d: expect.objectContaining({ id: dmMessage.message.id, channel_id: '202' }) as unknown,
      }),
    ]);
    expect(gateway.replay(dmSession.sessionId, 1)[0]?.d).not.toHaveProperty('guild_id');
    expect(state.revision).toBe(2);
  });

  it('rejects caller-owned transactions before mutation, even when the caller catches the rejection', () => {
    const { state, service, gateway } = setup();
    const session = gateway.identify({ token: gateway.sessionToken, intents: 512 });
    const before = state.snapshot();
    state.transaction('external', () => {
      expect(() => service.create('200', { content: 'uncommitted' })).toThrow('outermost');
    });
    expect(state.snapshot()).toEqual(before);
    expect(() =>
      state.transaction('rollback', () => {
        expect(() => service.create('200', { content: 'also-uncommitted' })).toThrow('outermost');
        throw new Error('caller rollback');
      }),
    ).toThrow('caller rollback');
    expect(state.snapshot()).toEqual(before);
    expect(state.revision).toBe(0);
    expect(gateway.replay(session.sessionId, 1)).toEqual([]);
    expect(service.evidence().records).toEqual([]);
  });

  it('uses identical read representations and fails closed private message reads', async () => {
    const { rest, state, gateway } = setup();
    const addr = await rest.start();
    const response = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { content: 'visible' },
    );
    const created = (await response.json()) as Record<string, unknown>;
    const read = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      `/channels/200/messages/${String(created['id'])}`,
      'GET',
    );
    expect(await read.json()).toEqual(created);
    state.create('message', {
      id: '903',
      channel_id: '200',
      guild_id: '100',
      flags: 64,
      content: 'hidden',
      author: { id: '10' },
      visibility: 'channel',
    });
    state.create('message', {
      id: '904',
      channel_id: '200',
      guild_id: '100',
      flags: 0,
      content: 'unknown',
      author: { id: '10' },
    });
    const beforePrivateAttempts = state.revisionedSnapshot();
    for (const id of ['903', '904']) {
      expect(
        (
          await request(
            addr.apiBaseUrl,
            gateway.sessionToken,
            `/channels/200/messages/${id}`,
            'GET',
          )
        ).status,
      ).toBe(404);
      for (const method of ['PATCH', 'DELETE']) {
        const result = await request(
          addr.apiBaseUrl,
          gateway.sessionToken,
          `/channels/200/messages/${id}`,
          method,
          method === 'PATCH' ? { content: 'publish-private' } : undefined,
        );
        expect(result.status).toBe(403);
        expect(state.revisionedSnapshot()).toEqual(beforePrivateAttempts);
        expect(rest.messageEvidence().records).toHaveLength(1);
      }
    }
    const list = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'GET',
    );
    expect(await list.json()).toEqual([created]);
  });

  it('bounds redacted event history and rejects numeric flags overflow', () => {
    const { service, gateway } = setup();
    expect(() => service.create('200', { content: 'invalid', flags: 4294967296 })).toThrow();
    for (let i = 0; i < 105; i += 1) service.create('200', { content: gateway.sessionToken });
    const evidence = service.evidence();
    expect(evidence.records).toHaveLength(100);
    expect(evidence.dropped).toBe(5);
    expect(JSON.stringify(evidence)).not.toContain(gateway.sessionToken);
    expect(evidence.records.at(-1)?.event.sequence).toBe(105);
  });

  it('deeply allowlists seeded message wire and diagnostics, including nested author metadata', async () => {
    const { state, rest, gateway } = setup();
    const addr = await rest.start();
    state.create('message', {
      id: '999',
      channel_id: '200',
      guild_id: '100',
      visibility: 'channel',
      flags: 0,
      content: 'fixture',
      internalMetadata: 'do-not-export',
      author: { id: '10', bot: true, username: 'local-bot', token: 'do-not-export' },
      embeds: [
        {
          title: 'ok',
          private: 'do-not-export',
          footer: { text: 'footer', credential: 'do-not-export' },
        },
      ],
      components: [
        {
          type: 1,
          secret: 'do-not-export',
          components: [
            { type: 2, style: 1, label: 'Go', custom_id: 'go', secret: 'do-not-export' },
          ],
        },
      ],
    });
    const session = gateway.identify({ token: gateway.sessionToken, intents: 512 });
    const read = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages/999',
      'GET',
    );
    expect(JSON.stringify(await read.json())).not.toContain('do-not-export');
    const patched = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages/999',
      'PATCH',
      { content: 'edited' },
    );
    expect(patched.status).toBe(200);
    expect(JSON.stringify(await patched.json())).not.toContain('do-not-export');
    expect(JSON.stringify(gateway.replay(session.sessionId, 1))).not.toContain('do-not-export');
    expect(JSON.stringify(rest.messageEvidence())).not.toContain('do-not-export');
    expect(state.require('message', '999')['internalMetadata']).toBe('do-not-export');
    const bad = await request(
      addr.apiBaseUrl,
      gateway.sessionToken,
      '/channels/200/messages',
      'POST',
      { embeds: [{ title: 'ok', token: 'do-not-export' }] },
    );
    expect(bad.status).toBe(400);
  });

  it('fails closed mapping ephemeral or unknown visibility', () => {
    const { service } = setup();
    service.create('200', { content: 'ok' });
    const event = service.evidence().records[0]!.event;
    expect(
      mapMessageEvent({
        ...event,
        payload: { ...event.payload, message: { ...event.payload.message, flags: 64 } },
      }),
    ).toBeUndefined();
    expect(
      mapMessageEvent({
        ...event,
        payload: { ...event.payload, message: { ...event.payload.message, visibility: 'unknown' } },
      }),
    ).toBeUndefined();
  });
});
