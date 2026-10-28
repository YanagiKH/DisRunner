// End-to-end acceptance requires the actual revisioned VirtualState implementation.
// No revision doubles, legacy success branch, synthetic BotRunner, or external Discord traffic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BotRunner } from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';

const requireCore = createRequire(import.meta.resolve('@disrunner/core'));
const { WebSocket } = requireCore('ws');
const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const messages = (peer) => peer.packets.filter((packet) => /^MESSAGE_/u.test(packet.t ?? ''));

async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function harness({ modern = false } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'authoritative-pipeline-'));
  await cp(example, project, { recursive: true });
  if (!modern) {
    const configPath = join(project, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
    config.bot.entryPoint = 'src/legacy-pipeline-entry.mjs';
    config.bot.startCommand = 'node src/legacy-pipeline-entry.mjs';
    await writeFile(configPath, JSON.stringify(config));
    // Launch the same signed server without the current example's v2 registry bootstrap.
    await writeFile(
      join(project, config.bot.entryPoint),
      `import {createWebhookServer,loadServerOptionsFromEnvironment} from './server.mjs';
const options=loadServerOptionsFromEnvironment();
const server=createWebhookServer(options);
server.listen(options.port,options.host);
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
    );
  }
  // Keep the authoritative fixture unchanged, including its valid role records.
  // The runtime display projection omits roles and explicitly reports truncation;
  // these tests qualify selected message records, not a complete-state export.
  const runs = [];
  const events = [];
  const peers = [];
  const startedEndpoints = new Set();
  const startedPids = new Set();
  let rest;
  let failRestStop = false;
  const session = createSessionWithDependencies(
    {
      onEndpoints(endpoints) {
        if (endpoints === null) return;
        // Capture each actually bound run, including a later startup failure.
        startedEndpoints.add(endpoints.restBaseUrl);
        startedEndpoints.add(endpoints.gatewayUrl);
      },
    },
    {
      wrapBot(original) {
        assert.ok(original instanceof BotRunner);
        return {
          async start(config) {
            // Test memory only: never write credentials to a fixture, diagnostic, or log.
            runs.push({ token: config.fakeToken, peerSecret: config.interactionPeerSecret });
            try {
              const result = await original.start(config);
              assert.ok(
                Number.isSafeInteger(result.pid) && result.pid > 0,
                'Real BotRunner startup must expose its child PID.',
              );
              startedPids.add(result.pid);
              return result;
            } finally {
              // Also retain an observed child when startup fails after spawning.
              const pid = original.snapshot().pid;
              if (Number.isSafeInteger(pid) && pid > 0) startedPids.add(pid);
            }
          },
          stop: (...args) => original.stop(...args),
          snapshot: () => original.snapshot(),
          observeExit: () => original.observeExit(),
        };
      },
      wrapRest(original) {
        rest = original;
        return {
          start: (...args) => original.start(...args),
          stop: () =>
            failRestStop
              ? Promise.reject(new Error('Injected REST cleanup failure.'))
              : original.stop(),
        };
      },
    },
  );
  session.subscribe((event) => events.push(event));
  const h = {
    session,
    runs,
    events,
    peers,
    project,
    evidence: () => rest.messageEvidence(),
    failCleanup(value) {
      failRestStop = value;
    },
    async start() {
      const snapshot = await session.start();
      assert.equal(snapshot.phase, 'running');
      const core = authoritative(snapshot);
      assert.equal(core.runId, snapshot.runId);
      return snapshot;
    },
    async connect(url) {
      const socket = new WebSocket(url);
      const peer = { socket, packets: [], errors: [] };
      peers.push(peer);
      socket.on('message', (data) => peer.packets.push(JSON.parse(data.toString())));
      socket.on('error', () => peer.errors.push('socket-error'));
      await until(() => peer.packets.some((p) => p.op === 10), 'Gateway HELLO');
      return peer;
    },
    async identify(started) {
      const peer = await h.connect(started.endpoints.gatewayUrl);
      peer.socket.send(JSON.stringify({ op: 2, d: { token: runs.at(-1).token, intents: 512 } }));
      await until(() => peer.packets.some((p) => p.t === 'READY'), 'Gateway READY');
      return peer;
    },
    assertSecretsAbsent(extra = {}) {
      const serialized = JSON.stringify({
        events,
        snapshot: session.snapshot(),
        evidence: h.evidence(),
        extra,
      });
      for (const run of runs) {
        assert.equal(typeof run.token, 'string');
        assert.equal(typeof run.peerSecret, 'string');
        assert.ok(!serialized.includes(run.token), 'Synthetic token leaked into evidence.');
        assert.ok(!serialized.includes(run.peerSecret), 'Peer secret leaked into evidence.');
      }
    },
    async close() {
      failRestStop = false;
      try {
        assert.equal((await session.dispose()).ok, true);
        // Observe server-driven socket closure, not merely our own terminate().
        await Promise.all(
          peers.map((peer) =>
            until(
              () => peer.socket.readyState === WebSocket.CLOSED,
              'disposed Gateway socket closure',
            ),
          ),
        );
        await Promise.all([...startedEndpoints].map(assertClosed));
        await Promise.all([...startedPids].map(assertChildExited));
      } finally {
        // Containment if an independent closure oracle fails; never call this proof.
        for (const peer of peers)
          if (peer.socket.readyState !== WebSocket.CLOSED) peer.socket.terminate();
        await rm(project, { recursive: true, force: true });
      }
    },
  };
  return h;
}

async function assertChildExited(pid) {
  // Signal 0 is a read-only existence probe. Do not send a termination signal or
  // treat BotRunner's own stopped report as independent process-exit evidence.
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      if (error?.code === 'EPERM') return false;
      throw new Error('Child process existence could not be verified.');
    }
  }, 'actual child process ESRCH');
}

async function assertClosed(url) {
  const outcome = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    socket.setTimeout(2_000);
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
  assert.equal(outcome, 'ECONNREFUSED', 'Disposed loopback listener must refuse connections.');
}

function authoritative(snapshot) {
  assert.ok(snapshot.coreState, 'Actual retained core snapshot is required.');
  assert.equal(snapshot.coreState.revisioned, true, 'Legacy State is not acceptance evidence.');
  assert.ok(Number.isSafeInteger(snapshot.coreState.stateRevision));
  assert.equal(snapshot.coreState.clock.mode, 'realtime');
  assert.equal(snapshot.coreState.clock.domain, 'bot');
  assert.ok(Number.isFinite(snapshot.coreState.clock.nowMs));
  assert.equal(snapshot.coreState.truncated, true, 'Role omission must remain explicit.');
  assert.ok(snapshot.coreState.totalResources > snapshot.coreState.resources.length);
  for (const [resourceType, id] of [
    ['guild', '1000'],
    ['channel', '2000'],
    ['user', '3000'],
  ]) {
    assert.ok(
      snapshot.coreState.resources.some(
        (resource) => resource.resourceType === resourceType && resource.id === id,
      ),
      `Required projected ${resourceType} context is missing.`,
    );
  }
  assert.equal(
    snapshot.coreState.resources.some((resource) => resource.resourceType === 'role'),
    false,
  );
  assert.equal(snapshot.coreState.runId, snapshot.runId);
  return snapshot.coreState;
}

async function request(started, token, path, method = 'GET', body) {
  return fetch(`${started.endpoints.restBaseUrl}${path}`, {
    method,
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
}

async function barrier(peer) {
  const before = peer.packets.filter((p) => p.op === 11).length;
  const sequence = peer.packets.filter((p) => Number.isInteger(p.s)).at(-1)?.s ?? null;
  peer.socket.send(JSON.stringify({ op: 1, d: sequence }));
  await until(
    () => peer.packets.filter((p) => p.op === 11).length === before + 1,
    'heartbeat barrier',
  );
}

function assertMutation(h, started, response, revision, type, id) {
  assert.equal(response.headers.get('x-disrunner-state-revision'), String(revision));
  assert.equal(response.headers.get('x-disrunner-delivery'), 'accepted');
  const eventId = response.headers.get('x-disrunner-event-id');
  assert.equal(typeof eventId, 'string');
  const evidence = h.evidence().records.filter(({ event }) => event.eventId === eventId);
  assert.equal(evidence.length, 1);
  const event = evidence[0].event;
  assert.equal(event.runId, started.runId);
  assert.equal(event.stateRevision, revision);
  assert.equal(event.clockDomain, 'realtime');
  assert.equal(event.origin, 'rest');
  assert.equal(event.payload.type, type);
  assert.equal(event.payload.message.id, id);
  assert.equal(event.payload.message.channel_id, '2000');
  assert.equal(event.payload.message.guild_id, '1000');
  const core = authoritative(h.session.snapshot());
  assert.equal(core.stateRevision, revision);
  const published = h.events.find(
    ({ snapshot }) =>
      snapshot.runId === started.runId && snapshot.coreState?.stateRevision === revision,
  );
  assert.ok(published, 'Commit must publish a revisioned Session snapshot.');
  const publishedCore = authoritative(published.snapshot);
  for (const key of ['resources', 'runId', 'stateRevision', 'truncated', 'totalResources']) {
    assert.deepEqual(
      publishedCore[key],
      core[key],
      `Published core ${key} must match actual authority.`,
    );
  }
  return core;
}

test(
  'real Session HTTP/WS/store share create/edit/delete authority and disconnected replay exactly once',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      await h.session.selectProject(h.project);
      const started = await h.start();
      const token = h.runs.at(-1).token;
      const peer = await h.identify(started);
      const ready = peer.packets.find((p) => p.t === 'READY');
      const meResponse = await request(started, token, '/users/@me');
      assert.equal(meResponse.status, 200);
      const me = await meResponse.json();
      const base = authoritative(h.session.snapshot()).stateRevision;
      const created = await request(started, token, '/channels/2000/messages', 'POST', {
        content: 'pipeline one',
      });
      assert.equal(created.status, 200);
      const message = await created.json();
      assert.match(message.id, /^[1-9]\d*$/u);
      assert.equal(message.author.id, me.id);
      assert.equal(message.author.bot, true);
      assert.equal(message.channel_id, '2000');
      assert.equal(message.guild_id, '1000');
      assert.equal(message.content, 'pipeline one');
      assert.equal(new Date(message.timestamp).toISOString(), message.timestamp);
      assert.equal(message.edited_timestamp, null);
      const core = assertMutation(h, started, created, base + 1, 'MESSAGE_CREATE', message.id);
      const stored = core.resources.find(
        (r) => r.resourceType === 'message' && r.id === message.id,
      );
      assert.equal(stored.content, 'pipeline one');
      assert.equal(stored.author.id, me.id);
      assert.equal(stored.channel_id, '2000');
      assert.equal(stored.guild_id, '1000');
      await barrier(peer);
      assert.deepEqual(messages(peer), [{ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message }]);

      const lastSequence = messages(peer)[0].s;
      peer.socket.close(1000, 'test disconnect');
      await until(() => peer.socket.readyState === WebSocket.CLOSED, 'original socket closure');
      const edited = await request(
        started,
        token,
        `/channels/2000/messages/${message.id}`,
        'PATCH',
        { content: 'pipeline two' },
      );
      assert.equal(edited.status, 200);
      const updated = await edited.json();
      assert.equal(updated.id, message.id);
      assert.equal(updated.content, 'pipeline two');
      assert.equal(updated.channel_id, '2000');
      assert.equal(updated.guild_id, '1000');
      assert.equal(updated.author.id, me.id);
      assert.equal(updated.author.bot, true);
      assert.equal(updated.author.username, 'DisRunner Bot');
      assert.equal(updated.timestamp, message.timestamp);
      assert.equal(new Date(updated.edited_timestamp).toISOString(), updated.edited_timestamp);
      assert.ok(Date.parse(updated.edited_timestamp) >= Date.parse(message.timestamp));
      const afterEdit = assertMutation(h, started, edited, base + 2, 'MESSAGE_UPDATE', message.id);
      assert.equal(afterEdit.resources.find((r) => r.id === message.id).content, 'pipeline two');
      const resumed = await h.connect(ready.d.resume_gateway_url);
      resumed.socket.send(
        JSON.stringify({ op: 6, d: { token, session_id: ready.d.session_id, seq: lastSequence } }),
      );
      await until(() => resumed.packets.some((p) => p.t === 'RESUMED'), 'Gateway RESUMED');
      await barrier(resumed);
      assert.deepEqual(messages(resumed), [{ op: 0, t: 'MESSAGE_UPDATE', s: 3, d: updated }]);
      assert.equal(h.evidence().records.length, 2, 'Replay cannot create another domain event.');

      const unchanged = await request(
        started,
        token,
        `/channels/2000/messages/${message.id}`,
        'PATCH',
        { content: 'pipeline two' },
      );
      assert.equal(unchanged.status, 200);
      await unchanged.json();
      assert.equal(unchanged.headers.get('x-disrunner-state-revision'), String(base + 2));
      assert.equal(unchanged.headers.get('x-disrunner-event-id'), null);
      await barrier(resumed);
      assert.equal(messages(resumed).length, 1);
      assert.equal(h.evidence().records.length, 2);
      assert.equal(authoritative(h.session.snapshot()).stateRevision, base + 2);

      const removed = await request(
        started,
        token,
        `/channels/2000/messages/${message.id}`,
        'DELETE',
      );
      assert.equal(removed.status, 204);
      const afterDelete = assertMutation(
        h,
        started,
        removed,
        base + 3,
        'MESSAGE_DELETE',
        message.id,
      );
      assert.equal(
        afterDelete.resources.some((r) => r.resourceType === 'message' && r.id === message.id),
        false,
      );
      await barrier(resumed);
      assert.deepEqual(messages(resumed), [
        { op: 0, t: 'MESSAGE_UPDATE', s: 3, d: updated },
        {
          op: 0,
          t: 'MESSAGE_DELETE',
          s: 5,
          d: { id: message.id, channel_id: '2000', guild_id: '1000' },
        },
      ]);
      const missing = await request(started, token, `/channels/2000/messages/${message.id}`);
      assert.equal(missing.status, 404);
      await missing.json();
      h.assertSecretsAbsent({ packets: [...peer.packets, ...resumed.packets] });
    } finally {
      await h.close();
    }
  },
);

test(
  'real Session rejects invalid auth/context/visibility without state or Gateway mutation',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      await h.session.selectProject(h.project);
      const started = await h.start();
      const token = h.runs.at(-1).token;
      const peer = await h.identify(started);
      const created = await request(started, token, '/channels/2000/messages', 'POST', {
        content: 'protected',
      });
      assert.equal(created.status, 200);
      const message = await created.json();
      await barrier(peer);
      const baseline = authoritative(h.session.snapshot());
      const eventCount = h.evidence().records.length;
      const packetCount = messages(peer).length;
      const invalid = [
        [
          '/channels/2000/messages',
          'POST',
          { content: 'bad' },
          'disrunner.offline.invalid-test-token',
          401,
        ],
        [`/channels/2100/messages/${message.id}`, 'PATCH', { content: 'bad' }, token, 404],
        ['/channels/999999/messages', 'POST', { content: 'bad' }, token, 404],
        ['/channels/2200/messages', 'POST', { content: 'bad' }, token, 400],
        [`/channels/2000/messages/${message.id}`, 'PATCH', { flags: 64 }, token, 400],
        [`/channels/2000/messages/${message.id}`, 'PATCH', { author: { id: '3000' } }, token, 400],
        [`/channels/2000/messages/${message.id}`, 'PATCH', { visibility: 'ephemeral' }, token, 400],
      ];
      for (const [path, method, body, credential, status] of invalid) {
        const response = await request(started, credential, path, method, body);
        assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(body)}`);
        await response.json();
        assert.equal(response.headers.get('x-disrunner-event-id'), null);
        await barrier(peer);
        const after = authoritative(h.session.snapshot());
        assert.equal(after.stateRevision, baseline.stateRevision);
        assert.deepEqual(after.resources, baseline.resources);
        assert.equal(h.evidence().records.length, eventCount);
        assert.equal(messages(peer).length, packetCount);
      }
      h.assertSecretsAbsent({ packets: peer.packets });
    } finally {
      await h.close();
    }
  },
);

test(
  'failed cleanup retains authoritative owner; successful retry and restart isolate stale credentials/sockets',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      await h.session.selectProject(h.project);
      const first = await h.start();
      const oldToken = h.runs.at(-1).token;
      const oldPeer = await h.identify(first);
      const response = await request(first, oldToken, '/channels/2000/messages', 'POST', {
        content: 'old run',
      });
      assert.equal(response.status, 200);
      const oldMessage = await response.json();
      await barrier(oldPeer);
      const before = authoritative(h.session.snapshot());
      h.failCleanup(true);
      assert.equal((await h.session.stop()).ok, false);
      const retained = authoritative(h.session.snapshot());
      assert.equal(retained.runId, first.runId);
      assert.equal(retained.stateRevision, before.stateRevision);
      assert.deepEqual(retained.resources, before.resources);
      await assert.rejects(h.session.start(), /cleanup/iu);
      await until(() => oldPeer.socket.readyState === WebSocket.CLOSED, 'old run Gateway closure');
      const oldPackets = oldPeer.packets.length;
      h.failCleanup(false);
      assert.equal((await h.session.stop()).ok, true);
      assert.equal(h.session.snapshot().coreState, null);
      const second = await h.start();
      assert.notEqual(second.runId, first.runId);
      const fresh = authoritative(h.session.snapshot());
      assert.equal(
        fresh.resources.some((r) => r.id === oldMessage.id),
        false,
      );
      const oldAuth = await request(second, oldToken, '/channels/2000/messages', 'POST', {
        content: 'stale',
      });
      assert.equal(oldAuth.status, 401);
      await oldAuth.json();
      assert.deepEqual(authoritative(h.session.snapshot()).resources, fresh.resources);
      assert.equal(authoritative(h.session.snapshot()).stateRevision, fresh.stateRevision);
      assert.equal(h.evidence().records.length, 0);
      const currentPeer = await h.identify(second);
      const current = await request(
        second,
        h.runs.at(-1).token,
        '/channels/2000/messages',
        'POST',
        { content: 'new run' },
      );
      assert.equal(current.status, 200);
      const currentMessage = await current.json();
      assertMutation(
        h,
        second,
        current,
        fresh.stateRevision + 1,
        'MESSAGE_CREATE',
        currentMessage.id,
      );
      await barrier(currentPeer);
      assert.equal(messages(currentPeer).length, 1);
      assert.equal(oldPeer.packets.length, oldPackets);
      h.assertSecretsAbsent({ packets: [...oldPeer.packets, ...currentPeer.packets] });
      assert.equal((await h.session.dispose()).ok, true);
      assert.equal(h.session.snapshot().coreState, null);
    } finally {
      await h.close();
    }
  },
);
