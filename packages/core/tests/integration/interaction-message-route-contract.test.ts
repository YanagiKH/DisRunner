import { describe, expect, it } from 'vitest';

import {
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
import type { RateLimitRule, SimulatedInteraction } from '../../src/index.js';

const APP = '111111111111111111';
const OTHER_APP = '222222222222222222';
const BOT = '333333333333333333';
const ACTOR = '444444444444444444';
const CHANNEL = '555555555555555555';
const GUILD = '666666666666666666';
const MISSING = '999999999999999999';
const NOW = 1_420_070_500_000;
const ISO = '2015-01-01T00:01:40.000Z';
const AUTHOR = { id: BOT, username: 'http-bot', discriminator: '0000', avatar: null, bot: true };
const INVALID = { code: 50035, message: 'Invalid interaction message payload.' };
const INVALID_JSON = { code: 50035, message: 'Invalid JSON body.' };
const UNKNOWN_MESSAGE = { code: 10008, message: 'Unknown message.' };
const UNSUPPORTED = { code: 0, message: 'This interaction does not support message routes.' };
const LIMITED = { message: 'You are being rate limited.', retry_after: 60, global: false };

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
  readonly headers: Headers;
}

async function startHarness(maxBodyBytes = 4096) {
  const clock = new VirtualClock({ nowMs: NOW });
  const random = new SeededRandom(4931);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'user', ...AUTHOR },
    { resourceType: 'user', id: ACTOR, username: 'actor', bot: false },
    { resourceType: 'guild', id: GUILD, name: 'guild' },
    { resourceType: 'channel', id: CHANNEL, type: 0, guild_id: GUILD },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: APP,
    botUserId: BOT,
  });
  const engine = new InteractionEngine({
    applicationId: APP,
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
    messageAuthority: { state, gateway, author: AUTHOR, context: { runId: 'http-contract' } },
  });
  const rateLimits = new RateLimitEngine(clock);
  const trace = new TraceCollector({ clock, random });
  const server = new LocalRestEmulator({
    state,
    interactions: engine,
    gateway,
    rateLimits,
    trace,
    maxBodyBytes,
    messageDomain: { runId: 'http-contract' },
  });
  const session = gateway.identify({ token: gateway.sessionToken, intents: 512 });
  const packets: unknown[] = [];
  const unsubscribe = gateway.subscribeBroadcast((_session, packet) => packets.push(packet));
  const address = await server.start();
  return {
    clock,
    state,
    gateway,
    engine,
    rateLimits,
    trace,
    server,
    session,
    packets,
    unsubscribe,
    api: address.apiBaseUrl,
  };
}
type Harness = Awaited<ReturnType<typeof startHarness>>;

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await startHarness();
  try {
    await run(h);
  } finally {
    h.unsubscribe();
    await h.server.stop();
    expect(h.server.address).toBeUndefined();
    await expect(fetch(`${h.api}/gateway`)).rejects.toThrow();
  }
}

function create(h: Harness, model = false): SimulatedInteraction {
  return h.engine.create({
    type: 'command',
    data: { type: 1, name: 'echo' },
    ...(model ? {} : { messageProfile: 'chat-input-messages-v1' as const }),
    context: { actorId: ACTOR, channelId: CHANNEL, guildId: GUILD },
  });
}
const base = (i: SimulatedInteraction): string => `/webhooks/${APP}/${encodeURIComponent(i.token)}`;
const callback = (i: SimulatedInteraction): string =>
  `/interactions/${i.id}/${encodeURIComponent(i.token)}/callback`;
const original = (i: SimulatedInteraction): string => `${base(i)}/messages/@original`;
const item = (i: SimulatedInteraction, id: string): string => `${base(i)}/messages/${id}`;

async function request(
  h: Harness,
  method: string,
  path: string,
  options: { body?: unknown; raw?: string; bot?: boolean } = {},
): Promise<Reply> {
  const body =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const response = await fetch(`${h.api}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.bot ? { Authorization: `Bot ${h.gateway.sessionToken}` } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

function expectReply(reply: Reply, status: number, body: unknown): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toEqual(body);
  if (status === 204) expect(reply.text).toBe('');
}
function messageId(reply: Reply): string {
  const id = (reply.body as Record<string, unknown>)['id'];
  expect(id).toMatch(/^[1-9]\d+$/);
  return id as string;
}
/** Handwritten wire schema: no production projector or captured body supplies this oracle. */
function message(id: string, content: string, type = 20, flags = 0, edited: string | null = null) {
  return {
    id,
    application_id: APP,
    webhook_id: APP,
    channel_id: CHANNEL,
    guild_id: GUILD,
    content,
    flags,
    timestamp: ISO,
    edited_timestamp: edited,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type,
    author: AUTHOR,
    embeds: [],
    attachments: [],
    components: [],
    mentions: [],
    mention_roles: [],
  };
}
function snapshot(h: Harness) {
  return {
    revision: h.state.revision,
    resources: h.state.list(),
    interactions: h.engine.list(),
    bytes: h.engine.retainedByteCount(),
    evidence: h.server.messageEvidence(),
    packets: structuredClone(h.packets),
  };
}
function noEventHeaders(reply: Reply): void {
  for (const name of ['event-id', 'state-revision', 'delivery', 'delivery-failures'])
    expect(reply.headers.get(`x-disrunner-${name}`)).toBeNull();
}
async function acknowledge(
  h: Harness,
  i: SimulatedInteraction,
  data: unknown = { content: 'original' },
): Promise<void> {
  expectReply(await request(h, 'POST', callback(i), { body: { type: 4, data } }), 204, undefined);
}
function rule(id: string, method: string, route: string, limit = 1): RateLimitRule {
  return { id, method, route, limit, windowMs: 60_000 };
}

describe('literal interaction HTTP contract', () => {
  it('rejects unsupported followup and item queries before mutation or model profile501', async () => {
    await withHarness(async (h) => {
      for (const model of [false, true]) {
        const i = create(h, model);
        await acknowledge(h, i);
        const followup = await request(h, 'POST', base(i), { body: { content: 'followup' } });
        const id = messageId(followup);
        for (const query of [
          '?wait=true',
          '?with_response=true',
          '?private-query-marker=private-value',
          '?&',
          '?x=1&x=2',
        ]) {
          const routes: [string, string][] = [
            ['GET', original(i)],
            ['PATCH', original(i)],
            ['DELETE', original(i)],
            ['GET', item(i, id)],
            ['PATCH', item(i, id)],
            ['DELETE', item(i, id)],
            ...(model ? [] : [['POST', base(i)] as [string, string]]),
          ];
          for (const [method, path] of routes) {
            const before = snapshot(h);
            const reply = await request(h, method, path + query, {
              ...(method === 'PATCH' || method === 'POST'
                ? { body: { content: 'must-not-commit' } }
                : {}),
            });
            expectReply(reply, 400, INVALID);
            noEventHeaders(reply);
            expect(snapshot(h)).toEqual(before);
          }
        }
      }
      expect(JSON.stringify(h.trace.spans())).not.toContain('private-');
    });
  });

  for (const type of [4, 5]) {
    for (const query of ['', '?with_response=false', '?with_response=true']) {
      it(`returns the exact callback type${type} envelope for query ${query || 'absent'}`, async () => {
        await withHarness(async (h) => {
          const i = create(h);
          const reply = await request(h, 'POST', callback(i) + query, {
            body: { type, ...(type === 4 ? { data: { content: 'hello' } } : {}) },
          });
          const read = await request(h, 'GET', original(i));
          const id = messageId(read);
          expect(id).not.toBe(i.id);
          expectReply(read, 200, message(id, type === 4 ? 'hello' : '', 20, type === 5 ? 128 : 0));
          if (query === '?with_response=true') {
            expectReply(reply, 200, {
              interaction: {
                id: i.id,
                type: 2,
                response_message_id: id,
                response_message_loading: type === 5,
                response_message_ephemeral: false,
              },
              ...(type === 4 ? { resource: { type: 4, message: message(id, 'hello') } } : {}),
            });
          } else expectReply(reply, 204, undefined);
          expect(h.state.revision).toBe(1);
          expect(h.server.messageEvidence().records).toHaveLength(type === 4 ? 1 : 0);
          if (type === 5) noEventHeaders(reply);
          expect(reply.text + JSON.stringify([...reply.headers])).not.toContain(i.token);
        });
      });
    }
  }

  it('performs literal original and followup CRUD, no-op, and token-scoped ownership', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      const other = create(h);
      await acknowledge(h, i);
      await acknowledge(h, other);
      const read = await request(h, 'GET', original(i));
      const oid = messageId(read);
      expectReply(read, 200, message(oid, 'original'));
      const before = snapshot(h);
      const noop = await request(h, 'PATCH', original(i), { body: { content: 'original' } });
      expectReply(noop, 200, message(oid, 'original'));
      noEventHeaders(noop);
      expect(snapshot(h)).toEqual(before);
      h.clock.advanceBy(1000);
      const edited = '2015-01-01T00:01:41.000Z';
      expectReply(
        await request(h, 'PATCH', original(i), { body: { content: 'edited' } }),
        200,
        message(oid, 'edited', 20, 0, edited),
      );
      const follow = await request(h, 'POST', base(i), { body: { content: 'followup' } });
      const fid = messageId(follow);
      const expectedFollowup = { ...message(fid, 'followup', 0), timestamp: edited };
      expectReply(follow, 200, expectedFollowup);
      expect(fid).not.toBe(oid);
      expectReply(await request(h, 'GET', item(i, fid)), 200, expectedFollowup);
      for (const path of [item(other, fid), item(i, oid)]) {
        for (const method of ['GET', 'PATCH', 'DELETE']) {
          const saved = snapshot(h);
          expectReply(
            await request(h, method, path, {
              ...(method === 'PATCH' ? { body: { content: 'cross-token' } } : {}),
            }),
            404,
            UNKNOWN_MESSAGE,
          );
          expect(snapshot(h)).toEqual(saved);
        }
      }
      expectReply(await request(h, 'PATCH', item(i, fid), { body: { content: null } }), 200, {
        ...expectedFollowup,
        content: '',
        edited_timestamp: edited,
      });
      for (const path of [original(i), item(i, fid)]) {
        expectReply(await request(h, 'DELETE', path), 204, undefined);
        for (const method of ['GET', 'PATCH', 'DELETE'])
          expectReply(
            await request(h, method, path, {
              ...(method === 'PATCH' ? { body: { content: 'no-resurrection' } } : {}),
            }),
            404,
            UNKNOWN_MESSAGE,
          );
      }
      const afterDelete = await request(h, 'POST', base(i), { body: { content: 'still allowed' } });
      expectReply(afterDelete, 200, {
        ...message(messageId(afterDelete), 'still allowed', 0),
        timestamp: edited,
      });
    });
  });

  it('materializes the stable deferred original through first followup, then creates a distinct followup', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      expectReply(await request(h, 'POST', callback(i), { body: { type: 5 } }), 204, undefined);
      const loading = await request(h, 'GET', original(i));
      const oid = messageId(loading);
      expectReply(loading, 200, message(oid, '', 20, 128));
      expectReply(await request(h, 'GET', `/channels/${CHANNEL}/messages`, { bot: true }), 200, []);
      const first = await request(h, 'POST', base(i), { body: { content: 'ready' } });
      expectReply(first, 200, message(oid, 'ready', 20, 0, ISO));
      expect(h.engine.require(i.id).followups).toEqual([]);
      expectReply(await request(h, 'GET', original(i)), 200, message(oid, 'ready', 20, 0, ISO));
      const second = await request(h, 'POST', base(i), { body: { content: 'next' } });
      expectReply(second, 200, message(messageId(second), 'next', 0));
      expect(messageId(second)).not.toBe(oid);
      expect(
        h.server
          .messageEvidence()
          .records.map(({ event }) => [
            event.sequence,
            event.payload.type,
            event.payload.message.id,
          ]),
      ).toEqual([
        [1, 'MESSAGE_CREATE', oid],
        [2, 'MESSAGE_CREATE', messageId(second)],
      ]);
    });
  });

  it('keeps ephemeral originals/followups private and omits provenance from token responses', async () => {
    await withHarness(async (h) => {
      const privateI = create(h);
      const publicI = create(h);
      const secret = 'private-body-marker';
      const response = await request(h, 'POST', callback(privateI) + '?with_response=true', {
        body: { type: 4, data: { content: secret, flags: 64 } },
      });
      const originalRead = await request(h, 'GET', original(privateI));
      const oid = messageId(originalRead);
      expectReply(response, 200, {
        interaction: {
          id: privateI.id,
          type: 2,
          response_message_id: oid,
          response_message_loading: false,
          response_message_ephemeral: true,
        },
        resource: { type: 4, message: message(oid, secret, 20, 64) },
      });
      noEventHeaders(response);
      await acknowledge(h, publicI);
      const privateFollow = await request(h, 'POST', base(publicI), {
        body: { content: secret, flags: 64 },
      });
      const fid = messageId(privateFollow);
      expectReply(privateFollow, 200, message(fid, secret, 0, 64));
      noEventHeaders(privateFollow);
      expectReply(await request(h, 'GET', item(publicI, fid)), 200, message(fid, secret, 0, 64));
      const publicFollow = await request(h, 'POST', base(privateI), {
        body: { content: 'public followup' },
      });
      expectReply(publicFollow, 200, message(messageId(publicFollow), 'public followup', 0));
      const list = await request(h, 'GET', `/channels/${CHANNEL}/messages`, { bot: true });
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      for (const id of [oid, fid]) {
        const hidden = await request(h, 'GET', `/channels/${CHANNEL}/messages/${id}`, {
          bot: true,
        });
        expect(hidden.status).toBe(404);
        expect(hidden.body).toMatchObject({ code: 10008 });
      }
      const publicEvidence = JSON.stringify({
        list: list.body,
        trace: h.trace.spans(),
        evidence: h.server.messageEvidence(),
        packets: h.packets,
        replay: h.gateway.replay(h.session.sessionId, 0),
      });
      for (const value of [secret, privateI.token, publicI.token])
        expect(publicEvidence).not.toContain(value);
    });
  });

  it('rejects callback query/wrapper/body errors without ACK, state, accounting or reflected values', async () => {
    await withHarness(async (h) => {
      const markers = ['private-wrapper-marker', 'private-nested-marker', 'private-query-marker'];
      const bodies: unknown[] = [
        null,
        [],
        4,
        'private-wrapper-marker',
        { type: '4' },
        { type: 7 },
        { type: 5, extra: markers[0] },
        ...[null, [], false, 4, 'private-wrapper-marker'].flatMap((data) => [
          { type: 4, data },
          { type: 5, data },
        ]),
        {
          type: 4,
          data: {
            content: 'hello',
            embeds: [{ title: 'safe', footer: { text: 1, private: markers[1] } }],
          },
        },
      ];
      for (const body of bodies) {
        const i = create(h);
        const before = snapshot(h);
        expectReply(await request(h, 'POST', callback(i), { body }), 400, INVALID);
        expect(snapshot(h)).toEqual(before);
      }
      for (const query of [
        '?with_response=1',
        '?with_response=TRUE',
        '?with_response',
        '?with_response=true&with_response=false',
        '?private-query-marker=value',
        '?with_response=true&extra=private-query-marker',
      ]) {
        const i = create(h);
        const before = snapshot(h);
        expectReply(
          await request(h, 'POST', callback(i) + query, {
            body: { type: 4, data: { content: 'hello' } },
          }),
          400,
          INVALID,
        );
        expect(snapshot(h)).toEqual(before);
      }
      for (const raw of ['', '{"private-wrapper-marker":', 'null false']) {
        const i = create(h);
        const before = snapshot(h);
        expectReply(await request(h, 'POST', callback(i), { raw }), 400, INVALID_JSON);
        expect(snapshot(h)).toEqual(before);
      }
      const i = create(h);
      const before = snapshot(h);
      expectReply(await request(h, 'POST', callback(i), { raw: 'x'.repeat(4097) }), 413, {
        code: 40005,
        message: 'Request entity too large.',
      });
      expect(snapshot(h)).toEqual(before);
      for (const marker of markers)
        expect(
          JSON.stringify({
            trace: h.trace.spans(),
            public: h.server.messageEvidence(),
            resources: h.state.list(),
            replay: h.gateway.replay(h.session.sessionId, 0),
          }),
        ).not.toContain(marker);
    });
  });

  it('rejects malformed followup/original bodies and reflects no submitted metadata', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      await acknowledge(h, i);
      const follow = await request(h, 'POST', base(i), { body: { content: 'followup' } });
      const routes = [
        ['POST', base(i)],
        ['PATCH', original(i)],
        ['PATCH', item(i, messageId(follow))],
      ] as const;
      for (const [method, path] of routes) {
        for (const body of [
          null,
          [],
          'private-invalid-body',
          { content: 'valid', application_id: 'private-spoof' },
          {
            content: 'valid',
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 1, label: 'one', custom_id: 'private-duplicate' },
                  { type: 2, style: 1, label: 'two', custom_id: 'private-duplicate' },
                ],
              },
            ],
          },
        ]) {
          const before = snapshot(h);
          expectReply(await request(h, method, path, { body }), 400, INVALID);
          expect(snapshot(h)).toEqual(before);
        }
        for (const raw of ['', '{"private-malformed":']) {
          const before = snapshot(h);
          expectReply(await request(h, method, path, { raw }), 400, INVALID_JSON);
          expect(snapshot(h)).toEqual(before);
        }
      }
      expect(
        JSON.stringify({
          trace: h.trace.spans(),
          evidence: h.server.messageEvidence(),
          resources: h.state.list(),
        }),
      ).not.toContain('private-');
    });
  });

  it('authenticates application/token/expiry before quotas and body parsing', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      await acknowledge(h, i);
      for (const method of ['POST', 'GET', 'PATCH', 'DELETE']) {
        h.rateLimits.configure(rule(`${method}-bare`, method, '/webhooks/:webhookId/:token'));
        h.rateLimits.configure(
          rule(`${method}-item`, method, '/webhooks/:webhookId/:token/messages/:messageId'),
        );
      }
      h.rateLimits.configure(
        rule('callback', 'POST', '/interactions/:interactionId/:token/callback'),
      );
      const routes: [string, string][] = [
        ['POST', base(i)],
        ...['GET', 'PATCH', 'DELETE'].flatMap(
          (method) =>
            [
              [method, original(i)],
              [method, item(i, MISSING)],
            ] as [string, string][],
        ),
      ];
      for (const [method, path] of routes) {
        for (const invalidPath of [
          path.replace(APP, OTHER_APP),
          path.replace(encodeURIComponent(i.token), 'disrunner.offline.unknown'),
        ]) {
          const before = snapshot(h);
          expectReply(
            await request(h, method, invalidPath + '?private-auth-query=secret', {
              ...(method === 'POST' || method === 'PATCH' ? { raw: '{private-malformed' } : {}),
            }),
            404,
            { code: 10015, message: 'Unknown webhook.' },
          );
          expect(snapshot(h)).toEqual(before);
          expect(h.rateLimits.buckets()).toEqual([]);
        }
      }
      expectReply(
        await request(h, 'POST', callback(i).replace(i.id, MISSING), { raw: '{bad' }),
        404,
        { code: 10062, message: 'Unknown interaction.' },
      );
      expectReply(
        await request(h, 'PATCH', original(i).replace(encodeURIComponent(i.token), '%e0%a4%a'), {
          raw: '{bad',
        }),
        400,
        { code: 50035, message: 'Invalid route token encoding.' },
      );
      expect(h.rateLimits.buckets()).toEqual([]);
      h.clock.advanceBy(900_000);
      const before = snapshot(h);
      for (const [method, path] of routes)
        expectReply(
          await request(h, method, path + '?private-expiry=secret', {
            ...(method === 'POST' || method === 'PATCH' ? { raw: '{bad' } : {}),
          }),
          404,
          { code: 10015, message: 'Unknown webhook.' },
        );
      expectReply(await request(h, 'POST', callback(i), { raw: '{bad' }), 404, {
        code: 10062,
        message: 'Unknown interaction.',
      });
      expect(snapshot(h)).toEqual(before);
      expect(h.rateLimits.buckets()).toEqual([]);
      expect(JSON.stringify(h.trace.spans())).not.toContain('private-');
    });
  });

  it('charges authenticated invalid input, then rejects quota before body/query/profile checks', async () => {
    await withHarness(async (h) => {
      for (const model of [false, true]) {
        const i = create(h, model);
        await acknowledge(h, i);
        h.rateLimits.configure(
          rule('item-quota', 'PATCH', '/webhooks/:webhookId/:token/messages/:messageId'),
        );
        const before = snapshot(h);
        expectReply(
          await request(h, 'PATCH', original(i) + '?private-quota=marker', { body: {} }),
          400,
          INVALID,
        );
        expectReply(
          await request(h, 'PATCH', item(i, MISSING) + '?private-quota=marker', { raw: '{bad' }),
          429,
          LIMITED,
        );
        expect(snapshot(h)).toEqual(before);
      }
      const pending = create(h);
      h.rateLimits.configure(
        rule('callback-quota', 'POST', '/interactions/:interactionId/:token/callback'),
      );
      const before = snapshot(h);
      expectReply(await request(h, 'POST', callback(pending), { raw: '{bad' }), 400, INVALID_JSON);
      expectReply(
        await request(h, 'POST', callback(pending) + '?with_response=bad', {
          body: { type: 4, data: { content: 'no' } },
        }),
        429,
        LIMITED,
      );
      expect(snapshot(h)).toEqual(before);
    });
  });

  it('preserves method and token buckets on suffixes, with nonmajor item IDs and no bare-route alias', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      const other = create(h);
      await acknowledge(h, i);
      await acknowledge(h, other);
      const ids: string[] = [];
      for (const content of ['one', 'two'])
        ids.push(messageId(await request(h, 'POST', base(i), { body: { content } })));
      for (const method of ['GET', 'PATCH', 'DELETE'])
        h.rateLimits.configure(rule(`old-bare-${method}`, method, '/webhooks/:webhookId/:token'));
      for (let n = 0; n < 2; n++) expect((await request(h, 'GET', original(i))).status).toBe(200);
      expect(h.rateLimits.buckets()).toEqual([]);
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        h.rateLimits.configure(
          rule(`original-${method}`, method, '/webhooks/:webhookId/:token/messages/@original', 2),
        );
        h.rateLimits.configure(
          rule(`items-${method}`, method, '/webhooks/:webhookId/:token/messages/:messageId', 2),
        );
      }
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        for (const id of ids) {
          const reply = await request(h, method, item(i, id), {
            ...(method === 'PATCH' ? { body: {} } : {}),
          });
          expect(reply.status).toBe(method === 'DELETE' ? 204 : 200);
          expect(reply.headers.get('x-ratelimit-bucket')).toBe(`items-${method}`);
        }
        expectReply(
          await request(h, method, item(i, MISSING), {
            ...(method === 'PATCH' ? { raw: '{bad' } : {}),
          }),
          429,
          LIMITED,
        );
        const independent = await request(h, method, item(other, MISSING), {
          ...(method === 'PATCH' ? { body: {} } : {}),
        });
        expectReply(independent, 404, UNKNOWN_MESSAGE);
        const own = await request(h, method, original(i), {
          ...(method === 'PATCH' ? { body: {} } : {}),
        });
        expect(own.status).toBe(method === 'DELETE' ? 204 : 200);
        expect(own.headers.get('x-ratelimit-bucket')).toBe(`original-${method}`);
      }
      expect(
        h.rateLimits
          .buckets()
          .map((bucket) => bucket.ruleId)
          .sort(),
      ).toEqual([
        'items-DELETE',
        'items-DELETE',
        'items-GET',
        'items-GET',
        'items-PATCH',
        'items-PATCH',
        'original-DELETE',
        'original-GET',
        'original-PATCH',
      ]);
    });
  });

  it('keeps legacy model POST behavior and checks bounded JSON before model item profile501', async () => {
    await withHarness(async (h) => {
      const i = create(h, true);
      expectReply(
        await request(h, 'POST', callback(i) + '?with_response=legacy&ignored=1', {
          body: { type: 5, data: null, extra: true },
        }),
        204,
        undefined,
      );
      const follow = await request(h, 'POST', base(i) + '?wait=false&ignored=1', {
        body: { content: 'model' },
      });
      expectReply(follow, 200, {
        id: messageId(follow),
        data: { content: 'model' },
        atMs: NOW,
        ephemeral: false,
        deleted: false,
      });
      expect(h.state.list('message')).toEqual([]);
      for (const path of [original(i), item(i, messageId(follow))]) {
        for (const method of ['GET', 'PATCH', 'DELETE'])
          expectReply(
            await request(h, method, path, { ...(method === 'PATCH' ? { body: {} } : {}) }),
            501,
            UNSUPPORTED,
          );
        expectReply(await request(h, 'PATCH', path, { raw: '{bad' }), 400, INVALID_JSON);
      }
    });
  });

  it('acknowledges a legal modal without fabricating an original and permits later followup', async () => {
    await withHarness(async (h) => {
      const i = create(h);
      const reply = await request(h, 'POST', callback(i) + '?with_response=true', {
        body: {
          type: 9,
          data: {
            title: 'Name',
            custom_id: 'name-modal',
            components: [
              { type: 1, components: [{ type: 4, custom_id: 'name', label: 'Name', style: 1 }] },
            ],
          },
        },
      });
      expectReply(reply, 200, { interaction: { id: i.id, type: 2 } });
      noEventHeaders(reply);
      for (const method of ['GET', 'PATCH', 'DELETE'])
        expectReply(
          await request(h, method, original(i), {
            ...(method === 'PATCH' ? { body: { content: 'no' } } : {}),
          }),
          404,
          UNKNOWN_MESSAGE,
        );
      const follow = await request(h, 'POST', base(i), { body: { content: 'after modal' } });
      expectReply(follow, 200, message(messageId(follow), 'after modal', 0));
    });
  });
});
