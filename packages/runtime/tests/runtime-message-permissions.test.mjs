import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BotRunner, VirtualState, SnowflakeGenerator, InteractionEngine } from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';

const requireCore = createRequire(import.meta.resolve('@disrunner/core'));
const { WebSocket } = requireCore('ws');
const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const human = { actorId: '3000', guildId: '1000', channelId: '2000' };
const denied = { code: 50013, message: 'Missing Permissions' };
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
async function assertClosed(url) {
  const result = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(error.code);
    });
  });
  assert.equal(result, 'ECONNREFUSED');
}
async function withRuntime(change, run) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-message-permissions-'));
  const runs = [],
    events = [],
    peers = [],
    endpoints = [],
    pids = [];
  let rest;
  const liveStates = [];
  const createdInteractions = [];
  const originalCreate = InteractionEngine.prototype.create;
  InteractionEngine.prototype.create = function (...args) {
    const interaction = originalCreate.apply(this, args);
    createdInteractions.push(interaction);
    return interaction;
  };
  const originalSubscribe = VirtualState.prototype.subscribeCommits;
  VirtualState.prototype.subscribeCommits = function (...args) {
    liveStates.push(this);
    return originalSubscribe.apply(this, args);
  };
  const session = createSessionWithDependencies(
    {
      onEndpoints(value) {
        if (value) endpoints.push(value);
      },
    },
    {
      wrapBot(original) {
        assert.ok(original instanceof BotRunner);
        return {
          async start(config) {
            runs.push({
              token: config.fakeToken,
              publicKey: config.env.DISRUNNER_PUBLIC_KEY,
              peerSecret: config.interactionPeerSecret,
            });
            const result = await original.start(config);
            pids.push(result.pid);
            return result;
          },
          stop: (...args) => original.stop(...args),
          snapshot: () => original.snapshot(),
          observeExit: () => original.observeExit(),
        };
      },
      wrapRest(original) {
        rest = original;
        return original;
      },
    },
  );
  session.subscribe((event) => events.push(event));
  try {
    await cp(example, root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, 'discord-simulator.config.json'), 'utf8'));
    config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
    config.bot.entryPoint = 'src/legacy-permissions-entry.mjs';
    config.bot.startCommand = 'node src/legacy-permissions-entry.mjs';
    // Preserve the real signed example transport while pinning the legacy route profile.
    await writeFile(
      join(root, config.bot.entryPoint),
      `import {createWebhookServer,loadServerOptionsFromEnvironment} from './server.mjs';
const options=loadServerOptionsFromEnvironment();
const server=createWebhookServer(options);
server.listen(options.port,options.host);
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
    );
    config.profile.ordinaryMessagePermissions = 'guild-text-own-messages-v1';
    config.fixtures.bot = 'fixtures/bot.json';
    const guild = {
      version: 1,
      guild: {
        id: '1000',
        owner_id: '9000',
        roles: [
          { id: '1000', permissions: '0' },
          { id: '1100', permissions: '68608' },
        ],
        channels: [{ id: '2000', type: 0, permission_overwrites: [] }],
        members: [
          { id: '5100', user_id: '5000', roles: ['1100'] },
          { id: '5300', user_id: '3000', roles: [] },
        ],
      },
    };
    const bot = { version: 1, user: { id: '5000', bot: true, username: 'Fixture Bot' } };
    change({ config, guild: guild.guild, bot: bot.user });
    await writeFile(join(root, 'discord-simulator.config.json'), JSON.stringify(config));
    await writeFile(join(root, config.fixtures.guild), JSON.stringify(guild));
    await writeFile(join(root, 'fixtures/bot.json'), JSON.stringify(bot));
    await session.selectProject(root);
    const h = {
      session,
      createdInteractions,
      runs,
      events,
      state: () => {
        const state = liveStates.at(-1);
        assert.ok(state instanceof VirtualState);
        return state;
      },
      evidence: () => rest.messageEvidence(),
      async request(started, path, method = 'GET', body, token = runs.at(-1).token) {
        const response = await fetch(`${started.endpoints.restBaseUrl}${path}`, {
          method,
          headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        return {
          status: response.status,
          body: response.status === 204 ? null : await response.json(),
          headers: response.headers,
        };
      },
      async identify(started) {
        const socket = new WebSocket(started.endpoints.gatewayUrl);
        const peer = { socket, packets: [] };
        peers.push(peer);
        socket.on('message', (data) => peer.packets.push(JSON.parse(data.toString())));
        socket.on('error', () => {});
        await until(() => peer.packets.some((p) => p.op === 10), 'HELLO');
        socket.send(JSON.stringify({ op: 2, d: { token: runs.at(-1).token, intents: 512 } }));
        await until(() => peer.packets.some((p) => p.t === 'READY'), 'READY');
        return peer;
      },
      async barrier(peer) {
        const count = peer.packets.filter((p) => p.op === 11).length;
        peer.socket.send(JSON.stringify({ op: 1, d: null }));
        await until(
          () => peer.packets.filter((p) => p.op === 11).length === count + 1,
          'heartbeat barrier',
        );
      },
    };
    await run(h);
    const serialized = JSON.stringify({
      events,
      snapshot: session.snapshot(),
      evidence: rest?.messageEvidence(),
    });
    for (const credentials of runs) {
      assert.ok(!serialized.includes(credentials.token), 'token must not escape');
      assert.ok(!serialized.includes(credentials.peerSecret), 'peer secret must not escape');
    }
  } finally {
    VirtualState.prototype.subscribeCommits = originalSubscribe;
    InteractionEngine.prototype.create = originalCreate;
    try {
      assert.equal((await session.dispose()).ok, true);
      for (const peer of peers)
        await until(() => peer.socket.readyState === WebSocket.CLOSED, 'server-driven WS closure');
      for (const endpoint of endpoints) {
        await assertClosed(endpoint.restBaseUrl);
        await assertClosed(endpoint.gatewayUrl);
      }
      for (const pid of pids)
        await until(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return error.code === 'ESRCH';
          }
        }, 'owned child exit');
    } finally {
      for (const peer of peers)
        if (peer.socket.readyState !== WebSocket.CLOSED) peer.socket.terminate();
      await rm(root, { recursive: true, force: true });
    }
  }
}
function stableState(h) {
  const { revision, snapshot } = h.state().revisionedSnapshot();
  return {
    revision,
    resources: snapshot.resources,
    hash: snapshot.hash,
    history: h.state().mutationHistory(),
  };
}
function successIdentity(body) {
  assert.equal(body.id, '5000');
  assert.equal(body.bot, true);
}
function noSuccessHeaders(response) {
  for (const key of ['x-disrunner-state-revision', 'x-disrunner-event-id', 'x-disrunner-delivery'])
    assert.equal(response.headers.get(key), null);
}

test('strict shared runtime uses fixed bot identity through state, WS, REST and interaction, preserving fresh runs', async () => {
  await withRuntime(
    () => {},
    async (h) => {
      assert.deepEqual(h.session.snapshot().contexts, [human]);
      const started = await h.session.start();
      const peer = await h.identify(started);
      successIdentity(peer.packets.find((p) => p.t === 'READY').d.user);
      const me = await h.request(started, '/users/@me');
      assert.equal(me.status, 200);
      successIdentity(me.body);
      assert.equal(me.body.username, 'DisRunner Bot');
      successIdentity(h.state().get('user', '5000'));
      assert.equal(h.state().get('user', '5000').username, 'Fixture Bot');
      const app = await h.request(started, '/oauth2/applications/@me');
      assert.equal(app.status, 200);
      assert.notEqual(app.body.id, '5000');
      assert.notEqual(app.body.owner.id, '5000');
      assert.notEqual(app.body.owner.id, app.body.id);
      assert.ok(!['3000', '5000'].includes(app.body.id));
      assert.ok(!['3000', '5000'].includes(app.body.owner.id));
      assert.deepEqual(h.session.snapshot().contexts, [human]);
      assert.throws(() => h.session.validateContext({ ...human, actorId: '5000' }), {
        code: 'invalid',
      });
      const created = await h.request(started, '/channels/2000/messages', 'POST', {
        content: 'strict allowed',
      });
      assert.equal(created.status, 200);
      successIdentity(created.body.author);
      const id = created.body.id;
      const listed = await h.request(started, '/channels/2000/messages');
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.body.map((m) => m.id),
        [id],
      );
      const fetched = await h.request(started, `/channels/2000/messages/${id}`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.content, 'strict allowed');
      const updated = await h.request(started, `/channels/2000/messages/${id}`, 'PATCH', {
        content: 'strict edited',
      });
      assert.equal(updated.status, 200);
      const deleted = await h.request(started, `/channels/2000/messages/${id}`, 'DELETE');
      assert.equal(deleted.status, 204);
      await h.barrier(peer);
      assert.deepEqual(
        peer.packets.filter((p) => p.t?.startsWith('MESSAGE_')).map((p) => p.t),
        ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE'],
      );
      for (const response of [created, updated, deleted]) {
        const eventId = response.headers.get('x-disrunner-event-id');
        assert.equal(typeof eventId, 'string');
        assert.equal(h.evidence().records.filter((r) => r.event.eventId === eventId).length, 1);
      }
      h.state().update('role', '1100', { permissions: '0' });
      const invocation = await h.session.invoke({
        runId: started.runId,
        requestId: 'strict-interaction',
        input: '/ping',
        context: human,
      });
      assert.equal(invocation.ok, true);
      assert.equal(invocation.response.data.content, 'Pong! Offline and deterministic.');
      const interactionMessages = h
        .state()
        .list('message')
        .filter((r) => r.message_origin === 'interaction');
      assert.equal(interactionMessages.length, 1);
      successIdentity(interactionMessages[0].author);
      const interaction = h.createdInteractions.find(
        (item) => item.id === invocation.interactionId,
      );
      assert.ok(interaction, 'the real interaction engine issued the token');
      const followup = await h.request(
        started,
        `/webhooks/${app.body.id}/${interaction.token}`,
        'POST',
        { content: 'token-authorized followup' },
      );
      assert.equal(followup.status, 200);
      successIdentity(followup.body.author);
      h.state().update('role', '1100', { permissions: '68608' });
      const ordinaryHistory = await h.request(started, '/channels/2000/messages');
      assert.equal(ordinaryHistory.status, 200);
      assert.deepEqual(ordinaryHistory.body, []);
      const snapshot = h.session.snapshot().coreState;
      assert.ok(snapshot.truncated);
      assert.ok(!snapshot.resources.some((r) => ['role', 'member'].includes(r.resourceType)));
      for (const resource of snapshot.resources)
        for (const field of ['roles', 'permission_overwrites', 'owner_id', 'members'])
          assert.equal(resource[field], undefined);
      const first = h.runs[0];
      assert.equal((await h.session.stop()).ok, true);
      const restarted = await h.session.start();
      const second = h.runs[1];
      assert.ok(first.token !== second.token, 'restart token is fresh');
      assert.ok(first.publicKey !== second.publicKey, 'restart signing identity is fresh');
      assert.ok(first.peerSecret !== second.peerSecret, 'restart peer secret is fresh');
      assert.notEqual(restarted.runId, started.runId);
      successIdentity((await h.request(restarted, '/users/@me')).body);
      assert.equal(
        (await h.request(restarted, '/users/@me', 'GET', undefined, first.token)).status,
        401,
      );
      await assert.rejects(
        h.session.invoke({
          runId: started.runId,
          requestId: 'stale',
          input: '/ping',
          context: human,
        }),
        { code: 'not-running' },
      );
    },
  );
});

test('live revocation denies every ordinary operation and no-op mutation without state/evidence/WS side effects', async () => {
  await withRuntime(
    () => {},
    async (h) => {
      const started = await h.session.start();
      const peer = await h.identify(started);
      const created = await h.request(started, '/channels/2000/messages', 'POST', {
        content: 'seed',
      });
      assert.equal(created.status, 200);
      const id = created.body.id;
      await h.barrier(peer);
      h.state().update('role', '1100', { permissions: '0' });
      const before = stableState(h);
      const evidence = h.evidence();
      const frames = peer.packets.filter((p) => p.t?.startsWith('MESSAGE_'));
      for (const [method, path, body] of [
        ['GET', '/channels/2000/messages'],
        ['GET', `/channels/2000/messages/${id}`],
        ['POST', '/channels/2000/messages', { content: 'denied' }],
        ['PATCH', `/channels/2000/messages/${id}`, { content: 'seed' }],
        ['DELETE', `/channels/2000/messages/${id}`],
      ]) {
        const response = await h.request(started, path, method, body);
        assert.equal(response.status, 403);
        assert.deepEqual(response.body, denied);
        noSuccessHeaders(response);
        assert.deepEqual(stableState(h), before);
        assert.deepEqual(h.evidence(), evidence);
      }
      await h.barrier(peer);
      assert.deepEqual(
        peer.packets.filter((p) => p.t?.startsWith('MESSAGE_')),
        frames,
      );
    },
  );
});

for (const [name, change] of [
  [
    'missing member',
    ({ guild }) => {
      delete guild.members;
    },
  ],
  [
    'resource id is not membership',
    ({ guild }) => {
      guild.members[0] = { id: '5000', user_id: '3000', user: { id: '5000' }, roles: ['1100'] };
    },
  ],
  [
    'ambiguous member',
    ({ guild }) => {
      guild.members.push({ id: '5200', user_id: '5000', roles: ['1100'] });
    },
  ],
  [
    'missing roles',
    ({ guild }) => {
      delete guild.members[0].roles;
    },
  ],
  [
    'missing assigned role',
    ({ guild }) => {
      guild.members[0].roles = ['missing'];
    },
  ],
  [
    'malformed permissions',
    ({ guild }) => {
      guild.roles[1].permissions = ' 68608';
    },
  ],
  [
    'missing overwrites',
    ({ guild }) => {
      delete guild.channels[0].permission_overwrites;
    },
  ],
  [
    'invalid timeout',
    ({ guild }) => {
      guild.members[0].communication_disabled_until = 'tomorrow';
    },
  ],
  [
    'invalid owner',
    ({ guild }) => {
      guild.owner_id = 'not-an-id';
    },
  ],
  [
    'explicit zero',
    ({ guild }) => {
      guild.roles[1].permissions = '0';
    },
  ],
]) {
  test(`semantic negative ${name} starts without repair and returns permission denial`, async () => {
    await withRuntime(change, async (h) => {
      const started = await h.session.start();
      assert.equal(started.phase, 'running');
      const before = stableState(h);
      const evidence = h.evidence();
      const response = await h.request(started, '/channels/2000/messages', 'POST', {
        content: 'must deny',
      });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, denied);
      noSuccessHeaders(response);
      assert.deepEqual(stableState(h), before);
      assert.deepEqual(h.evidence(), evidence);
    });
  });
}
test('literal permission bits distinguish history, send and own mutation, and overwrite uses bot user id', async () => {
  await withRuntime(
    ({ guild }) => {
      guild.roles[1].permissions = '3072';
    },
    async (h) => {
      const started = await h.session.start();
      const created = await h.request(started, '/channels/2000/messages', 'POST', {
        content: 'no history',
      });
      assert.equal(created.status, 200);
      const id = created.body.id;
      const listed = await h.request(started, '/channels/2000/messages');
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body, []);
      assert.equal((await h.request(started, `/channels/2000/messages/${id}`)).status, 403);
      h.state().update('role', '1100', { permissions: '66560' });
      assert.equal(
        (await h.request(started, '/channels/2000/messages', 'POST', { content: 'no send' }))
          .status,
        403,
      );
      assert.equal(
        (
          await h.request(started, `/channels/2000/messages/${id}`, 'PATCH', {
            content: 'own edit',
          })
        ).status,
        200,
      );
      assert.equal(
        (await h.request(started, `/channels/2000/messages/${id}`, 'DELETE')).status,
        204,
      );
      h.state().update('role', '1100', { permissions: '68608' });
      h.state().update('channel', '2000', {
        permission_overwrites: [{ id: '5000', type: 1, deny: '2048', allow: '0' }],
      });
      assert.equal(
        (
          await h.request(started, '/channels/2000/messages', 'POST', {
            content: 'overwrite denied',
          })
        ).status,
        403,
      );
      assert.equal((await h.request(started, '/channels/2000/messages')).status, 200);
      h.state().update('channel', '2000', {
        permission_overwrites: [{ id: '5100', type: 1, deny: '2048', allow: '0' }],
      });
      assert.equal(
        (
          await h.request(started, '/channels/2000/messages', 'POST', {
            content: 'not the bot overwrite',
          })
        ).status,
        200,
      );
    },
  );
});
test('fixture presentation cannot trigger late bootstrap parsing failure', async () => {
  await withRuntime(
    ({ bot }) => {
      bot.username = { arbitrary: true };
      bot.avatar = 1;
      bot.discriminator = null;
    },
    async (h) => {
      const started = await h.session.start();
      const me = await h.request(started, '/users/@me');
      assert.equal(me.status, 200);
      successIdentity(me.body);
      assert.equal(me.body.username, 'DisRunner Bot');
    },
  );
});

test('strict synthetic application and owner skip imported user and generated identity collisions', async () => {
  const generate = SnowflakeGenerator.prototype.generate;
  const candidates = ['3000', '5000', '7000', '7000', '8000'];
  SnowflakeGenerator.prototype.generate = function (...args) {
    return candidates.shift() ?? generate.apply(this, args);
  };
  try {
    await withRuntime(
      () => {},
      async (h) => {
        const started = await h.session.start();
        const application = await h.request(started, '/oauth2/applications/@me');
        assert.equal(application.status, 200);
        assert.equal(application.body.id, '7000');
        assert.equal(application.body.owner.id, '8000');
        successIdentity((await h.request(started, '/users/@me')).body);
      },
    );
  } finally {
    SnowflakeGenerator.prototype.generate = generate;
  }
});
for (const profile of [undefined, 'legacy-unenforced']) {
  test(`legacy profile ${profile} keeps generated identity and ordinary behavior without membership`, async () => {
    await withRuntime(
      ({ config, guild }) => {
        config.profile.ordinaryMessagePermissions = profile;
        delete config.fixtures.bot;
        delete guild.members;
        guild.roles[1].permissions = '0';
        delete guild.channels[0].permission_overwrites;
      },
      async (h) => {
        const started = await h.session.start();
        assert.deepEqual(h.session.snapshot().contexts, [human]);
        const me = await h.request(started, '/users/@me');
        assert.equal(me.status, 200);
        assert.notEqual(me.body.id, '5000');
        assert.notEqual(me.body.id, '3000');
        assert.equal(me.body.username, 'DisRunner Bot');
        const response = await h.request(started, '/channels/2000/messages', 'POST', {
          content: 'legacy preserved',
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.author.id, me.body.id);
        assert.equal(h.state().list('member').length, 0);
      },
    );
  });
}
