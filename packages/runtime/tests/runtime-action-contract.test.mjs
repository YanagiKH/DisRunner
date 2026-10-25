import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RuntimeActionDriver } from '../dist/runtime-actions.js';
import { RetainedCoreState } from '../dist/runtime-manager.js';
import {
  GatewayEmulator,
  InteractionEngine,
  LocalAttachmentStore,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
} from '../../core/dist/index.js';

const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
function harness(commands, options = {}) {
  const clock = new VirtualClock({ nowMs: Date.now(), mode: 'realtime' });
  const random = new SeededRandom(42);
  const snowflakes = new SnowflakeGenerator(clock);
  const author = { id: '4000', username: 'bot', discriminator: '0', avatar: null, bot: true };
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: '1000', name: 'Guild', owner_id: '3000' },
    { resourceType: 'guild', id: '1001', name: 'Other guild', owner_id: '3000' },
    {
      resourceType: 'role',
      id: '1000',
      guild_id: '1000',
      name: '@everyone',
      permissions: '3072',
      position: 0,
    },
    { resourceType: 'channel', id: '2000', guild_id: '1000', name: 'general', type: 0 },
    { resourceType: 'user', id: '3000', username: 'actor' },
    { resourceType: 'user', ...author },
    { resourceType: 'member', id: '6000', guild_id: '1000', user_id: '3000', roles: [] },
    ...commands,
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: '9000',
    botUserId: author.id,
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    applicationId: '9000',
    profile: createSimulationProfile(),
    messageAuthority: {
      state,
      gateway,
      author,
      context: { runId: 'contract', clockDomain: 'realtime' },
    },
  });
  const payloads = [];
  const driver = new RuntimeActionDriver({
    state,
    clock,
    gateway,
    interactions,
    applicationId: '9000',
    assertLive() {},
    transport: async (payload) => {
      payloads.push(payload);
      return payload.type === 4
        ? { type: 'autocomplete', data: { choices: [] } }
        : { type: 'message', data: { content: 'Reply from transport' } };
    },
    ...options,
  });
  const dispatch = (action) => driver.dispatch(action, context, new AbortController().signal);
  return { dispatch, payloads, driver, state, clock, author };
}

test('guild command definitions take precedence over a same-name global registration', async () => {
  const h = harness([
    { resourceType: 'application-command', id: '5000', name: 'ping', type: 1, options: [] },
    {
      resourceType: 'application-command',
      id: '5001',
      name: 'ping',
      type: 1,
      guild_id: '1000',
      options: [],
    },
  ]);
  const result = await h.dispatch({ type: 'command', name: 'ping' });
  assert.equal(result.ok, true);
  assert.equal(h.payloads.length, 1);
  assert.equal(h.payloads[0].data.id, '5001');
});

test('strict actor permissions reject guild outsiders before state or transport changes', async () => {
  const h = harness([], { enforcePermissions: true });
  h.state.create('user', { id: '3001', username: 'outsider' });
  const revision = h.state.revision;
  await assert.rejects(
    h.driver.dispatch(
      { type: 'message', content: 'Invalid outsider message' },
      { ...context, actorId: '3001' },
      new AbortController().signal,
    ),
    { code: 'invalid' },
  );
  assert.equal(h.state.revision, revision);
  assert.equal(h.state.list('message').length, 0);
  assert.equal(h.payloads.length, 0);
  await h.dispatch({ type: 'message', content: 'Allowed owner message' });
  assert.equal(h.state.list('message')[0].author.id, context.actorId);
});

test('actor snapshots apply channel VIEW overwrites while the public developer projection remains separate', () => {
  const h = harness([]);
  h.state.create('user', { id: '3001', username: 'outsider' });
  h.state.create('user', { id: '3002', username: 'viewer' });
  h.state.create('member', { id: '6002', guild_id: '1000', user_id: '3002', roles: [] });
  h.state.create('channel', {
    id: '2100',
    guild_id: '1000',
    name: 'private',
    type: 0,
    permission_overwrites: [{ id: '1000', type: 0, allow: '0', deny: '1024' }],
  });
  const common = {
    resourceType: 'message',
    guild_id: '1000',
    author: h.author,
    flags: 0,
    type: 0,
    visibility: 'channel',
  };
  h.state.create('message', {
    ...common,
    id: '10000',
    channel_id: '2000',
    content: 'Public message',
  });
  h.state.create('message', {
    ...common,
    id: '10001',
    channel_id: '2100',
    content: 'Hidden channel message',
  });
  h.state.create('message', {
    ...common,
    id: '10002',
    channel_id: '2000',
    content: 'Private reply',
    flags: 64,
    type: 20,
    visibility: 'ephemeral',
    recipient_id: '3002',
    message_origin: 'interaction',
    interaction_id: '8000',
    application_id: '9000',
    webhook_id: '9000',
    interaction_message_kind: 'original',
  });
  const owner = new RetainedCoreState(
    'view-contract',
    h.state,
    h.clock,
    (value) => value,
    h.author.id,
    true,
    true,
  );
  try {
    const ids = (actor) => owner.snapshot(actor).resources.map((resource) => resource.id);
    assert.ok(ids('3002').includes('2000'));
    assert.ok(ids('3002').includes('10000'));
    assert.ok(ids('3002').includes('10002'));
    assert.equal(ids('3002').includes('2100'), false);
    assert.equal(ids('3002').includes('10001'), false);
    assert.equal(
      owner.contexts().some((candidate) => candidate.actorId === '3001'),
      false,
    );
    assert.equal(ids('3001').includes('2000'), false);
    assert.equal(ids('3001').includes('10000'), false);
    assert.ok(ids(context.actorId).includes('2100'), 'Guild owner retains VIEW permission');
    assert.equal(
      ids(context.actorId).includes('10002'),
      false,
      'Owner cannot see another actor’s ephemeral reply',
    );
    assert.ok(ids().includes('2100'), 'Developer projection includes public guild resources');
    assert.ok(ids().includes('10001'));
    assert.equal(
      ids().includes('10002'),
      false,
      'Public developer projection does not include ephemeral replies',
    );
  } finally {
    owner.release();
  }
});

test(
  'an attachment import cancelled after file preparation leaves no stale resource or retained bytes',
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner import 取消 '));
    const attachments = new LocalAttachmentStore({ baseUrl: 'http://127.0.0.1:12345' });
    const original = attachments.addFile.bind(attachments);
    let entered;
    const prepared = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const resumed = new Promise((resolve) => {
      release = resolve;
    });
    attachments.addFile = async (...args) => {
      const batch = await original(...args);
      entered();
      await resumed;
      return batch;
    };
    const h = harness([], { attachments, projectRoot: directory });
    const controller = new AbortController();
    let operation;
    try {
      await writeFile(path.join(directory, 'note.txt'), 'real file content');
      operation = h.driver.importAttachment('note.txt', context, controller.signal);
      await prepared;
      assert.equal(attachments.stats().pendingFiles, 1);
      const reason = new Error('Run stopped while importing');
      controller.abort(reason);
      attachments.clear();
      release();
      await assert.rejects(operation, (error) => error === reason);
      assert.equal(h.state.list('attachment').length, 0);
      assert.deepEqual(attachments.stats(), {
        files: 0,
        bytes: 0,
        pendingFiles: 0,
        pendingBytes: 0,
      });
    } finally {
      release();
      await operation?.catch(() => undefined);
      attachments.clear();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('global commands remain available when a same-name guild command belongs elsewhere', async () => {
  const h = harness([
    {
      resourceType: 'application-command',
      id: '5001',
      name: 'ping',
      type: 1,
      guild_id: '1001',
      options: [],
    },
    { resourceType: 'application-command', id: '5000', name: 'ping', type: 1, options: [] },
  ]);
  await h.dispatch({ type: 'command', name: 'ping' });
  assert.equal(h.payloads[0].data.id, '5000');
});

test('autocomplete accepts partial text before other required fields or min_length are satisfied', async () => {
  const h = harness([
    {
      resourceType: 'application-command',
      id: '5000',
      name: 'search',
      type: 1,
      options: [
        { name: 'query', type: 3, required: true, autocomplete: true, min_length: 5 },
        { name: 'count', type: 4, required: true },
      ],
    },
  ]);
  const result = await h.dispatch({
    type: 'autocomplete',
    name: 'search',
    options: [{ name: 'query', type: 3, value: 'a', focused: true }],
  });
  assert.equal(result.response.type, 'autocomplete');
  assert.deepEqual(h.payloads[0].data.options, [
    { name: 'query', type: 3, value: 'a', focused: true },
  ]);
  await assert.rejects(
    h.dispatch({
      type: 'command',
      name: 'search',
      options: [{ name: 'query', type: 3, value: 'a' }],
    }),
    /required command option/iu,
  );
  await assert.rejects(
    h.dispatch({
      type: 'command',
      name: 'search',
      options: [
        { name: 'query', type: 3, value: 'a' },
        { name: 'count', type: 4, value: 1 },
      ],
    }),
    /String option is outside/iu,
  );
  assert.equal(h.payloads.length, 1, 'Invalid final commands must never reach the bot');
});

test('numeric autocomplete preserves partial focused text while final commands retain numeric validation', async () => {
  const h = harness([
    {
      resourceType: 'application-command',
      id: '5000',
      name: 'number',
      type: 1,
      options: [{ name: 'value', type: 10, required: true, autocomplete: true, min_value: 10 }],
    },
  ]);
  const result = await h.dispatch({
    type: 'autocomplete',
    name: 'number',
    options: [{ name: 'value', type: 10, value: '1.', focused: true }],
  });
  assert.equal(result.response.type, 'autocomplete');
  assert.equal(h.payloads[0].data.options[0].value, '1.');
  await assert.rejects(
    h.dispatch({
      type: 'command',
      name: 'number',
      options: [{ name: 'value', type: 10, value: '1.' }],
    }),
    /Numeric option is outside/iu,
  );
  assert.equal(h.payloads.length, 1);
});
