import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
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
  type ResourceRecord,
  type RateLimitRule,
} from '../../src/index.js';

const profile = { ordinaryMessagePermissions: 'guild-text-own-messages-v1' as const };
const denied = { code: 50013, message: 'Missing Permissions' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(): ResourceRecord[] {
  return [
    { resourceType: 'guild', id: '1000', owner_id: '9000' },
    { resourceType: 'user', id: '2000', username: 'Contract Bot', bot: true },
    { resourceType: 'member', id: '2100', guild_id: '1000', user_id: '2000', roles: ['3000'] },
    { resourceType: 'role', id: '1000', guild_id: '1000', permissions: '0', position: 0 },
    { resourceType: 'role', id: '3000', guild_id: '1000', permissions: '68608', position: 1 },
    { resourceType: 'role', id: '3001', guild_id: '1000', permissions: '0', position: 99 },
    { resourceType: 'channel', id: '4000', guild_id: '1000', type: 0, permission_overwrites: [] },
    {
      resourceType: 'message',
      id: '5000',
      channel_id: '4000',
      guild_id: '1000',
      author: { id: '2000', username: 'Contract Bot', bot: true },
      content: 'before',
      embeds: [],
      attachments: [],
      components: [],
      flags: 0,
      tts: false,
      visibility: 'channel',
      type: 0,
    },
    {
      resourceType: 'message',
      id: '5001',
      channel_id: '4000',
      guild_id: '1000',
      author: { id: '9001', username: 'Other' },
      content: 'other',
      flags: 0,
      visibility: 'channel',
      type: 0,
    },
  ];
}
function setup(
  change: (s: VirtualState) => void = () => {},
  options = profile,
  rules: readonly RateLimitRule[] = [],
) {
  const clock = new VirtualClock({ nowMs: 1700000000000 });
  const random = new SeededRandom(12);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, fixture());
  change(state);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    botUserId: '2000',
    portalEnabledPrivilegedIntents: '32768',
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
  });
  const rest = new LocalRestEmulator({
    state,
    gateway,
    interactions,
    rateLimits: new RateLimitEngine(clock, rules),
    messageDomain: { runId: 'permission-contract-v1' },
    ...options,
  });
  const service = new MessageDomainService({
    state,
    gateway,
    context: { runId: 'permission-contract-v1' },
    ...options,
  });
  const ws = new LocalGatewayServer({ gateway });
  const commits: unknown[] = [];
  state.subscribeCommits((c) => commits.push(c));
  cleanup.push(
    () => rest.stop(),
    () => ws.stop(),
  );
  return { clock, state, gateway, interactions, rest, service, ws, commits };
}
type Harness = ReturnType<typeof setup>;
function unchanged(h: Harness) {
  return {
    snapshot: h.state.snapshot(),
    revision: h.state.revision,
    history: h.state.mutationHistory(),
    evidence: h.rest.messageEvidence(),
    commits: [...h.commits],
  };
}
async function request(
  h: Harness,
  method: string,
  suffix = '',
  body?: unknown,
  token = h.gateway.sessionToken,
) {
  const address = h.rest.address ?? (await h.rest.start());
  return fetch(`${address.apiBaseUrl}/channels/4000/messages${suffix}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const role = (s: VirtualState, permissions: string) => s.update('role', '3000', { permissions });
const overwrites = (s: VirtualState, values: unknown[]) =>
  s.update('channel', '4000', { permission_overwrites: values });
const timeout = (s: VirtualState, value = '2023-11-14T22:13:21.000Z') =>
  s.update('member', '2100', { communication_disabled_until: value });
const everyoneDeny = { id: '1000', type: 0, deny: '2048', allow: '0' };
const roleAllow = { id: '3000', type: 0, deny: '0', allow: '2048' };
const combined = [
  { id: '3000', type: 0, deny: '2048', allow: '0' },
  { id: '3001', type: 0, deny: '0', allow: '2048' },
];
const vectors: { name: string; change: (s: VirtualState) => void; expected: number[] }[] = [
  { name: 'full basic grants', change: () => {}, expected: [200, 200, 200, 200, 204] },
  {
    name: 'no grants',
    change: (s) => {
      role(s, '0');
    },
    expected: [403, 403, 403, 403, 403],
  },
  {
    name: 'view alone',
    change: (s) => {
      role(s, '1024');
    },
    expected: [200, 403, 403, 200, 204],
  },
  {
    name: 'view and history',
    change: (s) => {
      role(s, '66560');
    },
    expected: [200, 200, 403, 200, 204],
  },
  {
    name: 'view and send',
    change: (s) => {
      role(s, '3072');
    },
    expected: [200, 403, 200, 200, 204],
  },
  {
    name: 'send and history without view',
    change: (s) => {
      role(s, '67584');
    },
    expected: [403, 403, 403, 403, 403],
  },
  {
    name: 'everyone denies send',
    change: (s) => {
      overwrites(s, [everyoneDeny]);
    },
    expected: [200, 200, 403, 200, 204],
  },
  {
    name: 'role overrides everyone deny',
    change: (s) => {
      overwrites(s, [everyoneDeny, roleAllow]);
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'combined role allow wins',
    change: (s) => {
      s.update('member', '2100', { roles: ['3000', '3001'] });
      overwrites(s, combined);
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'member deny wins',
    change: (s) => {
      s.update('member', '2100', { roles: ['3000', '3001'] });
      overwrites(s, [...combined, { id: '2000', type: 1, deny: '2048', allow: '0' }]);
    },
    expected: [200, 200, 403, 200, 204],
  },
  {
    name: 'member allow wins its deny',
    change: (s) => {
      s.update('member', '2100', { roles: ['3000', '3001'] });
      overwrites(s, [...combined, { id: '2000', type: 1, deny: '2048', allow: '2048' }]);
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'member denies view',
    change: (s) => {
      overwrites(s, [{ id: '2000', type: 1, deny: '1024', allow: '0' }]);
    },
    expected: [403, 403, 403, 403, 403],
  },
  {
    name: 'administrator bypass and timeout exemption',
    change: (s) => {
      role(s, '8');
      timeout(s);
      overwrites(s, [{ id: '2000', type: 1, deny: '68608', allow: '0' }]);
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'owner bypass and timeout exemption',
    change: (s) => {
      role(s, '0');
      s.update('guild', '1000', { owner_id: '2000' });
      timeout(s);
      overwrites(s, [{ id: '2000', type: 1, deny: '68608', allow: '0' }]);
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'active timeout',
    change: (s) => {
      timeout(s);
    },
    expected: [200, 200, 403, 403, 403],
  },
  {
    name: 'timeout equality expired',
    change: (s) => {
      timeout(s, '2023-11-14T22:13:20.000Z');
    },
    expected: [200, 200, 200, 200, 204],
  },
  {
    name: 'timeout does not grant history',
    change: (s) => {
      role(s, '3072');
      timeout(s);
    },
    expected: [200, 403, 403, 403, 403],
  },
  {
    name: 'high bigint grants',
    change: (s) => {
      role(s, '1125899906911232');
    },
    expected: [200, 200, 200, 200, 204],
  },
];
const operations = [
  ['GET', ''],
  ['GET', '/5000'],
  ['POST', ''],
  ['PATCH', '/5000'],
  ['DELETE', '/5000'],
] as const;
describe('opt-in ordinary guild message permissions', () => {
  for (const vector of vectors)
    for (const [index, [method, suffix]] of operations.entries()) {
      it(`${vector.name}: ${method} ${suffix || 'collection'}`, async () => {
        const h = setup(vector.change);
        const before = unchanged(h);
        const response = await request(
          h,
          method,
          suffix,
          method === 'POST'
            ? { content: 'new' }
            : method === 'PATCH'
              ? { content: 'after' }
              : undefined,
        );
        expect(response.status).toBe(vector.expected[index]);
        if (response.status === 403) {
          expect(await response.json()).toEqual(denied);
          expect(unchanged(h)).toEqual(before);
          expect(response.headers.get('x-disrunner-state-revision')).toBeNull();
        }
        if (
          index === 0 &&
          ['view alone', 'view and send', 'timeout does not grant history'].includes(vector.name)
        ) {
          expect(await response.json()).toEqual([]);
          expect(unchanged(h)).toEqual(before);
        }
      });
    }
  it('guards direct domain calls and denied no-op without allocating sequence', () => {
    const h = setup();
    const first = h.service.create('4000', { content: 'new' });
    role(h.state, '0');
    const before = unchanged(h);
    for (const action of [
      () => h.service.create('4000', { content: 'no' }),
      () => h.service.update('4000', first.message.id, { content: 'new' }),
      () => h.service.delete('4000', first.message.id),
    ])
      expect(action).toThrow('Missing Permissions');
    expect(unchanged(h)).toEqual(before);
    role(h.state, '68608');
    h.service.update('4000', first.message.id, { content: 'yes' });
    expect(h.service.evidence().records.map((r) => r.event.sequence)).toEqual([1, 2]);
  });
});

const malformed: [string, (s: VirtualState) => void][] = [
  [
    'missing guild',
    (s) => {
      s.delete('guild', '1000');
    },
  ],
  [
    'missing owner',
    (s) => {
      s.update('guild', '1000', { owner_id: null });
    },
  ],
  [
    'missing state bot',
    (s) => {
      s.delete('user', '2000');
    },
  ],
  [
    'not a bot',
    (s) => {
      s.update('user', '2000', { bot: false });
    },
  ],
  [
    'missing membership',
    (s) => {
      s.delete('member', '2100');
    },
  ],
  [
    'ambiguous membership',
    (s) => {
      s.create('member', { id: '2101', guild_id: '1000', user_id: '2000', roles: ['3000'] });
    },
  ],
  [
    'missing everyone',
    (s) => {
      s.delete('role', '1000');
    },
  ],
  [
    'missing member role',
    (s) => {
      s.delete('role', '3000');
    },
  ],
  [
    'foreign member role',
    (s) => {
      s.update('role', '3000', { guild_id: '9999' });
    },
  ],
  [
    'missing roles array',
    (s) => {
      s.update('member', '2100', { roles: null });
    },
  ],
  [
    'duplicate member role',
    (s) => {
      s.update('member', '2100', { roles: ['3000', '3000'] });
    },
  ],
  [
    'explicit everyone member role',
    (s) => {
      s.update('member', '2100', { roles: ['1000', '3000'] });
    },
  ],
  [
    'missing overwrites',
    (s) => {
      s.update('channel', '4000', { permission_overwrites: null });
    },
  ],
  [
    'duplicate overwrite',
    (s) => {
      overwrites(s, [{ ...roleAllow }, { ...roleAllow }]);
    },
  ],
  [
    'unresolved overwrite role',
    (s) => {
      overwrites(s, [{ ...roleAllow, id: '7777' }]);
    },
  ],
  [
    'malformed unrelated overwrite',
    (s) => {
      overwrites(s, [{ id: '9999', type: 1, allow: 'x', deny: '0' }]);
    },
  ],
  [
    'string overwrite type',
    (s) => {
      overwrites(s, [{ ...roleAllow, type: 'role' }]);
    },
  ],
  [
    'unknown overwrite type',
    (s) => {
      overwrites(s, [{ ...roleAllow, type: 2 }]);
    },
  ],
  [
    'numeric permissions',
    (s) => {
      s.update('role', '3000', { permissions: 1024 });
    },
  ],
  [
    'blank permissions',
    (s) => {
      role(s, '');
    },
  ],
  [
    'negative permissions',
    (s) => {
      role(s, '-1');
    },
  ],
  [
    'hex permissions',
    (s) => {
      role(s, '0x400');
    },
  ],
  [
    'noncanonical permissions',
    (s) => {
      role(s, '01024');
    },
  ],
  [
    'malformed unrelated guild role',
    (s) => {
      s.update('role', '3001', { permissions: 'bad' });
    },
  ],
  [
    'invalid timeout',
    (s) => {
      timeout(s, 'tomorrow');
    },
  ],
  [
    'noncanonical timeout',
    (s) => {
      timeout(s, '2023-11-14T22:13:21Z');
    },
  ],
  [
    'malformed guild association',
    (s) => {
      s.update('channel', '4000', { guild_id: 1000 });
    },
  ],
];
describe('fail-closed authoritative context and error ordering', () => {
  for (const [name, change] of malformed)
    for (const [method, suffix] of operations) {
      it(`${name}: ${method} ${suffix}`, async () => {
        const h = setup(change);
        const before = unchanged(h);
        const response = await request(
          h,
          method,
          suffix,
          ['POST', 'PATCH'].includes(method) ? { content: 'before' } : undefined,
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(denied);
        expect(unchanged(h)).toEqual(before);
      });
    }
  for (const bypass of ['owner', 'admin'])
    for (const [name, change] of malformed) {
      it(`validates ${name} before ${bypass} bypass`, async () => {
        const h = setup((s) => {
          if (bypass === 'owner') s.update('guild', '1000', { owner_id: '2000' });
          else role(s, '8');
          change(s);
        });
        const r = await request(h, 'POST', '', { content: 'no' });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual(denied);
      });
    }
  it('rejects invalid profile values at construction and remains independent of mode', () => {
    const h = setup();
    for (const value of [null, {}, true, 'unknown'])
      expect(
        () =>
          new MessageDomainService({
            state: h.state,
            gateway: h.gateway,
            ...({ ordinaryMessagePermissions: value } as unknown as typeof profile),
          }),
      ).toThrow(TypeError);
    role(h.state, '0');
    for (const mode of ['strict', 'lenient'] as const)
      expect(() =>
        new MessageDomainService({ state: h.state, gateway: h.gateway, mode, ...profile }).create(
          '4000',
          { content: 'no' },
        ),
      ).toThrow('Missing Permissions');
  });
  it('checks permissions before probing message existence or ownership', async () => {
    const h = setup((s) => {
      role(s, '0');
    });
    for (const method of ['GET', 'PATCH', 'DELETE'])
      for (const suffix of ['/5999', '/5001']) {
        const r = await request(
          h,
          method,
          suffix,
          method === 'PATCH' ? { content: 'x' } : undefined,
        );
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual(denied);
      }
    role(h.state, '68608');
    const missing = await request(h, 'GET', '/5999');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 10008 });
    for (const authority of ['normal', 'admin', 'owner', 'moderator']) {
      role(h.state, authority === 'admin' ? '8' : authority === 'moderator' ? '76800' : '68608');
      h.state.update('guild', '1000', { owner_id: authority === 'owner' ? '2000' : '9000' });
      for (const method of ['PATCH', 'DELETE']) {
        const r = await request(
          h,
          method,
          '/5001',
          method === 'PATCH' ? { content: 'x' } : undefined,
        );
        expect(r.status).toBe(403);
        expect(await r.json()).toMatchObject({ code: 50005 });
      }
    }
  });
  it('authorizes list before limit validation but history absence does not mask bad limits', async () => {
    const h = setup(
      (s) => {
        role(s, '0');
      },
      profile,
      [{ method: 'GET', route: '/channels/:channelId/messages', limit: 10, windowMs: 1000 }],
    );
    let r = await request(h, 'GET', '?limit=0');
    expect(r.status).toBe(403);
    role(h.state, '1024');
    r = await request(h, 'GET', '?limit=0');
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 50035 });
    r = await request(h, 'GET', '?limit=1');
    expect(await r.json()).toEqual([]);
    expect(r.headers.get('x-ratelimit-limit')).not.toBeNull();
  });
  it('gates POST TTS, not PATCH, and prevents payload identity grants', async () => {
    const h = setup();
    let r = await request(h, 'POST', '', { content: 'tts', tts: true });
    expect(await r.json()).toEqual(denied);
    r = await request(h, 'POST', '', { content: 'plain', tts: false });
    expect(r.status).toBe(200);
    role(h.state, '72704');
    r = await request(h, 'POST', '', { content: 'tts', tts: true });
    expect(r.status).toBe(200);
    role(h.state, '1024');
    r = await request(h, 'PATCH', '/5000', { tts: true });
    expect(r.status).toBe(200);
    role(h.state, '68608');
    for (const field of ['author', 'actor', 'permissions']) {
      r = await request(h, 'POST', '', { content: 'no', [field]: '9000' });
      expect(r.status).toBe(400);
    }
  });
  it('keeps bot authentication, JSON decoding and object body errors ahead of policy', async () => {
    const h = setup((s) => {
      role(s, '0');
    });
    const addr = await h.rest.start();
    for (const method of ['POST', 'PATCH']) {
      const r = await request(h, method, method === 'PATCH' ? '/5000' : '', []);
      expect(r.status).toBe(400);
    }
    for (const token of [h.gateway.sessionToken, 'invalid']) {
      const r = await fetch(`${addr.apiBaseUrl}/channels/4000/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(r.status).toBe(token === 'invalid' ? 401 : 400);
    }
  });
  it('permission denial consumes configured rate quota but invalid auth does not', async () => {
    const h = setup(
      (s) => {
        role(s, '0');
      },
      profile,
      [{ method: 'POST', route: '/channels/:channelId/messages', limit: 1, windowMs: 1000 }],
    );
    expect((await request(h, 'POST', '', { content: 'x' }, 'invalid')).status).toBe(401);
    const first = await request(h, 'POST', '', { content: 'x' });
    expect(first.status).toBe(403);
    expect(first.headers.get('x-ratelimit-limit')).toBeNull();
    role(h.state, '68608');
    const limited = await request(h, 'POST', '', { content: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('1');
    h.clock.advanceBy(1000);
    expect((await request(h, 'POST', '', { content: 'x' })).status).toBe(200);
  });
  it('does not grant from bootstrap alone or a different configured author', () => {
    const h = setup((s) => {
      s.delete('user', '2000');
    });
    expect(() =>
      new MessageDomainService({
        state: h.state,
        gateway: h.gateway,
        author: { id: '2000', username: 'x', bot: true, discriminator: '0', avatar: null },
        ...profile,
      }).create('4000', { content: 'x' }),
    ).toThrow('Missing Permissions');
    h.state.create('user', { id: '2000', bot: true });
    expect(() =>
      new MessageDomainService({
        state: h.state,
        gateway: h.gateway,
        author: { id: '9000', username: 'x', bot: true, discriminator: '0', avatar: null },
        ...profile,
      }).create('4000', { content: 'x' }),
    ).toThrow('Missing Permissions');
  });
  it('role order, overwrite order and role position do not decide allow collisions', async () => {
    for (const reverse of [false, true]) {
      const h = setup((s) => {
        s.update('member', '2100', { roles: reverse ? ['3001', '3000'] : ['3000', '3001'] });
        s.update('role', '3000', { position: 999 });
        overwrites(s, reverse ? [...combined].reverse() : combined);
      });
      expect((await request(h, 'POST', '', { content: 'ok' })).status).toBe(200);
    }
  });
});

async function websocket(h: Harness) {
  const addr = await h.ws.start();
  const socket = new WebSocket(addr.url);
  const packets: Record<string, unknown>[] = [];
  socket.on('message', (bytes) => {
    packets.push(
      JSON.parse(
        (Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes)
        ).toString(),
      ) as Record<string, unknown>,
    );
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
  socket.send(JSON.stringify({ op: 2, d: { token: h.gateway.sessionToken, intents: 33280 } }));
  await until(() => packets.some((p) => p['t'] === 'READY'));
  return { packets, messages: () => packets.filter((p) => String(p['t']).startsWith('MESSAGE_')) };
}
async function until(condition: () => boolean) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected local Gateway packet did not arrive.');
}
describe('real Gateway and live revocation boundaries', () => {
  it('joins authorized HTTP CRUD to state/evidence/WS and proves denied no-op has no sequence or revision effect', async () => {
    const h = setup();
    const ws = await websocket(h);
    let r = await request(h, 'POST', '', { content: 'created' });
    expect(r.status).toBe(200);
    const created = (await r.json()) as Record<string, unknown>;
    const messageId = created['id'] as string;
    await until(() => ws.messages().length === 1);
    const first = h.rest.messageEvidence().records[0]!;
    expect(r.headers.get('x-disrunner-event-id')).toBe(first.event.eventId);
    expect(Number(r.headers.get('x-disrunner-state-revision'))).toBe(h.state.revision);
    expect(ws.messages()[0]!['d']).toEqual(created);
    expect(h.state.require('message', messageId)).toMatchObject(created);
    role(h.state, '0');
    const before = unchanged(h);
    const packets = [...ws.packets];
    for (const [method, suffix, body] of [
      ['POST', '', { content: 'no' }],
      ['PATCH', `/${messageId}`, { content: 'created' }],
      ['DELETE', `/${messageId}`, undefined],
    ] as const) {
      r = await request(h, method, suffix, body);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(denied);
      expect(r.headers.get('x-disrunner-event-id')).toBeNull();
      expect(r.headers.get('x-disrunner-state-revision')).toBeNull();
      expect(unchanged(h)).toEqual(before);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.packets).toEqual(packets);
    role(h.state, '68608');
    const noopBefore = unchanged(h);
    r = await request(h, 'PATCH', `/${messageId}`, { content: 'created' });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-disrunner-delivery')).toBe('unchanged');
    expect(unchanged(h)).toEqual(noopBefore);
    r = await request(h, 'PATCH', `/${messageId}`, { content: 'edited' });
    const edited: unknown = await r.json();
    await until(() => ws.messages().length === 2);
    expect(ws.messages()[1]!['d']).toEqual(edited);
    r = await request(h, 'DELETE', `/${messageId}`);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    await until(() => ws.messages().length === 3);
    expect(ws.messages()[2]!['d']).toEqual({ id: messageId, channel_id: '4000', guild_id: '1000' });
    expect(h.state.get('message', messageId)).toBeUndefined();
    const records = h.rest.messageEvidence().records;
    expect(records.map((x) => x.event.sequence)).toEqual([1, 2, 3]);
    expect(records.map((x) => x.event.stateRevision)).toEqual([1, 4, 5]);
    expect(ws.messages().map((x) => x['s'])).toEqual([2, 3, 4]);
  });
  it('rechecks role, overwrite, membership, malformed context and timeout changes without rebuilding services', async () => {
    const h = setup();
    expect((await request(h, 'GET', '/5000')).status).toBe(200);
    const revoke = [
      () => role(h.state, '0'),
      () => overwrites(h.state, [{ id: '2000', type: 1, deny: '1024', allow: '0' }]),
      () => h.state.delete('member', '2100'),
      () => h.state.update('role', '3001', { permissions: 'bad' }),
      () => timeout(h.state),
    ];
    for (const change of revoke) {
      const snapshot = h.state.snapshot();
      change();
      const before = unchanged(h);
      const r = await request(h, 'PATCH', '/5000', { content: 'before' });
      expect(r.status).toBe(403);
      expect(unchanged(h)).toEqual(before);
      h.state.restore(snapshot);
      expect((await request(h, 'PATCH', '/5000', { content: 'before' })).status).toBe(200);
    }
    timeout(h.state);
    h.clock.advanceBy(1000);
    expect((await request(h, 'PATCH', '/5000', { content: 'before' })).status).toBe(200);
    role(h.state, '1024');
    expect(await (await request(h, 'GET')).json()).toEqual([]);
    expect((await request(h, 'GET', '/5000')).status).toBe(403);
    expect((await request(h, 'POST', '', { content: 'x' })).status).toBe(403);
    expect((await request(h, 'PATCH', '/5000', { content: 'after' })).status).toBe(200);
    expect((await request(h, 'DELETE', '/5000')).status).toBe(204);
  });
  it('strict ordinary reads exclude interaction and hidden records but retain other authors', async () => {
    const h = setup();
    h.state.create('message', {
      id: '5002',
      channel_id: '4000',
      guild_id: '1000',
      author: { id: '2000' },
      content: 'interaction',
      flags: 0,
      visibility: 'channel',
      type: 20,
      message_origin: 'interaction',
    });
    h.state.create('message', {
      id: '5003',
      channel_id: '4000',
      guild_id: '1000',
      author: { id: '2000' },
      content: 'hidden',
      flags: 64,
      visibility: 'ephemeral',
      type: 0,
    });
    const list = (await (await request(h, 'GET')).json()) as Record<string, unknown>[];
    expect(list.map((m) => m['id'])).toEqual(['5000', '5001']);
    for (const messageId of ['5002', '5003']) {
      const r = await request(h, 'GET', `/${messageId}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: 10008 });
    }
    h.state.update('message', '5000', { guild_id: '9999' });
    expect((await request(h, 'GET', '/5000')).status).toBe(404);
  });
  it('omitted and explicit legacy profiles preserve unenforced behavior, including public interaction reads', async () => {
    for (const options of [{}, { ordinaryMessagePermissions: 'legacy-unenforced' }]) {
      const h = setup(
        (s) => {
          s.delete('member', '2100');
          s.update('message', '5000', { message_origin: 'interaction' });
        },
        options as typeof profile,
      );
      expect((await request(h, 'GET', '/5000')).status).toBe(200);
      expect((await request(h, 'POST', '', { content: 'legacy' })).status).toBe(200);
    }
  });
  it('explicit DMs remain unenforced while unsupported channels reject', async () => {
    const h = setup((s) => {
      s.delete('member', '2100');
      s.delete('channel', '4000');
      s.create('channel', { id: '4000', type: 1 });
      s.delete('message', '5000');
      s.create('message', {
        id: '5000',
        channel_id: '4000',
        author: { id: '2000' },
        content: 'dm',
        flags: 0,
        visibility: 'channel',
        type: 0,
      });
    });
    for (const [method, suffix] of operations) {
      expect(
        (
          await request(
            h,
            method,
            suffix,
            ['POST', 'PATCH'].includes(method) ? { content: 'dm' } : undefined,
          )
        ).status,
      ).toBe(method === 'DELETE' ? 204 : 200);
    }
    h.state.update('channel', '4000', { type: 2 });
    for (const method of ['GET', 'POST'])
      expect(
        (await request(h, method, '', method === 'POST' ? { content: 'x' } : undefined)).status,
      ).toBe(400);
  });
});

describe('strict decimal boundaries and unchanged DM error order', () => {
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const field of [
      'permissions',
      'allow',
      'deny',
      'owner_id',
      'overwrite_id',
      'member_role_id',
    ]) {
      it(`rejects trailing ${JSON.stringify(ending)} in ${field}`, async () => {
        const h = setup((s) => {
          if (field === 'permissions') role(s, `8${ending}`);
          if (field === 'allow' || field === 'deny')
            overwrites(s, [{ id: '2000', type: 1, allow: '0', deny: '0', [field]: `8${ending}` }]);
          if (field === 'owner_id') s.update('guild', '1000', { owner_id: `9000${ending}` });
          if (field === 'overwrite_id')
            overwrites(s, [{ id: `9001${ending}`, type: 1, allow: '0', deny: '0' }]);
          if (field === 'member_role_id') {
            s.create('role', { id: `3002${ending}`, guild_id: '1000', permissions: '8' });
            s.update('member', '2100', { roles: [`3002${ending}`] });
          }
        });
        const before = unchanged(h);
        const r = await request(h, 'POST', '', { content: 'no' });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual(denied);
        expect(unchanged(h)).toEqual(before);
      });
    }
  }
  it('preserves explicit DM missing-message errors before invalid object bodies', async () => {
    const results: unknown[] = [];
    for (const options of [{}, profile]) {
      const h = setup(
        (s) => {
          s.delete('channel', '4000');
          s.create('channel', { id: '4000', type: 1 });
        },
        options as typeof profile,
      );
      const r = await request(h, 'PATCH', '/5999', []);
      const body: unknown = await r.json();
      results.push({ status: r.status, body });
    }
    expect(results[0]).toMatchObject({ status: 404, body: { code: 10008 } });
    expect(results[1]).toEqual(results[0]);
  });
});
