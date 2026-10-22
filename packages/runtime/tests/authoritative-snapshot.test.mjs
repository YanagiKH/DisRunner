import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetainedCoreState } from '../dist/runtime-manager.js';

// This contract double isolates ownership behavior; pipeline tests use actual VirtualState.
function fixture(resources = [{ id: '1', resourceType: 'message', content: 'hello' }]) {
  let revision = 7;
  let listener;
  let detached = 0;
  let denyDetach = false;
  const source = {
    get revision() {
      return revision;
    },
    snapshot() {
      return { version: 1, resources, takenAtMs: 100, hash: 'private-hash' };
    },
    revisionedSnapshot() {
      return { revision, snapshot: this.snapshot() };
    },
    subscribeCommits(callback) {
      listener = callback;
      return () => {
        if (denyDetach) throw Error('injected');
        detached++;
      };
    },
  };
  const clock = { mode: 'realtime', now: () => 100 };
  const owner = new RetainedCoreState('run-A', source, clock, (value) => structuredClone(value));
  return {
    owner,
    source,
    clock,
    resources,
    detached: () => detached,
    failDetach: (value) => {
      denyDetach = value;
    },
    commit: () => {
      revision++;
      listener?.({
        schemaVersion: 1,
        revision,
        previousRevision: revision - 1,
        operation: 'transaction',
        label: 'test',
        atMs: 100,
        diff: {},
      });
    },
    late: () => listener,
  };
}

test('retains real store/clock; state revision is independent, snapshots detached', () => {
  const f = fixture();
  let notices = 0;
  f.owner.subscribe(() => notices++);
  const snapshot = f.owner.snapshot();
  assert.equal(snapshot.stateRevision, 7);
  assert.equal(snapshot.runId, 'run-A');
  assert.deepEqual(snapshot.clock, { domain: 'bot', mode: 'realtime', nowMs: 100 });
  assert.equal('hash' in snapshot, false);
  snapshot.resources[0].content = 'mutated observer copy';
  assert.equal(f.owner.snapshot().resources[0].content, 'hello');
  f.resources[0].content = 'actual mutation';
  f.commit();
  assert.equal(notices, 1);
  assert.equal(f.owner.snapshot().stateRevision, 8);
  assert.equal(f.owner.snapshot().resources[0].content, 'actual mutation');
  f.owner.release();
  assert.equal(f.detached(), 1);
  assert.equal(f.owner.snapshot(), null);
});

test('late callbacks cannot publish after replacement or release, observers cannot fail commits', () => {
  const f = fixture();
  let notices = 0;
  f.owner.subscribe(() => notices++);
  const oldCallback = f.late();
  f.owner.subscribe(() => {
    notices++;
    throw Error('observer');
  });
  oldCallback({});
  assert.equal(notices, 0);
  f.commit();
  assert.equal(notices, 1);
  const callback = f.late();
  f.owner.release();
  callback({});
  assert.equal(notices, 1);
});

test('failed detach retains core ownership for retry, with callbacks invalidated', () => {
  const f = fixture();
  let notices = 0;
  f.owner.subscribe(() => notices++);
  const late = f.late();
  f.failDetach(true);
  assert.throws(() => f.owner.release(), /injected/);
  assert.equal(f.owner.snapshot().stateRevision, 7);
  late({});
  assert.equal(notices, 0);
  f.failDetach(false);
  f.owner.release();
  assert.equal(f.detached(), 1);
  assert.equal(f.owner.snapshot(), null);
});

test('legacy core exposes actual snapshot with explicit unavailable revision, not fixture replay', () => {
  const f = fixture();
  delete f.source.revisionedSnapshot;
  delete f.source.subscribeCommits;
  const snapshot = f.owner.snapshot();
  assert.equal(snapshot.revisioned, false);
  assert.equal(snapshot.stateRevision, null);
  f.resources.push({ id: '2', resourceType: 'message', content: 'new' });
  assert.equal(f.owner.snapshot().totalResources, 2);
});

test('sanitization is fail-closed and projection is count/byte bounded', () => {
  const f = fixture(
    Array.from({ length: 1001 }, (_, i) => ({
      id: String(i),
      resourceType: 'message',
      content: 'secret',
    })),
  );
  const owner = new RetainedCoreState('run', f.source, f.clock, (value) => ({
    ...value,
    content: '[REDACTED]',
  }));
  const snapshot = owner.snapshot();
  assert.equal(snapshot.resources.length, 1000);
  assert.equal(snapshot.totalResources, 1001);
  assert.equal(snapshot.truncated, true);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  const unavailable = new RetainedCoreState('run', f.source, f.clock, () => {
    throw Error('bad sanitizer');
  });
  assert.equal(unavailable.snapshot(), null);
  const large = fixture([{ id: 'large', resourceType: 'message', content: 'a'.repeat(1_048_577) }]);
  assert.equal(large.owner.snapshot().resources.length, 0);
  assert.equal(large.owner.snapshot().truncated, true);
});

test('rejects malformed revision and non-realtime clocks without acceleration', () => {
  const f = fixture();
  f.source.revisionedSnapshot = () => ({ revision: -1, snapshot: f.source.snapshot() });
  assert.equal(f.owner.snapshot(), null);
  assert.throws(
    () => new RetainedCoreState('run', f.source, { mode: 'paused', now: () => 0 }, (x) => x),
    /realtime/,
  );
  f.clock.mode = 'accelerated';
  assert.equal(f.owner.snapshot(), null);
});

test('allowlist excludes arbitrary and nested private fields even with identity sanitizer', () => {
  const f = fixture([
    {
      id: 'm',
      resourceType: 'message',
      content: 'hello',
      channel_id: 'c',
      privateMemo: 'PRIVATE',
      metadata: { note: 'PRIVATE' },
      embeds: [{ description: 'PRIVATE' }],
      author: {
        id: 'u',
        username: 'public',
        global_name: null,
        bot: false,
        email: 'PRIVATE',
        metadata: { note: 'PRIVATE' },
      },
    },
    { id: 'g', resourceType: 'guild', name: 'guild', metadata: 'PRIVATE', content: 'PRIVATE' },
    { id: 'c', resourceType: 'channel', name: 'channel', guild_id: 'g', type: 0, topic: 'PRIVATE' },
    { id: 'u', resourceType: 'user', username: 'public', bot: false, email: 'PRIVATE' },
    { id: 'unsupported', resourceType: 'interaction', content: 'PRIVATE' },
  ]);
  const snapshot = f.owner.snapshot();
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  assert.equal(snapshot.totalResources, 5);
  assert.equal(snapshot.resources.length, 4);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.resources[0].author, {
    id: 'u',
    username: 'public',
    global_name: null,
    bot: false,
  });
  assert.deepEqual(snapshot.resources[1], { id: 'g', resourceType: 'guild', name: 'guild' });
  assert.deepEqual(snapshot.resources[2], {
    id: 'c',
    resourceType: 'channel',
    name: 'channel',
    guild_id: 'g',
    type: 0,
  });
  assert.equal(f.source.snapshot().resources[0].privateMemo, 'PRIVATE');
});

test('nested display fields cannot smuggle records in place of primitives', () => {
  const f = fixture([
    {
      id: 'm',
      resourceType: 'message',
      content: { note: 'PRIVATE' },
      author: {
        id: 'u',
        username: { note: 'PRIVATE' },
        global_name: { note: 'PRIVATE' },
        bot: { note: 'PRIVATE' },
      },
    },
  ]);
  assert.deepEqual(f.owner.snapshot().resources, [
    { id: 'm', resourceType: 'message', author: { id: 'u' } },
  ]);
});
