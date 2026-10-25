// Pure tests: no Electron, sockets, child processes or credentials are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { strictExpected, assertStrictMutation, assertStrictDenial } from './g1-strict-oracle.mjs';
import {
  matchesOperationPermit,
  safeDenialEvidence,
  commandOperation,
  safeRestEvidence,
  interactionCallbackBody,
  validateRestBase,
} from '../fixtures/g1-strict-permissions/strict-feed-bot.mjs';

const before = {
  runId: 'run-a',
  coreState: {
    runId: 'run-a',
    stateRevision: 9,
    resources: [],
    clock: { domain: 'bot', mode: 'realtime', nowMs: 100 },
  },
};
const after = { runId: 'run-a', coreState: { runId: 'run-a', stateRevision: 10, resources: [] } };
const success = {
  operation: 'create',
  status: 200,
  authorId: '4000',
  applicationId: '6000',
  messageId: '7000',
  stateRevision: 10,
  eventId: '00000000-0000-4000-8000-000000000001',
};
const denial = {
  operation: 'create',
  status: 403,
  code: 50013,
  message: 'Missing Permissions',
  authorId: '4000',
  applicationId: '6000',
  revisionHeader: null,
  eventHeader: null,
};

test('literal allow oracle requires exact revisions, ordinary identity and committed event', () => {
  assertStrictMutation(before, after, success, '7000');
  for (const [field, value] of Object.entries({
    status: 201,
    authorId: '3000',
    messageId: '7001',
    stateRevision: 11,
    eventId: null,
  }))
    assert.throws(() =>
      assertStrictMutation(before, after, { ...success, [field]: value }, '7000'),
    );
  assert.throws(() => assertStrictMutation(before, { ...after, runId: 'run-b' }, success));
  assert.throws(() =>
    assertStrictMutation(
      before,
      { ...after, coreState: { ...after.coreState, stateRevision: 11 } },
      success,
    ),
  );
  for (const [operation, status] of [
    ['edit', 200],
    ['delete', 204],
  ])
    assertStrictMutation(before, after, { ...success, operation, status }, '7000');
});

test('denial oracle fails on wrong code/status, mutation, committed headers or renderer rows', () => {
  assertStrictDenial(before, structuredClone(before), denial, [], []);
  const later = structuredClone(before);
  later.coreState.clock.nowMs = 200;
  assertStrictDenial(before, later, denial, [], []);
  later.coreState.stateRevision++;
  assert.throws(() => assertStrictDenial(before, later, denial, [], []));
  for (const [field, value] of Object.entries({
    status: 401,
    code: 50001,
    authorId: '3000',
    message: 'Other',
    revisionHeader: '9',
    eventHeader: success.eventId,
  }))
    assert.throws(() => assertStrictDenial(before, before, { ...denial, [field]: value }, [], []));
  assert.throws(() => assertStrictDenial(before, after, denial, [], []));
  assert.throws(() =>
    assertStrictDenial(
      before,
      {
        ...before,
        coreState: {
          ...before.coreState,
          resources: [{ id: '7000' }],
        },
      },
      denial,
      [],
      [],
    ),
  );
  assert.throws(() => assertStrictDenial(before, before, denial, [], ['unexpected']));
  assert.throws(() => assertStrictDenial(before, before, denial, ['stale'], []));
});

test('denial evidence is allowlisted and rejects tainted expected fields', () => {
  assert.deepEqual(
    safeDenialEvidence({ ...denial, token: 'DO_NOT_RETAIN', headers: {}, payload: {} }),
    denial,
  );
  for (const field of Object.keys(denial))
    assert.throws(() => safeDenialEvidence({ ...denial, [field]: 'DO_NOT_RETAIN' }));
});

test('strict child retains ordinary operation mapping and ephemeral diagnostic semantics', () => {
  assert.deepEqual(commandOperation('feed-create'), {
    operation: 'create',
    method: 'POST',
    path: '/channels/2001/messages',
    body: { content: 'G1 public message created.' },
  });
  assert.equal(commandOperation('feed-edit', '7000').path, '/channels/2001/messages/7000');
  assert.equal(commandOperation('feed-delete', '7000').method, 'DELETE');
  assert.throws(() => commandOperation('feed-edit'));
  assert.deepEqual(interactionCallbackBody(false), {
    type: 4,
    data: { content: 'G1 callback diagnostic only.', flags: 64 },
  });
  assert.deepEqual(safeRestEvidence(success), success);
  assert.equal(
    validateRestBase('http://127.0.0.1:1234/api/v10', 1234),
    'http://127.0.0.1:1234/api/v10',
  );
  assert.throws(() => validateRestBase('https://discord.com/api/v10', 1234));
});

test('three separate opt-in projects keep bot permissions independent of human view access', async () => {
  for (const [name, deny] of [
    ['allow', '0'],
    ['missing-send', '2048'],
    ['missing-view', '1024'],
  ]) {
    const read = async (file) =>
      JSON.parse(
        await readFile(
          new URL(`../fixtures/g1-strict-permissions/${name}/${file}`, import.meta.url),
          'utf8',
        ),
      );
    const config = await read('discord-simulator.config.json');
    const { guild } = await read(config.fixtures.guild);
    const { user: bot } = await read(config.fixtures.bot);
    const { user: human } = await read(config.fixtures.user);
    assert.equal(config.profile.ordinaryMessagePermissions, strictExpected.profile);
    assert.equal(config.bot.startCommand, 'node strict-feed-bot.mjs');
    assert.deepEqual([bot.id, bot.bot, human.id, human.bot], ['4000', true, '3000', false]);
    assert.notEqual(guild.owner_id, bot.id);
    assert.deepEqual(
      guild.roles.map(({ id, permissions }) => [id, permissions]),
      [
        ['1000', '0'],
        ['1100', '68608'],
        ['1200', '1024'],
      ],
    );
    assert.deepEqual(guild.members, [
      { id: '4100', user_id: '4000', roles: ['1100'] },
      { id: '3100', user_id: '3000', roles: ['1200'] },
    ]);
    assert.deepEqual(guild.channels[1].permission_overwrites, [
      { id: '1100', type: 0, allow: '0', deny },
    ]);
    assert.equal(guild.channels[1].id, '2001');
    assert.equal(guild.channels[1].type, 0);
  }
});

test('strict peer authentication helper is byte-identical to the legacy helper', async () => {
  const source = async (directory) =>
    readFile(new URL(`../fixtures/${directory}/peer-auth.mjs`, import.meta.url), 'utf8');
  assert.equal(await source('g1-strict-permissions'), await source('g1-parity'));
});

test('ordinary operation permits reject stale interactions and mismatched operations', () => {
  const permit = { interactionId: '7000', operation: 'create' };
  assert.equal(matchesOperationPermit(permit, '7000', 'create'), true);
  for (const invalid of [
    null,
    {},
    { ...permit, interactionId: '6999' },
    { ...permit, operation: 'edit' },
    { ...permit, extra: true },
  ])
    assert.equal(matchesOperationPermit(invalid, '7000', 'create'), false);
  assert.equal(matchesOperationPermit(permit, 'invalid', 'create'), false);
  assert.equal(matchesOperationPermit(permit, '7000', 'unknown'), false);
});
