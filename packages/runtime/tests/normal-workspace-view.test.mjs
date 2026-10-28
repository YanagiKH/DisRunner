import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openWorkspace, saveWorkspace } from '../dist/workspace.js';
import { createSessionWithDependencies } from '../dist/session.js';

const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const guildId = '1000';
const botId = '5000';
const channelIds = Array.from({ length: 10 }, (_, index) => String(2000 + index));
const actorIds = [...Array.from({ length: 99 }, (_, index) => String(3000 + index)), botId];

function workload(perChannel = 100, longContent = false) {
  const resources = [
    { resourceType: 'guild', id: guildId, name: 'Normal workload', owner_id: '3000' },
    {
      resourceType: 'role',
      id: guildId,
      guild_id: guildId,
      name: '@everyone',
      permissions: '68608',
      position: 0,
    },
    {
      resourceType: 'role',
      id: '1100',
      guild_id: guildId,
      name: 'Bot',
      permissions: '402653200',
      position: 2,
    },
    {
      resourceType: 'role',
      id: '1200',
      guild_id: guildId,
      name: 'Member',
      permissions: '0',
      position: 1,
    },
    ...channelIds.map((id, index) => ({
      resourceType: 'channel',
      id,
      guild_id: guildId,
      type: 0,
      name: 'channel-' + index,
      permission_overwrites: [],
    })),
    ...actorIds.map((id) => ({
      resourceType: 'user',
      id,
      username: id === botId ? 'View Bot' : 'User ' + id,
      discriminator: '0',
      avatar: null,
      bot: id === botId,
    })),
    ...actorIds.map((user_id, index) => ({
      resourceType: 'member',
      id: String(6000 + index),
      guild_id: guildId,
      user_id,
      roles: user_id === botId ? ['1100'] : ['1200'],
      joined_at: '2015-01-01T00:00:00.000Z',
    })),
  ];
  for (let channel = 0; channel < channelIds.length; channel++) {
    for (let index = 0; index < perChannel; index++) {
      const offset = channel * perChannel + index;
      const authorId = actorIds[offset % 99];
      resources.push({
        resourceType: 'message',
        id: String(100000 + offset),
        channel_id: channelIds[channel],
        guild_id: guildId,
        type: 0,
        visibility: 'channel',
        flags: 0,
        author: { id: authorId, username: 'User ' + authorId, bot: false },
        content: longContent ? 'x'.repeat(2000) : `Channel ${channel}, message ${index}`,
        timestamp: new Date(1_420_070_400_000 + offset * 1000).toISOString(),
      });
    }
  }
  return { version: 1, resources, scenarios: [], options: { seed: 42042, mode: 'strict' } };
}

async function project(t, document) {
  const directory = await mkdtemp(join(tmpdir(), 'DisRunner normal 工作區 '));
  let session;
  let token;
  const endpoints = [];
  t.after(async () => {
    try {
      if (session) assert.equal((await session.dispose()).ok, true);
      for (const address of endpoints)
        for (const endpoint of Object.values(address)) await assertClosed(endpoint);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await cp(example, directory, { recursive: true });
  const configPath = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.profile.ordinaryMessagePermissions = 'guild-text-own-messages-v1';
  config.fixtures.bot = 'fixtures/view-bot.json';
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(directory, config.fixtures.bot),
    JSON.stringify({ version: 1, user: { id: botId, username: 'View Bot', bot: true } }),
  );
  // Actual Bot registration supplies 50 commands in addition to the persisted resources.
  await appendFile(
    join(directory, 'src/commands.mjs'),
    `\nLOCAL_COMMANDS.push(...Array.from({length:37},(_,index)=>({name:'workload-'+index,description:'Local workload command'})));\n`,
  );
  const saved = await saveWorkspace(directory, document, { expectedHash: null });
  session = createSessionWithDependencies(
    {
      onEndpoints: (value) => {
        if (value) endpoints.push(value);
      },
    },
    {
      wrapBot(runner) {
        const start = runner.start.bind(runner);
        runner.start = (configuration) => {
          token = configuration.fakeToken;
          return start(configuration);
        };
        return runner;
      },
    },
  );
  await session.selectProject(directory);
  const started = await session.start({ timeoutMs: 15000 });
  assert.equal(started.phase, 'running');
  assert.equal(session.snapshot().commands.length, 50);
  return {
    session,
    directory,
    saved,
    started,
    view(actorId = '3001') {
      const core = session.snapshotForActor(actorId).coreState;
      assert.ok(core?.revisioned, 'The view must come from the live revisioned store.');
      assert.equal(core.runId, started.runId);
      assert.ok(Buffer.byteLength(JSON.stringify(core.resources)) <= 1_048_576);
      return core;
    },
    async ping() {
      const result = await session.invoke({
        runId: started.runId,
        requestId: 'normal-workspace-ping',
        input: '/ping',
        context: { actorId: '3001', guildId, channelId: channelIds[9] },
      });
      assert.equal(result.ok, true);
      assert.equal(result.response.data.content, 'Pong! Offline and deterministic.');
      return result;
    },
    async revokeView() {
      const response = await fetch(started.endpoints.restBaseUrl + '/channels/' + channelIds[9], {
        method: 'PATCH',
        headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          permission_overwrites: [{ id: '3001', type: 1, allow: '0', deny: '1024' }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      await response.json();
    },
  };
}

function messages(view, channelId) {
  return view.resources.filter(
    (resource) =>
      resource.resourceType === 'message' &&
      (channelId === undefined || resource.channel_id === channelId),
  );
}
function assertStructure(view) {
  assert.equal(view.resources.filter((resource) => resource.resourceType === 'guild').length, 1);
  assert.equal(view.resources.filter((resource) => resource.resourceType === 'channel').length, 10);
  assert.equal(view.resources.filter((resource) => resource.resourceType === 'user').length, 100);
  assert.equal(view.resources.filter((resource) => resource.resourceType === 'member').length, 100);
  assert.equal(view.resources.filter((resource) => resource.resourceType === 'role').length, 3);
}

test(
  'normal saved workspace displays all 1000 messages, the real latest reply, and fresh viewer permissions',
  { timeout: 45000 },
  async (t) => {
    const data = workload();
    const h = await project(t, data);
    for (const actorId of ['3000', '3001', '3098', botId]) {
      const view = h.view(actorId);
      assert.equal(view.totalResources, 1264);
      assert.equal(view.evidenceComplete, true);
      assertStructure(view);
      assert.equal(messages(view).length, 1000);
      for (const channelId of channelIds)
        assert.equal(
          messages(view, channelId).length,
          100,
          `${actorId} must see every channel's history`,
        );
    }
    const reply = await h.ping();
    const visible = h.view();
    assert.equal(visible.evidenceComplete, true);
    assert.equal(messages(visible).length, 1001);
    assert.ok(
      messages(visible, channelIds[9]).some(
        (message) =>
          message.interaction_id === reply.interactionId &&
          message.author.bot === true &&
          message.content === 'Pong! Offline and deterministic.',
      ),
    );
    await h.revokeView();
    const denied = h.view();
    assert.ok(denied.stateRevision > visible.stateRevision);
    assert.equal(
      denied.resources.some(
        (resource) => resource.resourceType === 'channel' && resource.id === channelIds[9],
      ),
      false,
    );
    assert.equal(messages(denied, channelIds[9]).length, 0);
    assert.equal(messages(denied).length, 900);
    assert.equal(messages(h.view('3002'), channelIds[9]).length, 101);
    const source = await openWorkspace(h.directory);
    assert.equal(source.hash, h.saved.hash);
    assert.deepEqual(
      source.document,
      data,
      'Running and viewer revocation must not rewrite persisted fixtures.',
    );
  },
);

test(
  'over-limit workspace retains structural records and newest timestamps while declaring incomplete evidence',
  { timeout: 30000 },
  async (t) => {
    const data = workload(210);
    const storedMessages = data.resources.filter((resource) => resource.resourceType === 'message');
    storedMessages[0].id = '1';
    storedMessages[0].timestamp = '2020-01-01T00:00:00.000Z';
    storedMessages[0].content = 'Newest fixture has the smallest ID';
    storedMessages.at(-1).id = '999999999999999999';
    storedMessages.at(-1).timestamp = '2014-01-01T00:00:00.000Z';
    const h = await project(t, data);
    const initial = h.view();
    assert.ok(initial.totalResources > 2000);
    assert.ok(initial.resources.length <= 2000);
    assert.equal(initial.evidenceComplete, false);
    assert.equal(initial.truncated, true);
    assertStructure(initial);
    assert.ok(messages(initial).some((message) => message.id === '1'));
    assert.equal(
      messages(initial).some((message) => message.id === '999999999999999999'),
      false,
    );
    const reply = await h.ping();
    const latest = h.view();
    assertStructure(latest);
    assert.equal(latest.evidenceComplete, false);
    assert.ok(
      messages(latest).some(
        (message) =>
          message.interaction_id === reply.interactionId && message.channel_id === channelIds[9],
      ),
    );
    assert.equal((await openWorkspace(h.directory)).hash, h.saved.hash);
  },
);

test(
  'the renderer byte budget still fails closed below the normal resource count limit',
  { timeout: 30000 },
  async (t) => {
    const h = await project(t, workload(100, true));
    const view = h.view();
    assert.equal(view.totalResources, 1264);
    assert.equal(view.evidenceComplete, false);
    assert.ok(messages(view).length < 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(view.resources)) <= 1_048_576);
  },
);

async function assertClosed(endpoint) {
  const result = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
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
