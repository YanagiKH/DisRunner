import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  ResourceNotFoundError,
  SnowflakeGenerator,
  StateCapacityError,
  StateConflictError,
  VirtualClock,
  VirtualState,
} from '../../src/index.js';
import type { StateCommit, VirtualStateOptions } from '../../src/index.js';

const START_MS = DISCORD_EPOCH_MS + 1_000;
const DEFAULT_OPTIONS: VirtualStateOptions = { maxHistoryEntries: 3 };

interface Twin {
  readonly state: VirtualState;
  readonly commits: StateCommit[];
}

function createTwin(options: VirtualStateOptions): Twin {
  const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
  const state = new VirtualState(clock, new SnowflakeGenerator(clock), [], options);
  const commits: StateCommit[] = [];
  state.subscribeCommits((commit) => {
    commits.push(commit);
  });
  return { state, commits };
}

function fillHistory(state: VirtualState): void {
  state.create('guild', { id: '100', name: 'Original' });
  state.update('guild', '100', { name: 'One' });
  state.update('guild', '100', { name: 'Two' });
  state.create('channel', { id: '200', name: 'general' });
}

/**
 * Builds two identically configured and prepared instances. A test runs a failing operation on
 * the first one and compares it with the untouched second one.
 */
function createTwins(
  prepare: (state: VirtualState) => void = fillHistory,
  options: VirtualStateOptions = DEFAULT_OPTIONS,
): readonly [Twin, Twin] {
  const actual = createTwin(options);
  const expected = createTwin(options);
  prepare(actual.state);
  prepare(expected.state);
  return [actual, expected];
}

function expectSameObservable(actual: Twin, expected: Twin): void {
  expect(actual.state.snapshot()).toEqual(expected.state.snapshot());
  expect(actual.state.mutationHistory()).toEqual(expected.state.mutationHistory());
  expect(actual.state.revision).toBe(expected.state.revision);
  expect(actual.commits).toHaveLength(expected.commits.length);
  expect(actual.state.transactionActive).toBe(false);
}

function expectSameFollowUp(actual: Twin, expected: Twin): void {
  expectSameObservable(actual, expected);
  const steps: ((state: VirtualState) => boolean)[] = [
    (state) => state.undo(),
    (state) => state.undo(),
    (state) => state.redo(),
  ];
  for (const step of steps) {
    expect(step(actual.state)).toBe(step(expected.state));
    expect(actual.state.snapshot()).toEqual(expected.state.snapshot());
  }
  for (const name of ['after-1', 'after-2', 'after-3', 'after-4']) {
    actual.state.update('guild', '100', { name });
    expected.state.update('guild', '100', { name });
  }
  expectSameObservable(actual, expected);
  expect(actual.state.mutationHistory()).toHaveLength(3);
  expect(actual.commits).toEqual(expected.commits);
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectRejectedResult(result: unknown): void {
  const [actual, expected] = createTwins();
  const thrown = captureError(() =>
    actual.state.transaction('rejected', () => {
      actual.state.update('guild', '100', { name: 'Changed' });
      actual.state.create('channel', { id: '201' });
      return result;
    }),
  );
  expect(thrown).toBeInstanceOf(TypeError);
  expect(actual.state.transactionActive).toBe(false);
  expectSameFollowUp(actual, expected);
}

function expectAcceptedResult(result: unknown): void {
  const [actual, expected] = createTwins();
  const returned = actual.state.transaction('accepted', () => {
    actual.state.update('guild', '100', { name: 'Changed' });
    return result;
  });
  expected.state.transaction('accepted', () => {
    expected.state.update('guild', '100', { name: 'Changed' });
  });
  expect(returned).toBe(result);
  expect(actual.commits.at(-1)?.operation).toBe('transaction');
  expectSameFollowUp(actual, expected);
}

const TRAP_NAMES = [
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
] as const;

type TrapCounts = Record<(typeof TRAP_NAMES)[number], number>;

function zeroCounts(): TrapCounts {
  const counts: Partial<TrapCounts> = {};
  for (const name of TRAP_NAMES) counts[name] = 0;
  return counts as TrapCounts;
}

function resetCounts(counts: TrapCounts): void {
  for (const name of TRAP_NAMES) counts[name] = 0;
}

interface CountingProxy<T> {
  readonly proxy: T;
  readonly counts: TrapCounts;
}

function countingProxy<T extends object>(target: T): CountingProxy<T> {
  const counts = zeroCounts();
  const handler: ProxyHandler<T> = {
    apply(inner, thisArg: unknown, args: unknown[]) {
      counts.apply += 1;
      const callable = inner as unknown as (...values: unknown[]) => unknown;
      return Reflect.apply(callable, thisArg, args);
    },
    construct(inner, args: unknown[], newTarget) {
      counts.construct += 1;
      const constructable = inner as unknown as new (...values: unknown[]) => object;
      const derived = newTarget as new (...values: unknown[]) => object;
      return Reflect.construct(constructable, args, derived);
    },
    defineProperty(inner, key, attributes) {
      counts.defineProperty += 1;
      return Reflect.defineProperty(inner, key, attributes);
    },
    deleteProperty(inner, key) {
      counts.deleteProperty += 1;
      return Reflect.deleteProperty(inner, key);
    },
    get(inner, key, receiver: unknown) {
      counts.get += 1;
      const value: unknown = Reflect.get(inner, key, receiver);
      return value;
    },
    getOwnPropertyDescriptor(inner, key) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, key);
    },
    getPrototypeOf(inner) {
      counts.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(inner);
    },
    has(inner, key) {
      counts.has += 1;
      return Reflect.has(inner, key);
    },
    isExtensible(inner) {
      counts.isExtensible += 1;
      return Reflect.isExtensible(inner);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    preventExtensions(inner) {
      counts.preventExtensions += 1;
      return Reflect.preventExtensions(inner);
    },
    set(inner, key, value: unknown, receiver: unknown) {
      counts.set += 1;
      return Reflect.set(inner, key, value, receiver);
    },
    setPrototypeOf(inner, prototype) {
      counts.setPrototypeOf += 1;
      return Reflect.setPrototypeOf(inner, prototype);
    },
  };
  return { proxy: new Proxy(target, handler), counts };
}

function prototypeChain(length: number): object {
  let current = Object.create(null) as object;
  for (let index = 1; index < length; index += 1) {
    current = Object.create(current) as object;
  }
  return current;
}

interface FailureCase {
  readonly run: (state: VirtualState) => unknown;
  readonly error: new (...args: never[]) => Error;
  readonly options?: VirtualStateOptions;
}

const failureCases: readonly FailureCase[] = [
  {
    run: (state) => state.create('guild', { id: 5 }),
    error: TypeError,
  },
  {
    run: (state) => state.create('guild', { id: '100' }),
    error: StateConflictError,
  },
  {
    run: (state) => state.update('guild', 'missing', { name: 'x' }),
    error: ResourceNotFoundError,
  },
  {
    run: (state) => state.delete('guild', 'missing'),
    error: ResourceNotFoundError,
  },
  {
    run: (state) => state.update('guild', '100', { id: '101' }),
    error: StateConflictError,
  },
  {
    run: (state) => state.update('guild', '100', { resourceType: 'channel' }),
    error: StateConflictError,
  },
  {
    run: (state) => state.create('role', { id: '300' }),
    error: StateCapacityError,
    options: { maxHistoryEntries: 3, maxResources: 2 },
  },
  {
    run: (state) => state.create('role', { id: '300', name: 'x'.repeat(200) }),
    error: StateCapacityError,
    options: { maxHistoryEntries: 3, maxStateBytes: 200 },
  },
  {
    run: (state) => state.restore({ ...state.snapshot(), hash: '0'.repeat(64) }),
    error: StateConflictError,
  },
  {
    run: (state) => {
      const snapshot = state.snapshot();
      const resources = [...snapshot.resources, ...snapshot.resources];
      return state.restore({ ...snapshot, resources });
    },
    error: StateConflictError,
  },
  {
    run: (state) => {
      const snapshot = { ...state.snapshot(), version: 2 };
      return state.restore(snapshot as unknown as Parameters<VirtualState['restore']>[0]);
    },
    error: RangeError,
  },
  {
    run: (state) => state.importFixture('{"resources": ['),
    error: SyntaxError,
  },
  {
    run: (state) => {
      const fixture = JSON.stringify({ resources: [], padding: 'x'.repeat(80) });
      return state.importFixture(fixture);
    },
    error: StateCapacityError,
    options: { maxHistoryEntries: 3, maxFixtureBytes: 64 },
  },
  {
    run: (state) => {
      const role = { id: '300', resourceType: 'role' };
      return state.importFixture(JSON.stringify({ resources: [role, role] }));
    },
    error: StateConflictError,
  },
];

describe('transaction atomicity', () => {
  it('rolls back a failed outer transaction when history is already at capacity', () => {
    const [actual, expected] = createTwins();
    expect(() =>
      actual.state.transaction('failing', () => {
        actual.state.update('guild', '100', { name: 'Changed' });
        actual.state.create('channel', { id: '201' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(actual.state.mutationHistory()).toHaveLength(3);
    expectSameFollowUp(actual, expected);
  });

  it('keeps the redo branch after a failed transaction that follows two undos', () => {
    const prepare = (state: VirtualState): void => {
      fillHistory(state);
      state.undo();
      state.undo();
    };
    const [actual, expected] = createTwins(prepare);
    expect(() =>
      actual.state.transaction('failing', () => {
        actual.state.create('role', { id: '300' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expectSameObservable(actual, expected);
    expect(actual.state.redo()).toBe(true);
    expect(expected.state.redo()).toBe(true);
    expect(actual.state.require('guild', '100')['name']).toBe('Two');
    expectSameFollowUp(actual, expected);
  });

  it('restores the history position after undo inside a failed transaction', () => {
    const prepare = (state: VirtualState): void => {
      fillHistory(state);
      state.undo();
    };
    const [actual, expected] = createTwins(prepare);
    expect(() =>
      actual.state.transaction('failing', () => {
        expect(actual.state.undo()).toBe(true);
        actual.state.update('guild', '100', { name: 'Changed' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expectSameObservable(actual, expected);
    expect(actual.state.redo()).toBe(true);
    expect(expected.state.redo()).toBe(true);
    expect(actual.state.get('channel', '200')?.['name']).toBe('general');
    expectSameFollowUp(actual, expected);
  });

  it('restores the history position after redo inside a failed transaction', () => {
    const prepare = (state: VirtualState): void => {
      fillHistory(state);
      state.undo();
    };
    const [actual, expected] = createTwins(prepare);
    expect(() =>
      actual.state.transaction('failing', () => {
        expect(actual.state.redo()).toBe(true);
        actual.state.create('role', { id: '300' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expectSameObservable(actual, expected);
    expect(actual.state.get('channel', '200')).toBeUndefined();
    expect(actual.state.redo()).toBe(true);
    expect(expected.state.redo()).toBe(true);
    expect(actual.state.get('channel', '200')?.['name']).toBe('general');
    expect(actual.state.redo()).toBe(false);
    expect(expected.state.redo()).toBe(false);
    expectSameFollowUp(actual, expected);
  });

  it('restores history after a failed transaction that moved it without a net change', () => {
    const moves: ((state: VirtualState) => void)[] = [
      (state) => {
        state.undo();
        state.create('channel', { id: '200', name: 'general' });
      },
      (state) => {
        state.undo();
        state.redo();
      },
    ];
    for (const move of moves) {
      const [actual, expected] = createTwins();
      const hash = actual.state.snapshot().hash;
      expect(() =>
        actual.state.transaction('failing', () => {
          move(actual.state);
          expect(actual.state.snapshot().hash).toBe(hash);
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expectSameObservable(actual, expected);
      expect(actual.state.redo()).toBe(false);
      expect(expected.state.redo()).toBe(false);
      expect(actual.state.undo()).toBe(true);
      expect(expected.state.undo()).toBe(true);
      expect(actual.state.get('channel', '200')).toBeUndefined();
      expectSameFollowUp(actual, expected);
    }
  });

  it('rolls back whole-state replacement inside a failed transaction', () => {
    const clock = new VirtualClock({ nowMs: START_MS, mode: 'paused' });
    const other = new VirtualState(clock, new SnowflakeGenerator(clock));
    other.create('role', { id: '300', name: 'replacement' });
    const replacements: ((state: VirtualState) => void)[] = [
      (state) => state.reset(),
      (state) => state.importFixture(other.exportFixture()),
      (state) => state.restore(other.snapshot()),
    ];
    for (const replace of replacements) {
      const [actual, expected] = createTwins();
      expect(() =>
        actual.state.transaction('failing', () => {
          replace(actual.state);
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expectSameFollowUp(actual, expected);
    }
  });

  it('rolls back everything when an inner transaction fails without an outer catch', () => {
    const [actual, expected] = createTwins();
    expect(() =>
      actual.state.transaction('outer', () => {
        actual.state.update('guild', '100', { name: 'Outer' });
        actual.state.transaction('inner', () => {
          actual.state.create('role', { id: '300' });
          throw new Error('inner failure');
        });
      }),
    ).toThrow('inner failure');
    expect(actual.commits).toHaveLength(4);
    expectSameFollowUp(actual, expected);
  });

  it('commits only outer changes when the outer transaction catches an inner failure', () => {
    const [actual, expected] = createTwins();
    const seenAfterInner: unknown[] = [];
    actual.state.transaction('outer', () => {
      actual.state.update('guild', '100', { name: 'Outer' });
      try {
        actual.state.transaction('inner', () => {
          actual.state.update('guild', '100', { name: 'Inner' });
          actual.state.create('channel', { id: '201' });
          throw new Error('inner failure');
        });
      } catch {
        seenAfterInner.push(actual.state.require('guild', '100')['name']);
        seenAfterInner.push(actual.state.get('channel', '201'));
      }
      actual.state.create('role', { id: '300', name: 'outer' });
    });
    expected.state.transaction('outer', () => {
      expected.state.update('guild', '100', { name: 'Outer' });
      expected.state.create('role', { id: '300', name: 'outer' });
    });

    expect(seenAfterInner).toEqual(['Outer', undefined]);
    expect(actual.commits).toHaveLength(5);
    expect(actual.commits.at(-1)?.diff).toEqual({
      added: [{ id: '300', resourceType: 'role', name: 'outer' }],
      updated: [
        {
          before: { id: '100', resourceType: 'guild', name: 'Two' },
          after: { id: '100', resourceType: 'guild', name: 'Outer' },
          changedFields: ['name'],
        },
      ],
      deleted: [],
    });
    expectSameFollowUp(actual, expected);
  });

  it('leaves state, history and revision unchanged when a direct operation is rejected', () => {
    for (const failure of failureCases) {
      const [actual, expected] = createTwins(fillHistory, failure.options);
      const thrown = captureError(() => failure.run(actual.state));
      expect(thrown).toBeInstanceOf(failure.error);
      expectSameFollowUp(actual, expected);
    }
  });

  it('runs a normal transaction after failures without leftover nesting', () => {
    const [actual] = createTwins();
    captureError(() => actual.state.create('guild', { id: '100' }));
    captureError(() =>
      actual.state.transaction('failing', () => {
        actual.state.transaction('inner', () => {
          throw new Error('inner failure');
        });
      }),
    );
    const revision = actual.state.revision;
    const commitCount = actual.commits.length;
    const flags: boolean[] = [];
    actual.state.transaction('normal', () => {
      flags.push(actual.state.transactionActive);
      actual.state.create('role', { id: '300' });
    });
    flags.push(actual.state.transactionActive);
    expect(flags).toEqual([true, false]);
    expect(actual.state.revision).toBe(revision + 1);
    expect(actual.commits).toHaveLength(commitCount + 1);
    expect(actual.commits.at(-1)?.label).toBe('normal');
  });

  it('rethrows the exact error object from the operation', () => {
    const [actual] = createTwins();
    const failure = new Error('identity');
    const direct = captureError(() =>
      actual.state.transaction('direct', () => {
        throw failure;
      }),
    );
    const nested = captureError(() =>
      actual.state.transaction('outer', () => {
        actual.state.transaction('inner', () => {
          throw failure;
        });
      }),
    );
    expect(direct).toBe(failure);
    expect(nested).toBe(failure);
  });
});

describe('synchronous transaction return contract', () => {
  it('rejects native promises and async results after rolling back', async () => {
    expectRejectedResult(Promise.resolve('value'));
    const finished = (async (): Promise<string> => {
      await Promise.resolve();
      return 'value';
    })();
    expectRejectedResult(finished);
    await expect(finished).resolves.toBe('value');
  });

  it('leaves a rejected native promise for the caller to handle', async () => {
    const rejected = Promise.reject(new Error('handled by the caller'));
    const settled = expect(rejected).rejects.toThrow('handled by the caller');
    expectRejectedResult(rejected);
    await settled;
  });

  it('rejects a custom thenable without calling its then method', () => {
    let thenCalls = 0;
    const thenable = {
      then: (): void => {
        thenCalls += 1;
      },
    };
    expectRejectedResult(thenable);
    expectRejectedResult(Object.create(thenable) as object);
    expect(thenCalls).toBe(0);
  });

  it('rejects proxies that are not thenables without running any trap', () => {
    const targets: object[] = [{}, [], function plain() {}];
    for (const target of targets) {
      const tracked = countingProxy(target);
      resetCounts(tracked.counts);
      expectRejectedResult(tracked.proxy);
      expect(tracked.counts).toEqual(zeroCounts());
    }
  });

  it('rejects accessor then properties without calling the getter or setter', () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const getFunction = (): unknown => {
      getterCalls += 1;
      return () => undefined;
    };
    const getValue = (): unknown => {
      getterCalls += 1;
      return 1;
    };
    const setValue = (next: unknown): void => {
      setterCalls += typeof next === 'undefined' ? 1 : 2;
    };
    const descriptors: PropertyDescriptor[] = [
      { get: getFunction, configurable: true },
      { get: getValue, configurable: true },
      { set: setValue, configurable: true },
      { get: getFunction, set: setValue, configurable: true },
    ];
    for (const descriptor of descriptors) {
      const own = Object.defineProperty({}, 'then', descriptor);
      expectRejectedResult(own);
      const inherited = Object.create(Object.defineProperty({}, 'then', descriptor)) as object;
      expectRejectedResult(inherited);
    }
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
  });

  it('rejects results whose prototype chain contains a proxy without running any trap', () => {
    const withThen = countingProxy({ then: () => undefined });
    const withoutThen = countingProxy({});
    for (const tracked of [withThen, withoutThen]) {
      const result = Object.create(Object.create(tracked.proxy) as object) as object;
      resetCounts(tracked.counts);
      expectRejectedResult(result);
      expect(tracked.counts).toEqual(zeroCounts());
    }

    class Base {}
    class Middle extends Base {}
    class Leaf extends Middle {}
    const instance = new Leaf();
    const tracked = countingProxy(Object.create(Base.prototype) as object);
    Object.setPrototypeOf(Middle.prototype, tracked.proxy);
    resetCounts(tracked.counts);
    expectRejectedResult(instance);
    expect(tracked.counts).toEqual(zeroCounts());
  });

  it('accepts a prototype chain of 64 objects and rejects 65 or more', () => {
    expectAcceptedResult(prototypeChain(64));
    expectRejectedResult(prototypeChain(65));
    expectRejectedResult(prototypeChain(1_000));
  });

  it('returns ordinary values unchanged and commits normally', () => {
    class First {}
    class Second extends First {}
    class Third extends Second {}
    const values: unknown[] = [
      undefined,
      null,
      7,
      'text',
      { name: 'plain' },
      ['item'],
      new Third(),
      { then: 1 },
      Object.create(null) as object,
      () => 'value',
    ];
    for (const value of values) expectAcceptedResult(value);
  });

  it('rejects a nested thenable and keeps only outer changes when the outer catches', () => {
    const [actual, expected] = createTwins();
    expect(() =>
      actual.state.transaction('outer', () => {
        actual.state.update('guild', '100', { name: 'Outer' });
        void actual.state.transaction('inner', () => {
          actual.state.create('channel', { id: '201' });
          return Promise.resolve('inner');
        });
      }),
    ).toThrow(TypeError);
    expectSameFollowUp(actual, expected);

    const [catching, reference] = createTwins();
    catching.state.transaction('outer', () => {
      catching.state.update('guild', '100', { name: 'Outer' });
      const thrown = captureError(() =>
        catching.state.transaction('inner', () => {
          catching.state.create('channel', { id: '201' });
          return Promise.resolve('inner');
        }),
      );
      expect(thrown).toBeInstanceOf(TypeError);
      expect(catching.state.get('channel', '201')).toBeUndefined();
    });
    reference.state.transaction('outer', () => {
      reference.state.update('guild', '100', { name: 'Outer' });
    });
    expect(catching.commits).toHaveLength(5);
    expectSameFollowUp(catching, reference);
  });

  it('runs a normal synchronous transaction after rejecting a thenable', () => {
    const [actual] = createTwins();
    captureError(() => actual.state.transaction('rejected', () => Promise.resolve(1)));
    const revision = actual.state.revision;
    const result = actual.state.transaction('normal', () => {
      actual.state.create('role', { id: '300' });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(actual.state.revision).toBe(revision + 1);
    expect(actual.commits.at(-1)?.label).toBe('normal');
    expect(actual.state.transactionActive).toBe(false);
  });

  it('does not cancel code after an await; later mutations commit on their own', async () => {
    const [actual, expected] = createTwins();
    const holder: { pending?: Promise<void> } = {};
    const flags: boolean[] = [];
    const run = async (): Promise<void> => {
      actual.state.update('guild', '100', { name: 'Async' });
      await Promise.resolve();
      flags.push(actual.state.transactionActive);
      actual.state.create('role', { id: '300' });
    };
    const thrown = captureError(() =>
      actual.state.transaction('async', () => {
        holder.pending = run();
        return holder.pending;
      }),
    );
    expect(thrown).toBeInstanceOf(TypeError);
    expectSameObservable(actual, expected);

    const pending = holder.pending;
    expect(pending).toBeDefined();
    await pending;
    expect(flags).toEqual([false]);
    expect(actual.state.require('guild', '100')['name']).toBe('Two');
    expect(actual.state.revision).toBe(expected.state.revision + 1);
    expect(actual.commits.at(-1)?.operation).toBe('create');
    expect(actual.commits.at(-1)?.label).toBe('create:role/300');
    expected.state.create('role', { id: '300' });
    expectSameFollowUp(actual, expected);
  });
});
