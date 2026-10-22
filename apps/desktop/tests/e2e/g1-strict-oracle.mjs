import assert from 'node:assert/strict';

// Handwritten, not computed from project configuration or HTTP responses.
export const strictExpected = {
  profile: 'guild-text-own-messages-v1',
  actorId: '3000',
  botId: '4000',
  guildId: '1000',
  channelId: '2001',
  allow: { create: 200, edit: 200, delete: 204, revisionDelta: 1 },
  deny: { status: 403, code: 50013, message: 'Missing Permissions' },
};

export function assertStrictMutation(before, after, record, expectedId) {
  assert.equal(record.status, strictExpected.allow[record.operation]);
  assert.equal(record.authorId, '4000');
  assert.match(record.messageId, /^[1-9][0-9]{0,19}$/u);
  if (expectedId !== undefined) assert.equal(record.messageId, expectedId);
  assert.match(record.eventId, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu);
  assert.equal(after.runId, before.runId);
  assert.equal(record.stateRevision, before.coreState.stateRevision + 1);
  assert.equal(after.coreState.stateRevision, record.stateRevision);
}

export function assertStrictDenial(before, after, record, beforeRows, afterRows) {
  assert.deepEqual(
    [record.operation, record.status, record.code, record.message],
    ['create', 403, 50013, 'Missing Permissions'],
  );
  assert.equal(record.authorId, '4000');
  assert.equal(record.revisionHeader, null);
  assert.equal(record.eventHeader, null);
  assert.equal(after.runId, before.runId);
  // The bot clock is realtime, not a mutation counter. Exclude only its time
  // reading; retain exact comparison of every resource and all other metadata.
  const stable = ({ clock, ...state }) => ({
    ...state,
    clock: { domain: clock.domain, mode: clock.mode },
  });
  assert.ok(Number.isFinite(before.coreState.clock.nowMs));
  assert.ok(after.coreState.clock.nowMs >= before.coreState.clock.nowMs);
  assert.deepEqual(stable(after.coreState), stable(before.coreState));
  assert.deepEqual(beforeRows, []);
  assert.deepEqual(afterRows, []);
}
