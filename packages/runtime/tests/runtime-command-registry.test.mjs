import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  BotRunner,
  VirtualState,
  InteractionEngine,
  TraceCollector,
  LocalRestEmulator,
  LocalGatewayServer,
} from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';
const { WebSocket } = createRequire(import.meta.resolve('@disrunner/core'))('ws');
const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const child = fileURLToPath(new URL('./fixtures/registry-child.mjs', import.meta.url));
const globalPath = '/applications/{app}/commands';
const guildPath = '/applications/{app}/guilds/1000/commands';
const errors = {
  unauthorized: [401, { code: 0, message: '401: Unauthorized' }],
  disabled: [501, { code: 0, message: 'Command registry profile is not enabled.' }],
  route: [400, { code: 50035, message: 'Invalid application command route.' }],
  unsupportedRoute: [501, { code: 0, message: 'Unsupported application command route.' }],
  access: [403, { code: 50001, message: 'Missing access.' }],
  guild: [404, { code: 10004, message: 'Unknown guild.' }],
  command: [404, { code: 10063, message: 'Unknown application command.' }],
  payload: [400, { code: 50035, message: 'Invalid application command payload.' }],
  feature: [
    400,
    { code: 50035, message: 'Unsupported application command feature in command-registry-v1.' },
  ],
  corrupt: [503, { code: 0, message: 'Command registry state is invalid.' }],
};
function canonical(id) {
  assert.equal(typeof id, 'string');
  assert.match(id, /^[1-9][0-9]{0,19}$/);
  assert.ok(BigInt(id) <= 18446744073709551615n);
  return id;
}
function expected(
  id,
  app,
  { guild = false, type = 1, name = 'ping', description = 'Ping', version = '1' } = {},
) {
  return {
    id,
    type,
    application_id: app,
    name,
    description: type === 1 ? description : '',
    ...(type === 1 ? { options: [] } : {}),
    default_member_permissions: null,
    nsfw: false,
    version,
    ...(guild
      ? { guild_id: '1000' }
      : { integration_types: [0], contexts: [0], dm_permission: false }),
  };
}
function success(fact, status, body, revision) {
  assert.equal(fact.status, status);
  assert.deepEqual(fact.body, body);
  assert.equal(fact.revision, revision);
  if (status === 204) assert.equal(fact.bytes, 0);
}
function failure(fact, kind) {
  assert.equal(fact.status, errors[kind][0]);
  assert.deepEqual(fact.body, errors[kind][1]);
  assert.equal(fact.revision, null);
}
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await delay(10);
  }
  assert.fail('Timed out');
}
async function connected(port) {
  const result = await new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve('open');
    });
    s.once('error', (e) => {
      s.destroy();
      resolve(e.code);
    });
    s.setTimeout(2000, () => {
      s.destroy();
      resolve('timeout');
    });
  });
  assert.equal(result, 'open');
}
function assertListenerClosed(record) {
  // These are the real instances: their addresses clear only after their close callbacks.
  // A released port may already belong to someone else; its current occupant is not our oracle.
  assert.equal(record.resource.address, undefined, `${record.label} still owns its listener`);
  assert.equal(record.realStopCompleted, true, `${record.label} real stop did not complete`);
}
async function withCleanup(run, ...cleanups) {
  const failures = [];
  let result;
  try {
    result = await run();
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Test body and/or cleanup failed');
  return result;
}
async function harness({ enabled = true, guildIds = ['1000'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-registry-'));
  await cp(example, root, { recursive: true });
  await cp(child, join(root, 'src/registry-child.mjs'));
  const config = JSON.parse(await readFile(join(root, 'discord-simulator.config.json'), 'utf8'));
  config.bot.entryPoint = 'src/registry-child.mjs';
  config.bot.startCommand = 'node src/registry-child.mjs';
  if (enabled) config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds };
  else delete config.profile.commandRegistry;
  await writeFile(join(root, 'discord-simulator.config.json'), JSON.stringify(config));
  const runs = [],
    states = [],
    events = [],
    listeners = [],
    peers = [],
    traces = new Set();
  let failStop = false,
    fakeStop,
    interactions = 0;
  function wrapListener(resource, kind) {
    const record = {
      resource,
      kind,
      label: `${kind} generation ${listeners.filter((r) => r.kind === kind).length + 1}`,
      started: false,
      realStopCompleted: false,
      stopReturned: false,
    };
    listeners.push(record);
    record.wrapper = {
      get address() {
        return resource.address;
      },
      async start(...args) {
        const result = await resource.start(...args);
        // Retain successful starts before an observer assertion can throw.
        record.started = true;
        record.startAddress = resource.address;
        assert.ok(record.startAddress, `${record.label} did not expose its actual address`);
        assert.equal(record.startAddress.host, '127.0.0.1');
        assert.ok(Number.isInteger(record.startAddress.port) && record.startAddress.port > 0);
        assert.equal(result, record.startAddress);
        return result;
      },
      async stop() {
        if (kind === 'REST' && failStop) throw Error('injected registry cleanup failure');
        // The negative control deliberately reports success without closing the real instance.
        if (fakeStop !== kind) {
          await resource.stop();
          record.realStopCompleted = true;
        }
        record.stopReturned = true;
      },
    };
    return record.wrapper;
  }
  const subscribe = VirtualState.prototype.subscribeCommits,
    create = InteractionEngine.prototype.create,
    traceStart = TraceCollector.prototype.start;
  TraceCollector.prototype.start = function (...args) {
    traces.add(this);
    return traceStart.apply(this, args);
  };
  VirtualState.prototype.subscribeCommits = function (...args) {
    states.push(this);
    return subscribe.apply(this, args);
  };
  InteractionEngine.prototype.create = function (...args) {
    interactions++;
    return create.apply(this, args);
  };
  const session = createSessionWithDependencies(
    {},
    {
      wrapBot(bot) {
        assert.ok(bot instanceof BotRunner);
        return {
          async start(c) {
            const run = { token: c.fakeToken, peer: c.interactionPeerSecret };
            runs.push(run);
            const result = await bot.start(c);
            run.pid = result.pid;
            return result;
          },
          stop: (...a) => bot.stop(...a),
          snapshot: () => bot.snapshot(),
          observeExit: () => bot.observeExit(),
        };
      },
      wrapRest(rest) {
        assert.ok(rest instanceof LocalRestEmulator);
        return wrapListener(rest, 'REST');
      },
      wrapGateway(gateway) {
        assert.ok(gateway instanceof LocalGatewayServer);
        return wrapListener(gateway, 'Gateway');
      },
    },
  );
  session.subscribe((e) => events.push(e));
  try {
    await session.selectProject(root);
  } catch (error) {
    VirtualState.prototype.subscribeCommits = subscribe;
    InteractionEngine.prototype.create = create;
    TraceCollector.prototype.start = traceStart;
    await withCleanup(
      () => {
        throw error;
      },
      async () => assert.equal((await session.dispose()).ok, true),
      () => rm(root, { recursive: true, force: true }),
    );
  }
  const h = {
    root,
    session,
    runs,
    states,
    events,
    listeners,
    failStop: (v) => {
      failStop = v;
    },
    fakeStop: (kind) => {
      fakeStop = kind;
    },
    state: () => h.currentState,
    interactions: () => interactions,
    async start() {
      const s = await session.start();
      assert.equal(s.phase, 'running');
      h.started = s;
      h.run = runs.at(-1);
      h.currentState = states.at(-1);
      return s;
    },
    async child(path = globalPath, method = 'GET', body, extra = {}) {
      const nonce = randomUUID(),
        bytes = Buffer.from(JSON.stringify({ nonce, path, method, body, ...extra }));
      const mac = (b) => createHmac('sha256', h.run.peer).update(b).digest('hex');
      const endpoint = new URL('/registry-test', h.started.endpoints.interactionEndpoint);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-test-auth': mac(bytes) },
        body: bytes,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const raw = Buffer.from(await response.arrayBuffer());
      assert.ok(raw.length < 262144);
      assert.equal(response.headers.get('x-test-auth'), mac(raw));
      const result = JSON.parse(raw.toString());
      assert.equal(result.nonce, nonce);
      assert.equal(result.app.status, 200);
      canonical(result.app.body.id);
      h.app = result.app.body.id;
      return result;
    },
    async read(path = globalPath, token = h.run.token) {
      const response = await fetch(
        h.started.endpoints.restBaseUrl + path.replaceAll('{app}', h.app),
        { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(5000) },
      );
      return {
        status: response.status,
        body: await response.json(),
        revision: response.headers.get('x-disrunner-state-revision'),
      };
    },
    async identify() {
      const socket = new WebSocket(h.started.endpoints.gatewayUrl);
      const packets = [];
      peers.push(socket);
      socket.on('message', (d) => packets.push(JSON.parse(d.toString())));
      socket.on('error', () => {});
      await until(() => packets.some((p) => p.op === 10));
      socket.send(JSON.stringify({ op: 2, d: { token: h.run.token, intents: 513 } }));
      await until(() => packets.some((p) => p.t === 'READY'));
      return {
        packets,
        async barrier() {
          const n = packets.filter((p) => p.op === 11).length;
          socket.send(JSON.stringify({ op: 1, d: null }));
          await until(() => packets.filter((p) => p.op === 11).length === n + 1);
        },
      };
    },
    projection() {
      const snapshots = [session.snapshot(), ...events.map((e) => e.snapshot).filter(Boolean)];
      for (const s of snapshots)
        for (const r of s.coreState?.resources ?? [])
          assert.ok(['guild', 'channel', 'user', 'message'].includes(r.resourceType));
      const text = JSON.stringify({
        snapshot: session.snapshot(),
        events,
        traceExports: [...traces].map((t) => t.spans()),
      });
      for (const value of [
        'registry_profile',
        'private-registry-sentinel',
        'wrong-credential-sentinel',
        ...runs.flatMap((r) => [r.token, r.peer]),
      ])
        assert.ok(!text.includes(value), `Projection leak: ${value.slice(0, 20)}`);
    },
    async cleanup() {
      failStop = false;
      await withCleanup(
        () => h.projection(),
        async () => assert.equal((await session.dispose()).ok, true),
        ...listeners.map((r) => () => assertListenerClosed(r)),
        ...runs.map((r) => async () => {
          // A rejected bot start may never have produced a child PID.
          if (r.pid === undefined) return;
          await until(() => {
            try {
              process.kill(r.pid, 0);
              return false;
            } catch (e) {
              return e.code === 'ESRCH';
            }
          });
        }),
        () => {
          VirtualState.prototype.subscribeCommits = subscribe;
          InteractionEngine.prototype.create = create;
          TraceCollector.prototype.start = traceStart;
        },
        ...peers.map((p) => () => p.terminate()),
        () => rm(root, { recursive: true, force: true }),
      );
    },
  };
  return h;
}
async function withRuntime(options, run) {
  const h = await harness(options);
  await withCleanup(
    async () => {
      await h.start();
      await run(h);
    },
    () => h.cleanup(),
  );
}

test('cleanup preserves body and cleanup failures and attempts every cleanup', async () => {
  const body = Error('body failure'),
    cleanup = Error('cleanup failure');
  let remainingCleanup = false;
  await assert.rejects(
    withCleanup(
      () => {
        throw body;
      },
      () => {
        throw cleanup;
      },
      () => {
        remainingCleanup = true;
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === body &&
      error.errors[1] === cleanup,
  );
  assert.equal(remainingCleanup, true);
});

test('cleanup accepts closed owned generations while their released ports are rebound', async () => {
  const h = await harness();
  const rebound = [];
  await withCleanup(
    async () => {
      await h.start();
      const first = [...h.listeners];
      assert.equal(first.length, 2);
      assert.equal((await h.session.stop()).ok, true);
      for (const record of first) {
        assertListenerClosed(record);
        const server = createServer((socket) => socket.destroy());
        rebound.push(server);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(record.startAddress.port, '127.0.0.1', resolve);
        });
        assert.equal(server.address().port, record.startAddress.port);
        await connected(record.startAddress.port);
      }
      await h.start();
      assert.equal(h.listeners.length, 4);
      assert.ok(h.listeners.every((r) => r.started));
      assert.equal((await h.session.stop()).ok, true);
      assert.ok(rebound.every((server) => server.listening));
    },
    // Check all original instances while the unrelated listeners still hold the old ports.
    () => h.cleanup(),
    () =>
      withCleanup(
        () => {},
        ...rebound.map(
          (server) => () =>
            new Promise((resolve, reject) => {
              if (!server.listening) return resolve();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      ),
  );
});

for (const kind of ['REST', 'Gateway'])
  test(`cleanup rejects fake-success stop of a live owned ${kind} instance`, async () => {
    const h = await harness();
    let retained;
    await withCleanup(
      async () => {
        await h.start();
        retained = h.listeners.find((r) => r.kind === kind);
        assert.ok(retained.started);
        h.fakeStop(kind);
        assert.equal((await h.session.stop()).ok, true);
        assert.equal(retained.stopReturned, true);
        assert.equal(retained.realStopCompleted, false);
        assert.equal(retained.resource.address, retained.startAddress);
        await connected(retained.startAddress.port);
        assert.throws(
          () => assertListenerClosed(retained),
          (error) =>
            error.code === 'ERR_ASSERTION' &&
            error.actual === retained.startAddress &&
            error.expected === undefined &&
            error.message.startsWith(`${retained.label} still owns its listener`),
        );
      },
      async () => {
        h.fakeStop(undefined);
        // Runtime disposal cannot recover a resource the fake-success wrapper made it forget.
        if (retained) {
          await retained.wrapper.stop();
          assertListenerClosed(retained);
        }
      },
      () => h.cleanup(),
    );
  });

for (const guild of [false, true])
  test(`real child exact ${guild ? 'guild' : 'global'} CRUD, no-op, state and Gateway boundaries`, async () => {
    await withRuntime({}, async (h) => {
      assert.equal(h.state().revision, 0);
      assert.equal(h.session.snapshot().coreState.stateRevision, 0);
      const initialResources = h.state().snapshot().resources.length;
      const peer = await h.identify();
      const route = guild ? guildPath : globalPath;
      success((await h.child(route)).result, 200, [], '0');
      const post = (await h.child(route, 'POST', { name: 'ping', description: 'Ping' })).result;
      assert.equal(peer.packets.find((p) => p.t === 'READY').d.application.id, h.app);
      const id = canonical(post.body.id),
        command = expected(id, h.app, { guild });
      success(post, 201, command, '1');
      assert.equal(h.state().revision, 1);
      assert.equal(h.session.snapshot().coreState.totalResources, initialResources + 1);
      assert.equal(h.session.snapshot().coreState.truncated, true);
      success(
        (await h.child(route, 'POST', { name: 'ping', description: 'Ping', options: [] })).result,
        200,
        command,
        '1',
      );
      const patched = expected(id, h.app, { guild, description: 'Pong', version: '2' });
      success(
        (await h.child(`${route}/${id}`, 'PATCH', { description: 'Pong' })).result,
        200,
        patched,
        '2',
      );
      success((await h.child(`${route}/${id}`)).result, 200, patched, '2');
      success((await h.child(route)).result, 200, [patched], '2');
      assert.deepEqual((await h.read(route)).body, [patched]);
      failure((await h.child(`${guild ? globalPath : guildPath}/${id}`)).result, 'command');
      success((await h.child(`${route}/${id}`, 'DELETE')).result, 204, null, '3');
      failure((await h.child(`${route}/${id}`, 'DELETE')).result, 'command');
      assert.equal(h.state().revision, 3);
      await peer.barrier();
      assert.deepEqual(
        peer.packets.filter((p) => p.t && p.t !== 'READY'),
        [],
      );
      assert.equal(h.interactions(), 0);
      assert.equal(h.state().list('message').length, 0);
      assert.ok(h.events.some((e) => e.snapshot?.coreState?.stateRevision === 1));
      h.projection();
    });
  });

test('real child bulk has literal request order, context types, one revision and scope isolation', async () => {
  await withRuntime({}, async (h) => {
    assert.equal(h.state().revision, 0);
    const bulk = (
      await h.child(globalPath, 'PUT', [
        { name: 'ping', description: 'Ping' },
        { type: 2, name: 'Inspect User' },
      ])
    ).result;
    const [a, b] = bulk.body.map((x) => canonical(x.id));
    assert.notEqual(a, b);
    const globals = [expected(a, h.app), expected(b, h.app, { type: 2, name: 'Inspect User' })];
    success(bulk, 200, globals, '1');
    const g = (await h.child(guildPath, 'POST', { type: 3, name: 'Inspect Message' })).result;
    const guild = expected(canonical(g.body.id), h.app, {
      guild: true,
      type: 3,
      name: 'Inspect Message',
      version: '2',
    });
    success(g, 201, guild, '2');
    success((await h.child(globalPath)).result, 200, globals, '2');
    success((await h.child(globalPath, 'PUT', [])).result, 200, [], '3');
    success((await h.child(guildPath)).result, 200, [guild], '3');
    const user = (await h.child(guildPath, 'POST', { type: 2, name: 'Inspect Message' })).result;
    success(
      user,
      201,
      expected(canonical(user.body.id), h.app, {
        guild: true,
        type: 2,
        name: 'Inspect Message',
        version: '4',
      }),
      '4',
    );
    const slash = (
      await h.child(guildPath, 'POST', { name: 'ping', description: 'Ping', options: [] })
    ).result;
    success(
      slash,
      201,
      expected(canonical(slash.body.id), h.app, { guild: true, version: '5' }),
      '5',
    );
    assert.equal((await h.read(guildPath)).body.length, 3);
    success((await h.child(guildPath, 'PUT', [])).result, 200, [], '6');
    success((await h.child(globalPath)).result, 200, [], '6');
  });
});

test('real child literal failures, raw paths, atomic mixed bulk, and faulty success claim rejected by oracle', async () => {
  await withRuntime({}, async (h) => {
    for (const credential of ['missing', 'Bot wrong-credential-sentinel', 'bearer'])
      failure((await h.child(globalPath, 'GET', undefined, { credential })).result, 'unauthorized');
    for (const [path, method, body, error] of [
      ['/applications/1/commands', 'GET', undefined, 'access'],
      ['/applications/{app}/guilds/9999/commands', 'GET', undefined, 'access'],
      [`${globalPath}/1`, 'GET', undefined, 'command'],
      [
        globalPath,
        'POST',
        { name: 'ping', description: 'Ping', options: [{ type: 3, name: 'x', description: 'X' }] },
        'feature',
      ],
      [globalPath, 'POST', { type: 2, name: 'User', options: [] }, 'feature'],
      [globalPath, 'POST', { name: 'ping', description: 'Ping', application_id: '1' }, 'feature'],
      [globalPath, 'POST', { name: 'INVALID NAME', description: 'Ping' }, 'payload'],
      ['/applications/01/commands', 'GET', undefined, 'route'],
      ['/applications/{app}/commands/../commands', 'GET', undefined, 'route'],
      ['/applications/{app}/commands?x=1', 'GET', undefined, 'payload'],
      [globalPath, 'OPTIONS', undefined, 'unsupportedRoute'],
    ])
      failure((await h.child(path, method, body)).result, error);
    assert.equal(h.state().revision, 0);
    const post = (await h.child(globalPath, 'POST', { name: 'ping', description: 'Ping' })).result;
    const command = expected(canonical(post.body.id), h.app);
    success(post, 201, command, '1');
    failure(
      (await h.child(`${globalPath}/${post.body.id}`, 'PATCH', { type: 2 })).result,
      'feature',
    );
    failure(
      (
        await h.child(globalPath, 'PUT', [
          { name: 'good', description: 'Good' },
          { type: 2, name: 'User', options: [] },
        ])
      ).result,
      'feature',
    );
    assert.equal(h.state().revision, 1);
    assert.deepEqual((await h.read()).body, [command]);
    const faulty = await h.child(
      globalPath,
      'POST',
      { type: 2, name: 'User', options: [] },
      { faulty: true },
    );
    assert.equal(faulty.claimedSuccess, true);
    failure(faulty.result, 'feature');
    assert.throws(
      () => success(faulty.result, 201, expected('1', h.app, { type: 2, name: 'User' }), '2'),
      { code: 'ERR_ASSERTION' },
    );
    assert.equal(h.state().revision, 1);
  });
});

test('omission disables real-child registration and global-only opt-in does not infer installed guilds', async () => {
  await withRuntime({ enabled: false }, async (h) => {
    failure((await h.child(globalPath)).result, 'disabled');
    assert.equal(h.state().revision, 0);
  });
  await withRuntime({ guildIds: [] }, async (h) => {
    success((await h.child()).result, 200, [], '0');
    failure((await h.child(guildPath)).result, 'access');
  });
});

test('real retained state undo, redo, restore, guild removal, reset and corrupt records are immediately authoritative', async () => {
  await withRuntime({}, async (h) => {
    const state = h.state(),
      initial = state.snapshot();
    assert.equal(state.revision, 0);
    const post = (await h.child(guildPath, 'POST', { name: 'ping', description: 'Ping' })).result;
    const command = expected(canonical(post.body.id), h.app, { guild: true });
    success(post, 201, command, '1');
    const registered = state.snapshot();
    assert.equal(state.undo(), true);
    assert.equal(state.revision, 2);
    success((await h.child(guildPath)).result, 200, [], '2');
    assert.equal(state.redo(), true);
    assert.equal(state.revision, 3);
    success((await h.child(guildPath)).result, 200, [command], '3');
    state.delete('guild', '1000');
    assert.equal(state.revision, 4);
    failure((await h.child(guildPath)).result, 'guild');
    state.restore(registered);
    assert.equal(state.revision, 5);
    success((await h.child(guildPath)).result, 200, [command], '5');
    success(
      (await h.child(`${guildPath}/${command.id}`, 'PATCH', { description: 'Pong' })).result,
      200,
      expected(command.id, h.app, { guild: true, description: 'Pong', version: '6' }),
      '6',
    );
    state.restore(registered);
    assert.equal(state.revision, 7);
    success((await h.child(`${guildPath}/${command.id}`)).result, 200, command, '7');
    // Existing public reset clears the store; restore the captured fixture snapshot explicitly.
    state.reset();
    assert.equal(state.revision, 8);
    success((await h.child(globalPath)).result, 200, [], '8');
    failure((await h.child(guildPath)).result, 'guild');
    state.restore(initial);
    assert.equal(state.revision, 9);
    success((await h.child(guildPath)).result, 200, [], '9');
    state.restore(registered);
    assert.equal(state.revision, 10);
    const record = state.list().find((r) => r.id === command.id);
    assert.ok(record);
    assert.equal(record.resourceType, 'application-command');
    state.update('application-command', command.id, {
      registry_profile: 'private-registry-sentinel',
    });
    assert.equal(state.revision, 11);
    failure((await h.child(guildPath)).result, 'corrupt');
    assert.equal(state.revision, 11);
    h.projection();
    state.restore(registered);
    assert.equal(state.revision, 12);
    success((await h.child(guildPath)).result, 200, [command], '12');
  });
});

test('failed cleanup preserves ownership, blocks restart/reselection and retry isolates fresh runtime credentials and registry', async () => {
  await withRuntime({}, async (h) => {
    const post = (await h.child(globalPath, 'POST', { name: 'ping', description: 'Ping' })).result;
    success(post, 201, expected(canonical(post.body.id), h.app), '1');
    const old = { run: h.run, started: h.started, state: h.state() };
    h.failStop(true);
    const failed = await h.session.stop();
    assert.equal(failed.ok, false);
    assert.equal(h.session.snapshot().coreState.runId, old.started.runId);
    assert.equal(h.session.snapshot().coreState.stateRevision, 1);
    await assert.rejects(h.session.start(), /cleanup/);
    await assert.rejects(h.session.selectProject(h.root), /cleanup/);
    assert.deepEqual((await h.read()).body, [expected(post.body.id, h.app)]);
    h.failStop(false);
    assert.equal((await h.session.stop()).ok, true);
    assert.equal(h.session.snapshot().coreState, null);
    for (const record of h.listeners) assertListenerClosed(record);
    await h.start();
    assert.notEqual(h.run.token, old.run.token);
    assert.notEqual(h.run.peer, old.run.peer);
    assert.notEqual(h.state(), old.state);
    assert.equal(h.state().revision, 0);
    success((await h.child()).result, 200, [], '0');
    failure(await h.read(globalPath, old.run.token), 'unauthorized');
    failure(
      (await h.child(globalPath, 'GET', undefined, { credential: `Bot ${old.run.token}` })).result,
      'unauthorized',
    );
  });
});

test('simultaneous supervised sessions have isolated credentials and stores without assuming globally distinct app IDs', async () => {
  const a = await harness();
  let b;
  await withCleanup(
    async () => {
      await a.start();
      b = await harness();
      await b.start();
      const post = (await a.child(globalPath, 'POST', { name: 'ping', description: 'Ping' }))
        .result;
      success(post, 201, expected(canonical(post.body.id), a.app), '1');
      success((await b.child()).result, 200, [], '0');
      assert.notEqual(a.state(), b.state());
      assert.notEqual(a.run.token, b.run.token);
      failure(await b.read(globalPath, a.run.token), 'unauthorized');
      failure(await a.read(globalPath, b.run.token), 'unauthorized');
      failure(
        (
          await a.child(
            globalPath,
            'POST',
            { name: 'cross', description: 'Denied' },
            { credential: `Bot ${b.run.token}` },
          )
        ).result,
        'unauthorized',
      );
      assert.equal(a.state().revision, 1);
      assert.equal(b.state().revision, 0);
      const guild = (await b.child(guildPath, 'POST', { type: 2, name: 'Inspect User' })).result;
      success(
        guild,
        201,
        expected(canonical(guild.body.id), b.app, { guild: true, type: 2, name: 'Inspect User' }),
        '1',
      );
      success((await a.child(guildPath)).result, 200, [], '1');
      assert.deepEqual((await a.read()).body, [expected(post.body.id, a.app)]);
      success((await b.child()).result, 200, [], '1');
    },
    async () => {
      if (b) await b.cleanup();
    },
    () => a.cleanup(),
  );
});

test('selected configuration is detached from file edits until reselect, including installed guild authority', async () => {
  const h = await harness();
  await withCleanup(
    async () => {
      const path = join(h.root, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      delete config.profile.commandRegistry;
      await writeFile(path, JSON.stringify(config));
      await h.start();
      success((await h.child(guildPath)).result, 200, [], '0');
      assert.equal((await h.session.stop()).ok, true);
      await h.start();
      success((await h.child(guildPath)).result, 200, [], '0');
      assert.equal((await h.session.stop()).ok, true);
      await h.session.selectProject(h.root);
      await h.start();
      failure((await h.child()).result, 'disabled');
    },
    () => h.cleanup(),
  );
});

for (const guild of [false, true])
  for (const type of [2, 3]) {
    test(`fresh ${guild ? 'guild' : 'global'} type ${type} child object has exact context-command keys`, async () => {
      await withRuntime({}, async (h) => {
        assert.equal(h.state().revision, 0);
        const route = guild ? guildPath : globalPath;
        const name = type === 2 ? 'Inspect User' : 'Inspect Message';
        const post = (await h.child(route, 'POST', { type, name })).result;
        const object = expected(canonical(post.body.id), h.app, { guild, type, name });
        success(post, 201, object, '1');
        success((await h.child(`${route}/${post.body.id}`)).result, 200, object, '1');
        const read = await h.read(route);
        success(read, 200, [object], '1');
        assert.equal(h.interactions(), 0);
        assert.equal(h.state().list('message').length, 0);
      });
    });
  }

test('fresh guild bulk uses one commit, explicit per-type objects and preserves global scope', async () => {
  await withRuntime({}, async (h) => {
    assert.equal(h.state().revision, 0);
    const result = (
      await h.child(guildPath, 'PUT', [
        { name: 'ping', description: 'Ping' },
        { type: 2, name: 'Inspect User' },
      ])
    ).result;
    const [a, b] = result.body.map((x) => canonical(x.id));
    assert.notEqual(a, b);
    const objects = [
      expected(a, h.app, { guild: true }),
      expected(b, h.app, { guild: true, type: 2, name: 'Inspect User' }),
    ];
    success(result, 200, objects, '1');
    success(await h.read(guildPath), 200, objects, '1');
    success((await h.child(globalPath)).result, 200, [], '1');
    success(
      (
        await h.child(guildPath, 'PUT', [
          { name: 'ping', description: 'Ping' },
          { type: 2, name: 'Inspect User' },
        ])
      ).result,
      200,
      objects,
      '1',
    );
    assert.equal(h.state().revision, 1);
    failure(
      (
        await h.child(guildPath, 'PUT', [
          { name: 'valid', description: 'Valid' },
          { type: 3, name: 'Unsupported', options: [] },
        ])
      ).result,
      'feature',
    );
    success(await h.read(guildPath), 200, objects, '1');
    assert.equal(h.state().revision, 1);
  });
});
