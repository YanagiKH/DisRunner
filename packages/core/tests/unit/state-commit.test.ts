import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  SnowflakeGenerator,
  StateCapacityError,
  StateConflictError,
  VirtualClock,
  VirtualState,
} from '../../src/index.js';
import type {
  ResourceRecord,
  StateCommit,
  StateMutationSummary,
  VirtualStateOptions,
} from '../../src/index.js';

const START_MS = DISCORD_EPOCH_MS + 1_000;

function createState(options: VirtualStateOptions = {}): {
  readonly clock: VirtualClock;
  readonly state: VirtualState;
} {
  const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
  return { clock, state: new VirtualState(clock, new SnowflakeGenerator(clock), [], options) };
}

function recordCommits(state: VirtualState): StateCommit[] {
  const commits: StateCommit[] = [];
  state.subscribeCommits((commit) => {
    commits.push(commit);
  });
  return commits;
}

const guild = { id: '100', resourceType: 'guild', name: 'Lab' };
const renamedGuild = { id: '100', resourceType: 'guild', name: 'Lab 2' };
const channel = { id: '200', resourceType: 'channel', name: 'general' };

describe('state commit revisions', () => {
  it('starts at revision zero without emitting a commit, including initial fixtures', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const seeded = new VirtualState(clock, new SnowflakeGenerator(clock), [guild]);
    expect(seeded.revision).toBe(0);
    const commits = recordCommits(seeded);
    expect(commits).toEqual([]);
    expect(createState().state.revision).toBe(0);
  });

  it('emits one commit per successful create, update and delete with history labels', () => {
    const { clock, state } = createState();
    const commits = recordCommits(state);
    state.create('guild', { id: '100', name: 'Lab' });
    clock.advanceBy(10);
    state.update('guild', '100', { name: 'Lab 2' });
    clock.advanceBy(10);
    state.delete('guild', '100');

    expect(state.revision).toBe(3);
    expect(commits).toEqual([
      {
        schemaVersion: 1,
        revision: 1,
        previousRevision: 0,
        operation: 'create',
        label: 'create:guild/100',
        atMs: START_MS,
        diff: { added: [guild], updated: [], deleted: [] },
      },
      {
        schemaVersion: 1,
        revision: 2,
        previousRevision: 1,
        operation: 'update',
        label: 'update:guild/100',
        atMs: START_MS + 10,
        diff: {
          added: [],
          updated: [{ before: guild, after: renamedGuild, changedFields: ['name'] }],
          deleted: [],
        },
      },
      {
        schemaVersion: 1,
        revision: 3,
        previousRevision: 2,
        operation: 'delete',
        label: 'delete:guild/100',
        atMs: START_MS + 20,
        diff: { added: [], updated: [], deleted: [renamedGuild] },
      },
    ]);
    expect(state.mutationHistory().map((entry) => entry.diff)).toEqual(
      commits.map((commit) => commit.diff),
    );
  });

  it('emits only the outer commit for nested transactions with the net diff', () => {
    const { state } = createState();
    const commits = recordCommits(state);
    const result = state.transaction('outer', () => {
      state.create('guild', { id: '100', name: 'Lab' });
      state.transaction('inner', () => {
        state.create('channel', { id: '200', name: 'general' });
      });
      return 'done';
    });

    expect(result).toBe('done');
    expect(state.revision).toBe(1);
    expect(commits).toEqual([
      {
        schemaVersion: 1,
        revision: 1,
        previousRevision: 0,
        operation: 'transaction',
        label: 'outer',
        atMs: START_MS,
        diff: { added: [channel, guild], updated: [], deleted: [] },
      },
    ]);
  });

  it('keeps revision monotonic across undo and redo with inverse and forward diffs', () => {
    const { clock, state } = createState();
    const commits = recordCommits(state);
    state.create('guild', { id: '100', name: 'Lab' });
    state.update('guild', '100', { name: 'Lab 2' });
    clock.advanceBy(50);
    expect(state.undo()).toBe(true);
    expect(state.undo()).toBe(true);
    expect(state.redo()).toBe(true);

    expect(commits.map((commit) => commit.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(commits.map((commit) => commit.previousRevision)).toEqual([0, 1, 2, 3, 4]);
    expect(state.revision).toBe(5);
    expect(state.mutationHistory()).toHaveLength(2);
    expect(commits.slice(2)).toEqual([
      {
        schemaVersion: 1,
        revision: 3,
        previousRevision: 2,
        operation: 'undo',
        label: 'update:guild/100',
        atMs: START_MS + 50,
        diff: {
          added: [],
          updated: [{ before: renamedGuild, after: guild, changedFields: ['name'] }],
          deleted: [],
        },
      },
      {
        schemaVersion: 1,
        revision: 4,
        previousRevision: 3,
        operation: 'undo',
        label: 'create:guild/100',
        atMs: START_MS + 50,
        diff: { added: [], updated: [], deleted: [guild] },
      },
      {
        schemaVersion: 1,
        revision: 5,
        previousRevision: 4,
        operation: 'redo',
        label: 'create:guild/100',
        atMs: START_MS + 50,
        diff: { added: [guild], updated: [], deleted: [] },
      },
    ]);
  });

  it('commits restore, import and reset, and undoing them still moves revision forward', () => {
    const { clock, state } = createState();
    const other = new VirtualState(clock, new SnowflakeGenerator(clock));
    other.create('channel', { id: '200', name: 'general' });
    const snapshot = other.snapshot();
    state.create('guild', { id: '100', name: 'Lab' });
    const commits = recordCommits(state);

    state.restore(snapshot);
    expect(state.revision).toBe(2);
    expect(state.undo()).toBe(true);
    expect(state.revision).toBe(3);
    expect(state.list()).toEqual([guild]);

    const role = { id: '300', resourceType: 'role', name: 'mod' };
    state.importFixture(JSON.stringify({ version: 1, resources: [role] }));
    expect(state.revision).toBe(4);
    state.reset();
    expect(state.revision).toBe(5);
    expect(state.undo()).toBe(true);
    expect(state.revision).toBe(6);
    expect(state.list()).toEqual([role]);

    expect(commits.map((commit) => [commit.operation, commit.label])).toEqual([
      ['restore', 'restore-snapshot'],
      ['undo', 'restore-snapshot'],
      ['import', 'import-fixture'],
      ['reset', 'reset'],
      ['undo', 'reset'],
    ]);
    expect(commits.map((commit) => commit.diff)).toEqual([
      { added: [channel], updated: [], deleted: [guild] },
      { added: [guild], updated: [], deleted: [channel] },
      { added: [role], updated: [], deleted: [guild] },
      { added: [], updated: [], deleted: [role] },
      { added: [role], updated: [], deleted: [] },
    ]);
  });

  it('commits a mutation that becomes an undo barrier', () => {
    const { state } = createState({ maxHistoryBytes: 128, maxResourceBytes: 1_024 });
    state.create('guild', { id: '10', name: 'small' });
    const commits = recordCommits(state);
    state.update('guild', '10', { name: 'x'.repeat(300) });

    expect(state.revision).toBe(2);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.operation).toBe('update');
    expect(commits[0]?.revision).toBe(2);
    expect(state.mutationHistory()).toEqual([]);
    expect(state.undo()).toBe(false);
  });

  it('returns a revisioned snapshot that matches the plain snapshot', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    state.create('channel', { id: '200', name: 'general' });
    const revisioned = state.revisionedSnapshot();
    expect(revisioned.revision).toBe(2);
    expect(revisioned.revision).toBe(state.revision);
    expect(revisioned.snapshot).toEqual(state.snapshot());
    expect(revisioned.snapshot.hash).toBe(state.snapshot().hash);
    expect(revisioned.snapshot.version).toBe(1);
  });
});

describe('operations without a net data change', () => {
  it('does not commit no-op reset, restore, import, transaction, undo or redo', () => {
    const { state } = createState();
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    state.reset();
    expect(state.undo()).toBe(false);
    expect(state.redo()).toBe(false);
    state.create('guild', { id: '100', name: 'Lab' });
    expect(calls).toBe(1);

    state.restore(state.snapshot());
    state.importFixture(state.exportFixture());
    state.transaction('net zero', () => {
      state.create('channel', { id: '200' });
      state.delete('channel', '200');
    });
    expect(state.redo()).toBe(false);
    expect(state.revision).toBe(1);
    expect(calls).toBe(1);
  });

  it('records an unchanged update in history without a commit, also on undo and redo', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    state.update('guild', '100', { name: 'Lab' });

    expect(state.mutationHistory()).toHaveLength(2);
    expect(state.revision).toBe(1);
    expect(state.undo()).toBe(true);
    expect(state.redo()).toBe(true);
    expect(state.revision).toBe(1);
    expect(calls).toBe(0);
    expect(state.require('guild', '100')['name']).toBe('Lab');
  });

  it('does not commit when an outer transaction only catches an inner failure', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    state.transaction('outer', () => {
      try {
        state.transaction('inner', () => {
          state.update('guild', '100', { name: 'Changed' });
          throw new Error('inner failure');
        });
      } catch {
        // The inner failure is expected and handled here.
      }
    });
    expect(state.revision).toBe(1);
    expect(calls).toBe(0);
    expect(state.require('guild', '100')['name']).toBe('Lab');
  });

  it('does not notify for failed operations', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    expect(() => state.create('guild', { id: '100' })).toThrow(StateConflictError);
    expect(() =>
      state.transaction('failing', () => {
        state.update('guild', '100', { name: 'Changed' });
        throw new Error('failure');
      }),
    ).toThrow('failure');
    expect(state.revision).toBe(1);
    expect(calls).toBe(0);
  });
});

describe('commit notification contract', () => {
  it('does not send an initial event on subscribe', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('notifies after the commit is complete so reads see the new state', () => {
    const { state } = createState();
    const observed: unknown[] = [];
    state.subscribeCommits((commit) => {
      observed.push(commit.revision, state.revision, state.get('guild', '100'));
      observed.push(state.list().length, state.snapshot().resources.length);
      observed.push(state.mutationHistory().length);
    });
    state.create('guild', { id: '100', name: 'Lab' });
    expect(observed).toEqual([1, 1, guild, 1, 1, 1]);
  });

  it('gives every listener an independent deep copy', () => {
    const { state } = createState();
    const received: StateCommit[] = [];
    state.subscribeCommits((commit) => {
      const added = commit.diff.added as unknown as Record<string, unknown>[];
      const first = added[0];
      if (first !== undefined) first['name'] = 'tampered';
      added.push({ id: '999', resourceType: 'guild' });
    });
    state.subscribeCommits((commit) => {
      received.push(commit);
    });
    state.create('guild', { id: '100', name: 'Lab' });

    const createdDiff = { added: [guild], updated: [], deleted: [] };
    expect(received[0]?.diff).toEqual(createdDiff);
    expect(state.mutationHistory()[0]?.diff).toEqual(createdDiff);
    expect(state.snapshot().resources).toEqual([guild]);
  });

  it('isolates a throwing listener from the operation and from other listeners', () => {
    const { state } = createState();
    const order: string[] = [];
    state.subscribeCommits(() => {
      order.push('first');
      throw new Error('listener failure');
    });
    state.subscribeCommits(() => {
      order.push('second');
    });

    const created = state.create('guild', { id: '100', name: 'Lab' });
    expect(created).toEqual(guild);
    const result = state.transaction('rename', () => {
      state.update('guild', '100', { name: 'Lab 2' });
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['first', 'second', 'first', 'second']);
    expect(state.revision).toBe(2);
    expect(state.require('guild', '100')).toEqual(renamedGuild);

    state.transaction('later', () => {
      state.create('channel', { id: '200', name: 'general' });
    });
    expect(state.revision).toBe(3);
    expect(state.get('channel', '200')).toEqual(channel);
  });

  it('rejects every mutation from inside a listener before any side effect', () => {
    const { clock, state } = createState();
    const other = new VirtualState(clock, new SnowflakeGenerator(clock));
    other.create('role', { id: '300' });
    const otherSnapshot = other.snapshot();
    const otherFixture = other.exportFixture();
    let callbackRuns = 0;
    let calls = 0;
    const failures: unknown[] = [];
    let before: unknown;
    let after: unknown;
    state.subscribeCommits(() => {
      calls += 1;
      before = state.snapshot();
      const attempts: (() => unknown)[] = [
        () => state.create('channel', { id: '201' }),
        () => state.update('guild', '100', { name: 'Reentrant' }),
        () => state.delete('guild', '100'),
        () =>
          state.transaction('reentrant', () => {
            callbackRuns += 1;
          }),
        () => state.undo(),
        () => state.redo(),
        () => state.restore(otherSnapshot),
        () => state.reset(),
        () => state.importFixture(otherFixture),
      ];
      for (const attempt of attempts) {
        try {
          attempt();
          failures.push('accepted');
        } catch (error) {
          failures.push(error instanceof StateConflictError ? 'rejected' : error);
        }
      }
      after = state.snapshot();
    });

    state.create('guild', { id: '100', name: 'Lab' });
    expect(failures).toEqual(Array.from({ length: 9 }, () => 'rejected'));
    expect(callbackRuns).toBe(0);
    expect(after).toEqual(before);
    expect(calls).toBe(1);
    expect(state.revision).toBe(1);
    expect(state.list()).toEqual([guild]);
    expect(state.mutationHistory()).toHaveLength(1);

    state.update('guild', '100', { name: 'Lab 2' });
    expect(state.revision).toBe(2);
    expect(calls).toBe(2);
  });

  it('allows reads from inside a listener', () => {
    const { state } = createState();
    const reads: unknown[] = [];
    state.subscribeCommits(() => {
      const clone = state.clone();
      reads.push(state.get('guild', '100')?.['name'], state.list().length);
      reads.push(state.snapshot().resources.length, state.revisionedSnapshot().revision);
      reads.push(state.revision, state.mutationHistory().length);
      reads.push(state.diff(clone).added.length, typeof state.exportFixture());
      reads.push(clone.revision, clone.list().length);
    });
    state.create('guild', { id: '100', name: 'Lab' });
    expect(reads).toEqual(['Lab', 1, 1, 1, 1, 1, 0, 'string', 0, 1]);
  });

  it('supports self-unsubscribe and idempotent unsubscribe', () => {
    const { state } = createState();
    let selfCalls = 0;
    let otherCalls = 0;
    const unsubscribeSelf = state.subscribeCommits(() => {
      selfCalls += 1;
      unsubscribeSelf();
    });
    const unsubscribeOther = state.subscribeCommits(() => {
      otherCalls += 1;
    });
    const third: number[] = [];
    state.subscribeCommits((commit) => {
      third.push(commit.revision);
    });

    state.create('guild', { id: '100' });
    state.create('guild', { id: '101' });
    expect(selfCalls).toBe(1);
    expect(otherCalls).toBe(2);
    unsubscribeOther();
    unsubscribeOther();
    unsubscribeSelf();
    state.create('guild', { id: '102' });
    expect(otherCalls).toBe(2);
    expect(third).toEqual([1, 2, 3]);
  });

  it('does not deliver the in-flight commit to a listener subscribed during notification', () => {
    const { state } = createState();
    const late: number[] = [];
    let subscribed = false;
    state.subscribeCommits(() => {
      if (subscribed) return;
      subscribed = true;
      state.subscribeCommits((commit) => {
        late.push(commit.revision);
      });
    });
    state.create('guild', { id: '100' });
    expect(late).toEqual([]);
    state.create('guild', { id: '101' });
    expect(late).toEqual([2]);
  });

  it('calls listeners in subscription order and skips one unsubscribed before its turn', () => {
    const { state } = createState();
    const order: string[] = [];
    let unsubscribeLast = (): void => undefined;
    state.subscribeCommits(() => {
      order.push('first');
      unsubscribeLast();
    });
    state.subscribeCommits(() => {
      order.push('second');
    });
    unsubscribeLast = state.subscribeCommits(() => {
      order.push('last');
    });
    state.create('guild', { id: '100' });
    state.create('guild', { id: '101' });
    expect(order).toEqual(['first', 'second', 'first', 'second']);
  });

  it('treats the same function subscribed twice as two subscriptions', () => {
    const { state } = createState({ maxCommitSubscribers: 2 });
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    const unsubscribeFirst = state.subscribeCommits(listener);
    state.subscribeCommits(listener);
    expect(() => state.subscribeCommits(listener)).toThrow(StateCapacityError);
    state.create('guild', { id: '100' });
    expect(calls).toBe(2);
    unsubscribeFirst();
    unsubscribeFirst();
    state.create('guild', { id: '101' });
    expect(calls).toBe(3);
  });

  it('rejects subscribers beyond the configured limit without registering them', () => {
    const { state } = createState({ maxCommitSubscribers: 2 });
    const calls = [0, 0, 0];
    const unsubscribeFirst = state.subscribeCommits(() => {
      calls[0] = (calls[0] ?? 0) + 1;
    });
    state.subscribeCommits(() => {
      calls[1] = (calls[1] ?? 0) + 1;
    });
    const rejected = (): void => {
      calls[2] = (calls[2] ?? 0) + 1;
    };
    expect(() => state.subscribeCommits(rejected)).toThrow(StateCapacityError);
    state.create('guild', { id: '100' });
    expect(calls).toEqual([1, 1, 0]);

    unsubscribeFirst();
    state.subscribeCommits(() => {
      calls[2] = (calls[2] ?? 0) + 1;
    });
    state.create('guild', { id: '101' });
    expect(calls).toEqual([1, 2, 1]);
  });

  it('validates the subscriber limit option', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const snowflakes = new SnowflakeGenerator(clock);
    const expected = new RangeError('maxCommitSubscribers must be a positive safe integer.');
    for (const value of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      const options = { maxCommitSubscribers: value };
      expect(() => new VirtualState(clock, snowflakes, [], options)).toThrow(expected);
    }
  });

  it('rejects a non-function listener without registering it', () => {
    const { state } = createState({ maxCommitSubscribers: 1 });
    const invalid = 'not a function' as unknown as (commit: StateCommit) => void;
    expect(() => state.subscribeCommits(invalid)).toThrow(TypeError);
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    state.create('guild', { id: '100' });
    expect(calls).toBe(1);
  });

  it('isolates clones from the original revision and listeners in both directions', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Lab' });
    let originalCalls = 0;
    state.subscribeCommits(() => {
      originalCalls += 1;
    });
    const clone = state.clone();
    expect(clone.revision).toBe(0);
    expect(clone.mutationHistory()).toEqual([]);
    let cloneCalls = 0;
    clone.subscribeCommits(() => {
      cloneCalls += 1;
    });

    clone.create('channel', { id: '200' });
    expect(clone.revision).toBe(1);
    expect(state.revision).toBe(1);
    expect(originalCalls).toBe(0);

    state.create('channel', { id: '201' });
    expect(state.revision).toBe(2);
    expect(clone.revision).toBe(1);
    expect(cloneCalls).toBe(1);
    expect(originalCalls).toBe(1);
  });

  it('keeps the subscriber limit on clones with an independent quota', () => {
    const { state } = createState({ maxCommitSubscribers: 2 });
    let originalCalls = 0;
    const countOriginal = (): void => {
      originalCalls += 1;
    };
    const unsubscribeOriginal = state.subscribeCommits(countOriginal);
    state.subscribeCommits(countOriginal);
    expect(() => state.subscribeCommits(countOriginal)).toThrow(StateCapacityError);

    const clone = state.clone();
    let cloneCalls = 0;
    const countClone = (): void => {
      cloneCalls += 1;
    };
    clone.subscribeCommits(countClone);
    clone.subscribeCommits(countClone);
    expect(() => clone.subscribeCommits(countClone)).toThrow(StateCapacityError);
    clone.create('guild', { id: '100' });
    expect(cloneCalls).toBe(2);
    expect(originalCalls).toBe(0);

    unsubscribeOriginal();
    state.subscribeCommits(countOriginal);
    expect(() => state.subscribeCommits(countOriginal)).toThrow(StateCapacityError);
    state.create('guild', { id: '100' });
    expect(originalCalls).toBe(2);
    expect(cloneCalls).toBe(2);
  });

  it('does not carry subscribers over to a clone', () => {
    const { state } = createState({ maxCommitSubscribers: 1 });
    const originalRevisions: number[] = [];
    state.subscribeCommits((commit) => {
      originalRevisions.push(commit.revision);
    });
    state.create('guild', { id: '100', name: 'Lab' });
    const clone = state.clone();
    clone.create('channel', { id: '200' });
    clone.update('guild', '100', { name: 'Clone' });
    expect(clone.revision).toBe(2);
    expect(originalRevisions).toEqual([1]);

    const cloneRevisions: number[] = [];
    clone.subscribeCommits((commit) => {
      cloneRevisions.push(commit.revision);
    });
    clone.delete('channel', '200');
    expect(cloneRevisions).toEqual([3]);
    expect(originalRevisions).toEqual([1]);
  });
});

describe('transaction activity flag', () => {
  it('exposes a read-only getter', () => {
    const prototype: object = VirtualState.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'transactionActive');
    const accessor: { readonly get?: unknown; readonly set?: unknown } = descriptor ?? {};
    expect(typeof accessor.get).toBe('function');
    expect(accessor.set).toBeUndefined();
    const { state } = createState();
    expect(() => {
      (state as unknown as { transactionActive: boolean }).transactionActive = true;
    }).toThrow(TypeError);
    expect(state.transactionActive).toBe(false);
  });

  it('is false for new instances, seeded instances and clones made inside a transaction', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const seeded = new VirtualState(clock, new SnowflakeGenerator(clock), [guild]);
    expect(seeded.transactionActive).toBe(false);
    const { state } = createState();
    expect(state.transactionActive).toBe(false);
    const cloneFlags: boolean[] = [];
    state.transaction('clone inside', () => {
      cloneFlags.push(state.transactionActive, state.clone().transactionActive);
    });
    expect(cloneFlags).toEqual([true, false]);
  });

  it('tracks nested transactions and returns to false after the outermost one', () => {
    const { state } = createState();
    const flags: boolean[] = [];
    state.transaction('outer', () => {
      flags.push(state.transactionActive);
      state.transaction('inner', () => {
        flags.push(state.transactionActive);
        state.create('guild', { id: '100' });
      });
      flags.push(state.transactionActive);
    });
    flags.push(state.transactionActive);
    expect(flags).toEqual([true, true, true, false]);
  });

  it('returns to false after failures, with and without an outer catch', () => {
    const { state } = createState();
    const flags: boolean[] = [];
    try {
      state.transaction('failing', () => {
        throw new Error('failure');
      });
    } catch {
      flags.push(state.transactionActive);
    }
    try {
      state.transaction('outer', () => {
        state.transaction('inner', () => {
          throw new Error('inner failure');
        });
      });
    } catch {
      flags.push(state.transactionActive);
    }
    state.transaction('outer catches', () => {
      try {
        state.transaction('inner', () => {
          throw new Error('inner failure');
        });
      } catch {
        flags.push(state.transactionActive);
      }
      flags.push(state.transactionActive);
    });
    flags.push(state.transactionActive);
    expect(flags).toEqual([false, false, true, true, false]);
  });

  it('is false while listeners run, for transactions and plain operations', () => {
    const { state } = createState();
    const flags: boolean[] = [];
    state.subscribeCommits(() => {
      flags.push(state.transactionActive);
    });
    state.create('guild', { id: '100' });
    state.transaction('wrapped', () => {
      state.create('guild', { id: '101' });
    });
    expect(flags).toEqual([false, false]);
  });

  it('is false after rejected mutations during notification', () => {
    const { state } = createState();
    const flags: boolean[] = [];
    state.subscribeCommits(() => {
      try {
        state.transaction('reentrant', () => undefined);
      } catch {
        flags.push(state.transactionActive);
      }
    });
    state.create('guild', { id: '100' });
    expect(flags).toEqual([false]);
  });

  it('is false around plain operations, including failed ones', () => {
    const { clock, state } = createState();
    const other = new VirtualState(clock, new SnowflakeGenerator(clock));
    const operations: (() => unknown)[] = [
      () => state.create('guild', { id: '100' }),
      () => state.update('guild', '100', { name: 'Lab' }),
      () => state.delete('guild', '100'),
      () => state.undo(),
      () => state.redo(),
      () => state.restore(other.snapshot()),
      () => state.reset(),
      () => state.importFixture(other.exportFixture()),
      () => state.update('guild', 'missing', { name: 'x' }),
      () => state.importFixture('{broken'),
    ];
    const flags: boolean[] = [];
    for (const operation of operations) {
      flags.push(state.transactionActive);
      try {
        operation();
      } catch {
        // Failed operations are part of this check.
      }
      flags.push(state.transactionActive);
    }
    expect(flags).toEqual(Array.from({ length: 20 }, () => false));
  });

  it('does not change anything when read', () => {
    const { state } = createState();
    state.create('guild', { id: '100' });
    let calls = 0;
    state.subscribeCommits(() => {
      calls += 1;
    });
    const before = state.revisionedSnapshot();
    const history = state.mutationHistory();
    const values = [state.transactionActive, state.transactionActive];
    expect(values).toEqual([false, false]);
    expect(state.revisionedSnapshot()).toEqual(before);
    expect(state.mutationHistory()).toEqual(history);
    expect(calls).toBe(0);
  });
});

type GuildResource = ResourceRecord & { readonly v: number };

function guildAt(v: number): GuildResource {
  return { id: '100', resourceType: 'guild', v };
}

interface ObservedStep {
  readonly result: unknown;
  readonly before: ResourceRecord | undefined;
  readonly after: ResourceRecord | undefined;
  readonly beforeAll: readonly ResourceRecord[];
  readonly afterAll: readonly ResourceRecord[];
  readonly revision: number;
  readonly commits: readonly StateCommit[];
}

function observeStep(
  state: VirtualState,
  commits: readonly StateCommit[],
  action: () => unknown,
): ObservedStep {
  const before = state.get('guild', '100');
  const beforeAll = state.list();
  const emitted = commits.length;
  const result = action();
  return {
    result,
    before,
    after: state.get('guild', '100'),
    beforeAll,
    afterAll: state.list(),
    revision: state.revision,
    commits: commits.slice(emitted),
  };
}

function keyOf(resource: ResourceRecord): string {
  return `${resource.resourceType}/${resource.id}`;
}

function sortByKey(resources: Iterable<ResourceRecord>): ResourceRecord[] {
  return [...resources].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function changedFieldsBetween(before: ResourceRecord, after: ResourceRecord): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .sort();
}

/** Checks a commit against the live resources captured right before and right after it. */
function expectCommitMatchesLiveState(step: ObservedStep): void {
  expect(step.commits).toHaveLength(1);
  const diff = step.commits[0]?.diff;
  if (diff === undefined) return;
  const before = new Map(step.beforeAll.map((resource) => [keyOf(resource), resource]));
  const after = new Map(step.afterAll.map((resource) => [keyOf(resource), resource]));
  for (const resource of diff.added) {
    expect(before.has(keyOf(resource))).toBe(false);
    expect(resource).toEqual(after.get(keyOf(resource)));
  }
  for (const resource of diff.deleted) {
    expect(resource).toEqual(before.get(keyOf(resource)));
    expect(after.has(keyOf(resource))).toBe(false);
  }
  for (const change of diff.updated) {
    expect(change.before).toEqual(before.get(keyOf(change.before)));
    expect(change.after).toEqual(after.get(keyOf(change.after)));
    expect(change.changedFields).toEqual(changedFieldsBetween(change.before, change.after));
  }
  const applied = new Map(before);
  for (const resource of diff.deleted) applied.delete(keyOf(resource));
  for (const resource of diff.added) applied.set(keyOf(resource), resource);
  for (const change of diff.updated) applied.set(keyOf(change.after), change.after);
  expect(sortByKey(applied.values())).toEqual(sortByKey(after.values()));
}

function runUndoRedoSequence(): {
  readonly steps: readonly ObservedStep[];
  readonly historyAfter: readonly (readonly StateMutationSummary[])[];
} {
  const { state } = createState();
  const commits = recordCommits(state);
  const steps: ObservedStep[] = [];
  const historyAfter: (readonly StateMutationSummary[])[] = [];
  const record = (action: () => unknown): void => {
    steps.push(observeStep(state, commits, action));
    historyAfter.push(state.mutationHistory());
  };
  record(() => state.create('guild', { id: '100', v: 0 }));
  record(() => state.update('guild', '100', { v: 1 }));
  record(() =>
    state.transaction('t', () => {
      state.undo();
      state.update('guild', '100', { v: 2 });
    }),
  );
  record(() => state.undo());
  record(() => state.undo());
  record(() => state.redo());
  record(() => state.redo());
  return { steps, historyAfter };
}

function stepAt(steps: readonly ObservedStep[], index: number): ObservedStep {
  const step = steps[index];
  if (step === undefined) throw new Error(`Missing step ${String(index)}.`);
  return step;
}

const storedUndoRedoHistory = [
  { added: [guildAt(0)], updated: [], deleted: [] },
  {
    added: [],
    updated: [{ before: guildAt(1), after: guildAt(2), changedFields: ['v'] }],
    deleted: [],
  },
];

describe('history move commit diffs', () => {
  it('reports create, update and transaction steps with their live before and after', () => {
    const { steps } = runUndoRedoSequence();
    const created = stepAt(steps, 0);
    expect(created.commits).toMatchObject([
      { operation: 'create', revision: 1, diff: { added: [guildAt(0)], updated: [], deleted: [] } },
    ]);
    expect(created.commits[0]?.diff.added[0]).toEqual(created.after);
    const updated = stepAt(steps, 1);
    expect(updated.commits).toMatchObject([
      {
        operation: 'update',
        revision: 2,
        diff: {
          added: [],
          updated: [{ before: guildAt(0), after: guildAt(1), changedFields: ['v'] }],
          deleted: [],
        },
      },
    ]);
    const transaction = stepAt(steps, 2);
    expect(transaction.commits).toMatchObject([
      {
        operation: 'transaction',
        revision: 3,
        diff: {
          added: [],
          updated: [{ before: guildAt(1), after: guildAt(2), changedFields: ['v'] }],
          deleted: [],
        },
      },
    ]);
    for (const step of [updated, transaction]) {
      expect(step.commits[0]?.diff.updated[0]?.before).toEqual(step.before);
      expect(step.commits[0]?.diff.updated[0]?.after).toEqual(step.after);
    }
  });

  it('reports an undone transaction with the live before and after', () => {
    const { steps } = runUndoRedoSequence();
    const step = stepAt(steps, 3);
    expect(step.result).toBe(true);
    expect(step.after).toEqual(guildAt(1));
    expect(step.commits).toMatchObject([
      {
        operation: 'undo',
        revision: 4,
        diff: {
          added: [],
          updated: [{ before: guildAt(2), after: guildAt(1), changedFields: ['v'] }],
          deleted: [],
        },
      },
    ]);
    expect(step.commits[0]?.diff.updated[0]?.before).toEqual(step.before);
    expect(step.commits[0]?.diff.updated[0]?.after).toEqual(step.after);
  });

  it('reports an undone create with the resource as it was right before the undo', () => {
    const { steps } = runUndoRedoSequence();
    const step = stepAt(steps, 4);
    expect(step.result).toBe(true);
    expect(step.before).toEqual(guildAt(1));
    expect(step.after).toBeUndefined();
    expect(step.commits).toHaveLength(1);
    expect(step.commits[0]?.diff.deleted[0]).toEqual(step.before);
    expect(step.commits[0]).toMatchObject({
      operation: 'undo',
      revision: 5,
      diff: { added: [], updated: [], deleted: [guildAt(1)] },
    });
    expect(step.revision).toBe(5);
  });

  it('reports a redone create with the restored resource', () => {
    const { steps } = runUndoRedoSequence();
    const step = stepAt(steps, 5);
    expect(step.result).toBe(true);
    expect(step.after).toEqual(guildAt(0));
    expect(step.commits).toMatchObject([
      { operation: 'redo', revision: 6, diff: { added: [guildAt(0)], updated: [], deleted: [] } },
    ]);
    expect(step.commits[0]?.diff.added[0]).toEqual(step.after);
  });

  it('reports a redone transaction with the live before instead of the stored one', () => {
    const { steps } = runUndoRedoSequence();
    const step = stepAt(steps, 6);
    expect(step.result).toBe(true);
    expect(step.before).toEqual(guildAt(0));
    expect(step.after).toEqual(guildAt(2));
    expect(step.commits).toMatchObject([
      {
        operation: 'redo',
        revision: 7,
        diff: {
          added: [],
          updated: [{ before: guildAt(0), after: guildAt(2), changedFields: ['v'] }],
          deleted: [],
        },
      },
    ]);
    expect(step.commits[0]?.diff.updated[0]?.before).toEqual(step.before);
    expect(step.commits[0]?.diff.updated[0]?.after).toEqual(step.after);
  });

  it('keeps the stored history entries unchanged through undo and redo', () => {
    const { historyAfter } = runUndoRedoSequence();
    for (const index of [2, 3, 4, 6]) {
      const history = historyAfter[index];
      expect(history?.map((entry) => entry.label)).toEqual(['create:guild/100', 't']);
      expect(history?.map((entry) => entry.diff)).toEqual(storedUndoRedoHistory);
    }
  });

  it('describes the live before and after in every undo and redo commit', () => {
    const { steps } = runUndoRedoSequence();
    for (const index of [3, 4, 5, 6]) expectCommitMatchesLiveState(stepAt(steps, index));
  });

  it('reports the steps before an undo without a net change from live state', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const state = new VirtualState(clock, new SnowflakeGenerator(clock), [guildAt(0)]);
    const commits = recordCommits(state);
    const steps = [
      observeStep(state, commits, () => state.update('guild', '100', { v: 1 })),
      observeStep(state, commits, () => state.update('guild', '100', { v: 0 })),
      observeStep(state, commits, () =>
        state.transaction('t', () => {
          state.undo();
          state.update('guild', '100', { v: 2 });
        }),
      ),
      observeStep(state, commits, () => state.undo()),
    ];
    const expected = [
      ['update', 0, 1],
      ['update', 1, 0],
      ['transaction', 0, 2],
      ['undo', 2, 0],
    ] as const;
    expected.forEach(([operation, from, to], index) => {
      const step = stepAt(steps, index);
      expect(step.commits).toMatchObject([
        {
          operation,
          revision: index + 1,
          diff: {
            added: [],
            updated: [{ before: guildAt(from), after: guildAt(to), changedFields: ['v'] }],
            deleted: [],
          },
        },
      ]);
      expect(step.commits[0]?.diff.updated[0]?.before).toEqual(step.before);
      expect(step.commits[0]?.diff.updated[0]?.after).toEqual(step.after);
    });
    expect(state.revision).toBe(4);
    expect(commits).toHaveLength(4);
    expect(state.list()).toEqual([guildAt(0)]);
  });

  it('moves history but emits no commit for an undo whose result equals the current state', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const state = new VirtualState(clock, new SnowflakeGenerator(clock), [guildAt(0)]);
    const commits = recordCommits(state);
    state.update('guild', '100', { v: 1 });
    state.update('guild', '100', { v: 0 });
    state.transaction('t', () => {
      state.undo();
      state.update('guild', '100', { v: 2 });
    });
    const historyAfterTransaction = state.mutationHistory();
    expect(state.undo()).toBe(true);
    const historyAfterUndo = state.mutationHistory();

    expect(state.undo()).toBe(true);
    expect(state.revision).toBe(4);
    expect(commits).toHaveLength(4);
    expect(state.get('guild', '100')).toEqual(guildAt(0));
    expect(state.list()).toHaveLength(1);
    const historyAfterNoChangeUndo = state.mutationHistory();
    for (const history of [historyAfterTransaction, historyAfterUndo, historyAfterNoChangeUndo]) {
      expect(history.map((entry) => entry.diff)).toEqual([
        {
          added: [],
          updated: [{ before: guildAt(0), after: guildAt(1), changedFields: ['v'] }],
          deleted: [],
        },
        {
          added: [],
          updated: [{ before: guildAt(0), after: guildAt(2), changedFields: ['v'] }],
          deleted: [],
        },
      ]);
    }
    expect(state.undo()).toBe(false);
    expect(state.redo()).toBe(true);
  });
});

describe('history move resource limit', () => {
  const first = { id: '1', resourceType: 'guild' };
  const second = { id: '2', resourceType: 'guild' };

  function createLimitedState(): { readonly state: VirtualState; readonly commits: StateCommit[] } {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const state = new VirtualState(clock, new SnowflakeGenerator(clock), [first], {
      maxResources: 1,
    });
    return { state, commits: recordCommits(state) };
  }

  it('deletes a resource at the resource limit with one commit', () => {
    const { state, commits } = createLimitedState();
    state.delete('guild', '1');
    expect(state.revision).toBe(1);
    expect(commits).toHaveLength(1);
    expect(state.list()).toHaveLength(0);
    expect(commits[0]?.diff).toEqual({ added: [], updated: [], deleted: [first] });
  });

  it('rolls back a transaction whose undo would exceed the resource limit', () => {
    const { state, commits } = createLimitedState();
    state.delete('guild', '1');
    const historyAfterDelete = state.mutationHistory();
    let countAfterCreate = -1;

    expect(() =>
      state.transaction('k', () => {
        state.create('guild', { id: '2' });
        countAfterCreate = state.list().length;
        state.undo();
      }),
    ).toThrow(StateCapacityError);
    expect(countAfterCreate).toBe(1);
    expect(state.revision).toBe(1);
    expect(commits).toHaveLength(1);
    expect(state.list()).toHaveLength(0);
    expect(state.get('guild', first.id)).toBeUndefined();
    expect(state.get('guild', second.id)).toBeUndefined();
    expect(state.transactionActive).toBe(false);
    expect(state.mutationHistory()).toEqual(historyAfterDelete);

    expect(state.undo()).toBe(true);
    expect(state.revision).toBe(2);
    expect(commits).toHaveLength(2);
    expect(state.list()).toHaveLength(1);
    expect(commits[1]).toMatchObject({
      operation: 'undo',
      diff: { added: [first], updated: [], deleted: [] },
    });
  });
});
