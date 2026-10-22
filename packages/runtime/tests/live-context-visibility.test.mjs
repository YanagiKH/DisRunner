import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VirtualClock, VirtualState, SnowflakeGenerator } from '@disrunner/core';
import { RetainedCoreState } from '../dist/runtime-manager.js';

function actualStore(resources, sanitize = (x) => structuredClone(x)) {
  const clock = new VirtualClock({ mode: 'realtime', nowMs: 100 });
  const state = new VirtualState(
    clock,
    new SnowflakeGenerator(clock),
    JSON.parse(JSON.stringify(resources)),
  );
  return { state, owner: new RetainedCoreState('run-live', state, clock, sanitize) };
}
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const identities = [
  { id: '1000', resourceType: 'guild', name: 'Guild' },
  { id: '2000', resourceType: 'channel', guild_id: '1000', type: 0 },
  { id: '3000', resourceType: 'user', username: 'Actor' },
];
const ordinary = {
  resourceType: 'message',
  channel_id: '2000',
  guild_id: '1000',
  type: 0,
  visibility: 'channel',
  flags: 0,
  content: 'Public ordinary',
};

test('private, unknown and forged message visibility never reaches the sanitizer or display DTO', () => {
  const bad = [
    { visibility: 'ephemeral' },
    { visibility: 'private' },
    { visibility: undefined },
    { flags: 64 },
    { flags: -1 },
    { flags: 0.5 },
    { flags: '0' },
    { flags: 2 ** 40 },
    { flags: Number.MAX_SAFE_INTEGER + 1 },
    { flags: undefined },
    { guild_id: 'wrong' },
    { channel_id: 'missing' },
    { type: 19 },
  ].map((changes, i) => ({ ...ordinary, ...changes, id: `bad-${i}`, content: 'PRIVATE_SENTINEL' }));
  const inspected = [];
  const { owner } = actualStore([...identities, { ...ordinary, id: 'public' }, ...bad], (view) => {
    inspected.push(view);
    return structuredClone(view);
  });
  const snapshot = owner.snapshot();
  assert.deepEqual(
    snapshot.resources
      .filter((r) => r.resourceType === 'message')
      .map((r) => [r.id, r.content, r.visibility, r.flags, r.type]),
    [['public', 'Public ordinary', 'channel', 0, 0]],
  );
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'), false);
  assert.equal(JSON.stringify(inspected).includes('PRIVATE_SENTINEL'), false);
  owner.release();
});

test('live authority is untruncated and rejects deleted or reassociated channel, guild and actor', () => {
  const padding = Array.from({ length: 1001 }, (_, i) => ({
    id: `00000-${i}`,
    resourceType: 'role',
  }));
  const { state, owner } = actualStore([...padding, ...identities]);
  assert.equal(
    owner.snapshot().resources.some((r) => r.id === '3000'),
    false,
  );
  assert.deepEqual(owner.contexts(), [context]);
  assert.equal(owner.actor('3000').username, 'Actor');
  state.update('user', '3000', { username: 'Live actor' });
  assert.equal(owner.actor('3000').username, 'Live actor');
  state.update('channel', '2000', { guild_id: 'absent' });
  assert.deepEqual(owner.contexts(), []);
  state.update('channel', '2000', { guild_id: '1000' });
  state.delete('user', '3000');
  assert.deepEqual(owner.contexts(), []);
  state.create('user', { id: '3000', username: 'Restored' });
  state.delete('guild', '1000');
  assert.deepEqual(owner.contexts(), []);
  owner.release();
  assert.deepEqual(owner.contexts(), []);
  assert.equal(owner.actor('3000'), undefined);
});

test('only supported ordinary flags and existing guild text channels are projected', () => {
  const { state, owner } = actualStore([
    ...identities,
    ...[0, 4, 4096, 4100].map((flags) => ({ ...ordinary, id: `flag-${flags}`, flags })),
  ]);
  assert.deepEqual(
    owner
      .snapshot()
      .resources.filter((r) => r.resourceType === 'message')
      .map((r) => r.flags)
      .sort((a, b) => a - b),
    [0, 4, 4096, 4100],
  );
  state.update('channel', '2000', { type: 2 });
  assert.equal(
    owner.snapshot().resources.some((r) => r.resourceType === 'message'),
    false,
  );
  state.update('channel', '2000', { type: 0 });
  state.delete('guild', '1000');
  assert.equal(
    owner.snapshot().resources.some((r) => r.resourceType === 'message'),
    false,
  );
  owner.release();
});
