import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VirtualClock,
  VirtualState,
  SnowflakeGenerator,
  SeededRandom,
  GatewayEmulator,
  InteractionEngine,
  RateLimitEngine,
  LocalRestEmulator,
  createSimulationProfile,
  TraceCollector,
} from '../../src/index.js';
const APP = '111111111111111111';
const GUILD = '666666666666666666';
const BASE = '/api/v10/applications/' + APP + '/commands';
const TOKEN = 'disrunner.offline.command-registry-test';
const ping = {
  id: '419430400000',
  type: 1,
  application_id: APP,
  name: 'ping',
  description: 'Ping',
  options: [],
  default_member_permissions: null,
  nsfw: false,
  version: '1',
  integration_types: [0],
  contexts: [0],
  dm_permission: false,
};
async function harness(enabled = true, maxBodyBytes = 1048576) {
  const clock = new VirtualClock({ nowMs: 1420070500000 });
  const snowflakes = new SnowflakeGenerator(clock);
  const random = new SeededRandom(1);
  const state = new VirtualState(clock, snowflakes, [{ resourceType: 'guild', id: GUILD }]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    fakeToken: TOKEN,
    botUserId: '222222222222222222',
    applicationId: APP,
  });
  const rateLimits = new RateLimitEngine(clock);
  const trace = new TraceCollector({ clock, random });
  const events: string[] = [];
  gateway.subscribeBroadcast((_session, packet) => {
    events.push(packet.t);
  });
  const user = {
    id: '222222222222222222',
    username: 'bot',
    discriminator: '0',
    avatar: null,
    bot: true,
  } as const;
  const rest = new LocalRestEmulator({
    state,
    gateway,
    rateLimits,
    trace,
    maxBodyBytes,
    interactions: new InteractionEngine({
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile({ seed: 1 }),
    }),
    bootstrap: {
      user,
      application: {
        id: APP,
        name: 'app',
        description: '',
        icon: null,
        bot_public: false,
        bot_require_code_grant: false,
        owner: { ...user, id: '333333333333333333', bot: false },
        verify_key: '0'.repeat(64),
        flags: 0,
        team: null,
      },
    },
    ...(enabled
      ? { commandRegistry: { profile: 'command-registry-v1' as const, guildIds: [GUILD] } }
      : {}),
  });
  const address = await rest.start();
  const send = (
    method: string,
    path = BASE,
    body?: string,
    token: string | null = TOKEN,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; body: unknown; raw: string; revision: string | undefined }>(
      (resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: address.port,
            path,
            method,
            headers: {
              ...(token === null ? {} : { Authorization: 'Bot ' + token }),
              ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
              ...headers,
            },
          },
          (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += String(chunk)));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                raw,
                body: raw ? JSON.parse(raw) : undefined,
                revision: res.headers['x-disrunner-state-revision'] as string | undefined,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  return { state, rest, send, clock, rateLimits, trace, address, events };
}
describe('literal command registry HTTP contract', () => {
  it('creates, upserts, reads, edits and deletes exact global wire records', async () => {
    const h = await harness();
    try {
      const first = await h.send('POST', BASE, '{"name":"ping","description":"Ping"}');
      expect(first.status).toBe(201);
      expect(first.body).toEqual(ping);
      expect(first.revision).toBe('1');
      expect(h.events).toEqual([]);
      expect(await h.send('POST', BASE, '{"name":"ping","description":"Ping"}')).toMatchObject({
        status: 200,
        body: ping,
        revision: '1',
      });
      expect(await h.send('GET')).toMatchObject({ status: 200, body: [ping], revision: '1' });
      expect(await h.send('GET', BASE + '/419430400000')).toMatchObject({
        status: 200,
        body: ping,
      });
      expect(await h.send('PATCH', BASE + '/419430400000', '{"description":"Pong"}')).toMatchObject(
        { status: 200, body: { ...ping, description: 'Pong', version: '2' }, revision: '2' },
      );
      expect(await h.send('PATCH', BASE + '/419430400000', '{}')).toMatchObject({
        status: 200,
        revision: '2',
      });
      expect(await h.send('DELETE', BASE + '/419430400000')).toMatchObject({
        status: 204,
        raw: '',
        revision: '3',
      });
      expect(await h.send('DELETE', BASE + '/419430400000')).toMatchObject({
        status: 404,
        body: { code: 10063, message: 'Unknown application command.' },
      });
    } finally {
      await h.rest.stop();
    }
  });
  it('bulk is atomic and preserves request order, scope, and literal context wire shape', async () => {
    const h = await harness();
    try {
      const user = {
        id: '419430400001',
        type: 2,
        application_id: APP,
        name: 'Inspect User',
        description: '',
        default_member_permissions: null,
        nsfw: false,
        version: '1',
        integration_types: [0],
        contexts: [0],
        dm_permission: false,
      };
      expect(
        await h.send(
          'PUT',
          BASE,
          '[{"name":"ping","description":"Ping"},{"type":2,"name":"Inspect User"}]',
        ),
      ).toMatchObject({ status: 200, body: [ping, user], revision: '1' });
      const before = h.state.snapshot();
      expect(
        await h.send(
          'PUT',
          BASE,
          '[{"name":"ok","description":"OK"},{"name":"bad","description":"Bad","options":[{}]}]',
        ),
      ).toMatchObject({
        status: 400,
        body: {
          code: 50035,
          message: 'Unsupported application command feature in command-registry-v1.',
        },
      });
      expect(h.state.snapshot()).toEqual(before);
      const guildBase = '/api/v10/applications/' + APP + '/guilds/' + GUILD + '/commands';
      expect(await h.send('POST', guildBase, '{"type":3,"name":"Inspect Message"}')).toMatchObject({
        status: 201,
        body: {
          id: '419430400002',
          type: 3,
          application_id: APP,
          guild_id: GUILD,
          name: 'Inspect Message',
          description: '',
          default_member_permissions: null,
          nsfw: false,
          version: '2',
        },
      });
      expect(await h.send('PUT', BASE, '[]')).toMatchObject({
        status: 200,
        body: [],
        revision: '3',
      });
      expect(h.state.list('application-command')).toHaveLength(1);
    } finally {
      await h.rest.stop();
    }
  });
  it.each([
    '/x/../applications/' + APP + '/commands',
    '/applications/01/commands',
    '/applications/' + APP + '/%63ommands',
    '/applications/' + APP + '/commands/%31',
    '/applications/x/../' + APP + '/commands',
    '/applications/' + APP + '/commands/%2e',
    '/applications/' + APP + '/commands/%2e%2e',
    '/applications/' + APP + '%2fcommands',
    '/applications/' + APP + '%5ccommands',
    '/applications/' + APP + '\\commands',
    '/%61pplications/' + APP + '/commands',
    '/applications/18446744073709551616/commands',
    '/applications/0/commands',
    '/applications/' + APP + '/commands/%GG',
    'http://127.0.0.1/applications/' + APP + '/commands',
  ])('rejects raw aliases with auth precedence: %s', async (path) => {
    const h = await harness();
    try {
      expect(await h.send('GET', path, undefined, 'wrong')).toMatchObject({
        status: 401,
        body: { code: 0, message: '401: Unauthorized' },
      });
      expect(await h.send('GET', path)).toMatchObject({
        status: 400,
        body: { code: 50035, message: 'Invalid application command route.' },
      });
    } finally {
      await h.rest.stop();
    }
  });
  it('disabled, body and query errors are fixed', async () => {
    const off = await harness(false);
    try {
      expect(await off.send('GET')).toMatchObject({
        status: 501,
        body: { code: 0, message: 'Command registry profile is not enabled.' },
      });
    } finally {
      await off.rest.stop();
    }
    const h = await harness();
    try {
      for (const body of [' ', 'null', '{}'])
        expect(await h.send('GET', BASE, body)).toMatchObject({
          status: 400,
          body: { code: 50035, message: 'Invalid application command payload.' },
        });
      expect(await h.send('GET', BASE + '?with_localizations=false')).toMatchObject({
        status: 200,
        body: [],
      });
      expect(await h.send('GET', BASE + '?with_localizations=true')).toMatchObject({
        status: 400,
        body: {
          code: 50035,
          message: 'Unsupported application command feature in command-registry-v1.',
        },
      });
    } finally {
      await h.rest.stop();
    }
  });

  it.each([undefined, GUILD])(
    'all collection/item methods have exact canonical keys and revision headers in scope %s',
    async (guild) => {
      const h = await harness();
      try {
        const base =
          guild === undefined
            ? BASE
            : '/api/v10/applications/' + APP + '/guilds/' + guild + '/commands';
        const scope =
          guild === undefined
            ? { integration_types: [0], contexts: [0], dm_permission: false }
            : { guild_id: GUILD };
        const one = {
          id: '419430400000',
          type: 2,
          application_id: APP,
          name: 'Inspect',
          description: '',
          default_member_permissions: null,
          nsfw: false,
          version: '1',
          ...scope,
        };
        const made = await h.send('POST', base, '{"type":2,"name":"Inspect"}');
        expect(made.status).toBe(201);
        expect(made.body).toEqual(one);
        expect(made.revision).toBe('1');
        for (const path of [base, base + '/419430400000']) {
          const read = await h.send('GET', path);
          expect(read.status).toBe(200);
          expect(read.body).toEqual(path === base ? [one] : one);
          expect(read.revision).toBe('1');
        }
        const renamed = { ...one, name: 'Renamed', version: '2' };
        const patch = await h.send('PATCH', base + '/419430400000', '{"name":"Renamed"}');
        expect(patch.status).toBe(200);
        expect(patch.body).toEqual(renamed);
        expect(patch.revision).toBe('2');
        const put = await h.send('PUT', base, '[{"type":2,"name":"Renamed"}]');
        expect(put.status).toBe(200);
        expect(put.body).toEqual([renamed]);
        expect(put.revision).toBe('2');
        const deleted = await h.send('DELETE', base + '/419430400000');
        expect(deleted).toEqual({ status: 204, body: undefined, raw: '', revision: '3' });
      } finally {
        await h.rest.stop();
      }
    },
  );
  it('checks identity, missing fixtures, wrong scopes and corruption before quota/body', async () => {
    const h = await harness();
    try {
      h.rateLimits.configure({
        id: 'commands',
        route: '/applications/:applicationId/commands',
        limit: 1,
        windowMs: 60000,
        majorParameters: ['applicationId'],
      });
      const errors = [
        [BASE.replace(APP, '999999999999999999'), 403, 50001, 'Missing access.'],
        [
          '/applications/' + APP + '/guilds/999999999999999999/commands',
          403,
          50001,
          'Missing access.',
        ],
        [BASE + '/999999999999999999', 404, 10063, 'Unknown application command.'],
        [BASE + '/permissions', 501, 0, 'Unsupported application command route.'],
      ] as const;
      for (const [path, status, code, message] of errors)
        expect(await h.send('GET', path, 'attacker')).toMatchObject({
          status,
          body: { code, message },
        });
      expect(h.rateLimits.buckets()).toEqual([]);
      h.state.delete('guild', GUILD);
      expect(
        await h.send('POST', '/applications/' + APP + '/guilds/' + GUILD + '/commands', 'attacker'),
      ).toMatchObject({ status: 404, body: { code: 10004, message: 'Unknown guild.' } });
      h.state.create('application-command', { id: '9' });
      expect(await h.send('GET', BASE, 'attacker')).toMatchObject({
        status: 503,
        body: { code: 0, message: 'Command registry state is invalid.' },
      });
      expect(h.rateLimits.buckets()).toEqual([]);
      const trace = JSON.stringify(h.trace.spans());
      expect(trace).not.toContain('attacker');
      expect(trace).not.toContain(APP);
      expect(trace).not.toContain(TOKEN);
    } finally {
      await h.rest.stop();
    }
  });
  it('shares one methodless scope bucket, rejects bad input after quota and isolates scope', async () => {
    const h = await harness();
    try {
      h.rateLimits.configure({
        id: 'commands-global',
        route: '/applications/:applicationId/commands',
        limit: 1,
        windowMs: 60000,
        majorParameters: ['applicationId'],
      });
      h.rateLimits.configure({
        id: 'commands-guild',
        route: '/applications/:applicationId/guilds/:guildId/commands',
        limit: 1,
        windowMs: 60000,
        majorParameters: ['applicationId', 'guildId'],
      });
      expect((await h.send('POST', BASE, '{"name":"ping","description":"Ping"}')).status).toBe(201);
      for (const [method, path] of [
        ['GET', BASE],
        ['PATCH', BASE + '/419430400000'],
        ['DELETE', BASE + '/419430400000'],
        ['PUT', BASE],
      ]) {
        const result = await h.send(method!, path! + '?bad=query', 'not json');
        expect(result.status).toBe(429);
        expect(result.body).toEqual({
          message: 'You are being rate limited.',
          retry_after: 60,
          global: false,
        });
      }
      expect(
        (await h.send('GET', '/applications/' + APP + '/guilds/' + GUILD + '/commands')).status,
      ).toBe(200);
      expect(h.rateLimits.buckets()).toHaveLength(2);
      h.clock.advanceBy(60000);
      expect((await h.send('GET')).body).toEqual([ping]);
    } finally {
      await h.rest.stop();
    }
  });
  it('rejects query aliases, duplicate values and queries on writes/item reads', async () => {
    const h = await harness();
    try {
      for (const suffix of [
        '?',
        '?&',
        '?&&',
        '?x=y',
        '?with_localizations=false&with_localizations=false',
        '?with_localizations=False',
        '?%77ith_localizations=false',
        '?with_localizations=%66alse',
      ])
        expect(await h.send('GET', BASE + suffix)).toMatchObject({
          status: 400,
          body: { code: 50035, message: 'Invalid application command payload.' },
        });
      expect(await h.send('POST', BASE + '?with_localizations=false', '{}')).toMatchObject({
        status: 400,
        body: { code: 50035, message: 'Invalid application command payload.' },
      });
    } finally {
      await h.rest.stop();
    }
  });
  it('rejects body bytes immediately, handles chunked bodies, and keeps zero-byte reads valid', async () => {
    const h = await harness(true, 128);
    try {
      expect(await h.send('GET', BASE, 'x', TOKEN, { 'Content-Length': '129' })).toMatchObject({
        status: 413,
        body: { code: 40005, message: 'Request entity too large.' },
      });
      const raw = (method: string, path: string, chunks: string[], finish = true) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: h.address.port,
              path,
              method,
              headers: { Authorization: 'Bot ' + TOKEN, 'Transfer-Encoding': 'chunked' },
            },
            (res) => {
              let data = '';
              res.on('data', (x) => (data += String(x)));
              res.on('end', () => {
                req.destroy();
                resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined });
              });
            },
          );
          req.setTimeout(1500, () => {
            req.destroy();
            reject(Error('bounded response timeout'));
          });
          req.on('error', reject);
          for (const chunk of chunks) req.write(chunk);
          if (finish) req.end();
        });
      for (const body of [' ', 'null', '{}'])
        expect(await raw('GET', BASE, [body], false)).toEqual({
          status: 400,
          body: { code: 50035, message: 'Invalid application command payload.' },
        });
      expect(await raw('GET', BASE, [])).toEqual({ status: 200, body: [] });
      await h.send('POST', BASE, '{"name":"ping","description":"Ping"}');
      expect(await raw('DELETE', BASE + '/419430400000', [' '], false)).toEqual({
        status: 400,
        body: { code: 50035, message: 'Invalid application command payload.' },
      });
      expect(await h.send('DELETE', BASE + '/419430400000', 'null')).toMatchObject({
        status: 400,
        body: { code: 50035, message: 'Invalid application command payload.' },
      });
      expect((await h.send('GET', BASE, undefined, TOKEN, { 'Content-Length': '0' })).body).toEqual(
        [ping],
      );
    } finally {
      await h.rest.stop();
    }
  });
  it.each([1, 2, 3])(
    'projects exact command type %s in both scopes without markers',
    async (type) => {
      const h = await harness();
      try {
        for (const [index, guild] of [undefined, GUILD].entries()) {
          const base =
            guild === undefined ? BASE : '/applications/' + APP + '/guilds/' + guild + '/commands';
          const create = {
            type,
            name: type === 1 ? 'ping' : 'Inspect',
            ...(type === 1 ? { description: 'Ping' } : {}),
          };
          const result = await h.send('POST', base, JSON.stringify(create));
          expect(result.status).toBe(201);
          expect(result.body).toEqual({
            id: index === 0 ? '419430400000' : '419430400001',
            type,
            application_id: APP,
            name: type === 1 ? 'ping' : 'Inspect',
            description: type === 1 ? 'Ping' : '',
            ...(type === 1 ? { options: [] } : {}),
            default_member_permissions: null,
            nsfw: false,
            version: index === 0 ? '1' : '2',
            ...(guild === undefined
              ? { integration_types: [0], contexts: [0], dm_permission: false }
              : { guild_id: GUILD }),
          });
        }
        expect(h.events).toEqual([]);
      } finally {
        await h.rest.stop();
      }
    },
  );
  it('rejects forbidden PATCH features and preserves revision on accepted empty options', async () => {
    const h = await harness();
    try {
      await h.send('POST', BASE, '{"name":"ping","description":"Ping"}');
      const path = BASE + '/419430400000';
      expect(await h.send('PATCH', path, '{"options":[]}')).toMatchObject({
        status: 200,
        revision: '1',
      });
      for (const body of ['{"options":[{}]}', '{"type":1}', '{"choices":[]}']) {
        expect(await h.send('PATCH', path, body)).toMatchObject({
          status: 400,
          body: {
            code: 50035,
            message: 'Unsupported application command feature in command-registry-v1.',
          },
        });
      }
      expect(await h.send('PATCH', path, '{"options":null}')).toMatchObject({
        status: 400,
        body: { code: 50035, message: 'Invalid application command payload.' },
      });
      expect(h.state.revision).toBe(1);
    } finally {
      await h.rest.stop();
    }
  });
  it.each([true, false])(
    'authenticates missing, Bearer and raw synthetic tokens before profile state %s',
    async (enabled) => {
      const h = await harness(enabled);
      try {
        for (const path of [BASE, '/applications/01/commands']) {
          for (const headers of [{}, { Authorization: 'Bearer ' + TOKEN }]) {
            const result = await h.send('GET', path, undefined, null, headers);
            expect(result.status).toBe(401);
            expect(result.body).toEqual({ code: 0, message: '401: Unauthorized' });
            expect(result.revision).toBeUndefined();
          }
        }
        const raw = await h.send('GET', BASE, undefined, null, { Authorization: TOKEN });
        expect(raw.status).toBe(enabled ? 200 : 501);
        expect(raw.body).toEqual(
          enabled ? [] : { code: 0, message: 'Command registry profile is not enabled.' },
        );
        const malformed = await h.send('GET', '/applications/01/commands', undefined, null, {
          Authorization: TOKEN,
        });
        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({
          code: 50035,
          message: 'Invalid application command route.',
        });
        expect(h.state.revision).toBe(0);
      } finally {
        await h.rest.stop();
      }
    },
  );
  it.each([undefined, GUILD])(
    'rejects unsupported collection/item methods before identity, quota and payload in scope %s',
    async (guild) => {
      const h = await harness();
      try {
        const base =
          guild === undefined ? BASE : '/applications/' + APP + '/guilds/' + GUILD + '/commands';
        h.rateLimits.configure({
          id: 'unsupported-global',
          route: '/applications/:applicationId/commands',
          limit: 1,
          windowMs: 60000,
          majorParameters: ['applicationId'],
        });
        h.rateLimits.configure({
          id: 'unsupported-guild',
          route: '/applications/:applicationId/guilds/:guildId/commands',
          limit: 1,
          windowMs: 60000,
          majorParameters: ['applicationId', 'guildId'],
        });
        for (const [path, methods] of [
          [base, ['PATCH', 'DELETE', 'OPTIONS']],
          [base + '/999999999999999999', ['POST', 'PUT', 'OPTIONS']],
        ] as const) {
          for (const method of methods) {
            const result = await h.send(method, path + '?bad=query', '{');
            expect(result.status).toBe(501);
            expect(result.body).toEqual({
              code: 0,
              message: 'Unsupported application command route.',
            });
            expect(result.revision).toBeUndefined();
          }
        }
        const foreign = await h.send('OPTIONS', base.replace(APP, '999999999999999999'), '{');
        expect(foreign.status).toBe(501);
        expect(foreign.body).toEqual({
          code: 0,
          message: 'Unsupported application command route.',
        });
        expect(h.rateLimits.buckets()).toEqual([]);
        expect(h.state.revision).toBe(0);
      } finally {
        await h.rest.stop();
      }
      const disabled = await harness(false);
      try {
        const result = await disabled.send('OPTIONS', BASE + '/permissions', '{');
        expect(result.status).toBe(501);
        expect(result.body).toEqual({
          code: 0,
          message: 'Command registry profile is not enabled.',
        });
      } finally {
        await disabled.rest.stop();
      }
    },
  );
  it.each([undefined, GUILD])(
    'rejects every item query on reads, edits and deletion in scope %s',
    async (guild) => {
      const h = await harness();
      try {
        const base =
          guild === undefined ? BASE : '/applications/' + APP + '/guilds/' + GUILD + '/commands';
        expect((await h.send('POST', base, '{"name":"ping","description":"Ping"}')).status).toBe(
          201,
        );
        const before = h.state.snapshot(),
          history = h.state.mutationHistory();
        for (const method of ['GET', 'PATCH', 'DELETE']) {
          for (const query of [
            '?',
            '?&',
            '?with_localizations=false',
            '?with_localizations=true',
            '?unknown=1',
            '?with_localizations=false&with_localizations=false',
          ]) {
            const result = await h.send(
              method,
              base + '/419430400000' + query,
              method === 'PATCH' ? '{' : undefined,
            );
            expect(result.status).toBe(400);
            expect(result.body).toEqual({
              code: 50035,
              message: 'Invalid application command payload.',
            });
            expect(result.revision).toBeUndefined();
          }
        }
        expect(h.state.snapshot()).toEqual(before);
        expect(h.state.mutationHistory()).toEqual(history);
      } finally {
        await h.rest.stop();
      }
    },
  );
});
