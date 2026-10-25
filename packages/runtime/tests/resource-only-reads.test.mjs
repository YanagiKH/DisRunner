import assert from 'node:assert/strict';
import test from 'node:test';

import { SnowflakeGenerator, VirtualClock, VirtualState, sanitizeForExport } from '@disrunner/core';
import { RetainedCoreState } from '../dist/runtime-manager.js';

const secret = 'resource-read-private-value';
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const direct = { actorId: '3000', channelId: '2001' };

function fixture() {
  const clock = new VirtualClock({ nowMs: Date.now(), mode: 'realtime' });
  const state = new VirtualState(clock, new SnowflakeGenerator(clock), [
    { resourceType: 'guild', id: '1000', name: 'Guild', owner_id: '3000' },
    { resourceType: 'channel', id: '2000', type: 0, guild_id: '1000' },
    { resourceType: 'channel', id: '2001', type: 1, recipients: [{ id: '3000' }] },
    { resourceType: 'user', id: '3000', username: 'Actor', metadata: { label: 'original' } },
    { resourceType: 'member', id: '3100', user_id: '3000', guild_id: '1000', roles: [] },
    { resourceType: 'user', id: '4000', username: 'Bot', bot: true },
    {
      resourceType: 'application-command',
      id: '6000',
      type: 1,
      name: 'ping',
      description: 'Global ping',
      registry_profile: 'command-registry-v2',
    },
    {
      resourceType: 'application-command',
      id: '6001',
      type: 1,
      name: 'ping',
      description: secret,
      guild_id: '1000',
      registry_profile: 'command-registry-v2',
    },
    { resourceType: 'application-command', id: '6002', type: 2, name: 'Inspect user' },
  ]);
  const sanitize = (value) => sanitizeForExport(value, { sensitiveValues: [secret] });
  const owner = new RetainedCoreState('resource-reads', state, clock, sanitize, '4000', true, true);
  return { clock, state, sanitize, owner };
}

function assertEmpty(owner) {
  assert.deepEqual(owner.contexts(), []);
  assert.deepEqual(owner.commands(), []);
  assert.equal(owner.commandCount(), 0);
  assert.equal(owner.actor('3000'), undefined);
}

test('resource queries use the current public list without requiring a canonical state snapshot', () => {
  const { state, owner } = fixture();
  state.snapshot = () => {
    throw new Error('A resource-only read must not serialize and hash the whole state.');
  };
  assert.deepEqual(owner.contexts(), [context, direct]);
  assert.equal(owner.commandCount(), 3);
  assert.deepEqual(
    owner.commands('1000').map(({ id, name, description }) => ({ id, name, description })),
    [
      { id: '6001', name: 'ping', description: '[REDACTED]' },
      { id: '6002', name: 'Inspect user', description: undefined },
    ],
  );
  assert.equal('registry_profile' in owner.commands()[0], false);
  assert.equal('resourceType' in owner.commands()[0], false);
  assert.equal(owner.actor('3000').username, 'Actor');
  // The authoritative display projection still requires its real revisioned snapshot.
  assert.equal(owner.snapshot(), null);
  owner.release();
  assertEmpty(owner);
});

test('public-list and snapshot-only queries agree across live state mutations and detached reads', () => {
  const { clock, state, sanitize, owner } = fixture();
  const legacy = new RetainedCoreState(
    'resource-reads',
    { snapshot: () => state.snapshot() },
    clock,
    sanitize,
    '4000',
    true,
    true,
  );
  const queries = (source) => ({
    contexts: source.contexts(),
    commands: source.commands('1000'),
    count: source.commandCount(),
    actor: source.actor('3000'),
  });
  assert.deepEqual(queries(owner), queries(legacy));
  assert.equal(legacy.snapshot().revisioned, false);
  assert.equal(legacy.snapshot().stateRevision, null);

  state.update('user', '3000', { username: 'Updated actor' });
  state.update('application-command', '6001', { name: 'guild-ping' });
  state.create('application-command', { id: '6003', type: 1, name: 'new-command' });
  assert.equal(owner.actor('3000').username, 'Updated actor');
  assert.equal(owner.commandCount(), 4);
  assert.ok(owner.commands('1000').some((command) => command.name === 'guild-ping'));
  assert.ok(owner.commands('1000').some((command) => command.name === 'new-command'));
  assert.deepEqual(queries(owner), queries(legacy));

  const copy = owner.actor('3000');
  copy.metadata.label = 'observer mutation';
  assert.equal(owner.actor('3000').metadata.label, 'original');
  state.update('channel', '2000', { guild_id: 'absent' });
  assert.deepEqual(owner.contexts(), [direct]);
  assert.deepEqual(queries(owner), queries(legacy));
  state.delete('user', '3000');
  assert.deepEqual(owner.contexts(), []);
  assert.equal(owner.actor('3000'), undefined);
  assert.equal(owner.commandCount(), 4);
  assert.deepEqual(queries(owner), queries(legacy));
  owner.release();
  legacy.release();
});

test('failed or malformed public lists fail closed without falling back to another snapshot', () => {
  const { clock, state, sanitize } = fixture();
  for (const list of [
    () => {
      throw new Error('Resource read failed.');
    },
    () => null,
    () => ({ resources: state.list() }),
    () => [null, false, 123, 'not a resource'],
  ]) {
    let snapshots = 0;
    const owner = new RetainedCoreState(
      'invalid-list',
      {
        list,
        snapshot() {
          snapshots++;
          return state.snapshot();
        },
      },
      clock,
      sanitize,
    );
    assertEmpty(owner);
    assert.equal(snapshots, 0);
    owner.release();
  }
});

test('snapshot-only source errors and malformed resources keep their empty-read fallback', () => {
  const { clock, sanitize } = fixture();
  for (const snapshot of [
    () => {
      throw new Error('Legacy read failed.');
    },
    () => null,
    () => ({ resources: null }),
    () => ({ resources: [null, false, 123, 'not a resource'] }),
  ]) {
    const owner = new RetainedCoreState('legacy-errors', { snapshot }, clock, sanitize);
    assertEmpty(owner);
    owner.release();
  }
});
