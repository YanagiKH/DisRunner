import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  SeededRandom,
  SnowflakeGenerator,
  StateCapacityError,
  StateConflictError,
  VirtualClock,
  VirtualState,
} from '../../src/index.js';

describe('deterministic primitives', () => {
  it('runs equal-time scheduled work in insertion order and never moves backwards', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS, mode: 'paused' });
    const calls: number[] = [];
    clock.schedule(10, () => calls.push(1));
    clock.schedule(10, () => calls.push(2));
    clock.schedule(5, () => calls.push(0));

    expect(clock.advanceBy(10)).toBe(DISCORD_EPOCH_MS + 10);
    expect(calls).toEqual([0, 1, 2]);
    expect(() => clock.set(DISCORD_EPOCH_MS)).toThrow(/backwards/i);
  });

  it('repeats seeded random sequences and generates Discord-layout snowflakes', () => {
    const left = new SeededRandom(42);
    const right = new SeededRandom(42);
    expect(Array.from({ length: 20 }, () => left.next())).toEqual(
      Array.from({ length: 20 }, () => right.next()),
    );

    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 12_345 });
    const ids = new SnowflakeGenerator(clock, { workerId: 3, processId: 7 });
    const first = ids.generate();
    const second = ids.generate();
    expect(BigInt(second) - BigInt(first)).toBe(1n);
    expect(SnowflakeGenerator.decompose(second)).toEqual({
      timestampMs: DISCORD_EPOCH_MS + 12_345,
      workerId: 3,
      processId: 7,
      increment: 1,
    });
  });
});

describe('VirtualState', () => {
  function createState(): { clock: VirtualClock; state: VirtualState } {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const state = new VirtualState(clock, new SnowflakeGenerator(clock));
    return { clock, state };
  }

  it('preserves unknown fields, reports diffs, and supports undo/redo', () => {
    const { state } = createState();
    const empty = state.snapshot();
    const guild = state.create('guild', {
      id: '100',
      name: 'Lab',
      future_field: { enabled: true },
    });
    expect(guild.future_field).toEqual({ enabled: true });
    state.update('guild', '100', { name: 'Lab 2' });

    expect(state.diff(empty)).toMatchObject({ added: [], deleted: [{ id: '100' }] });
    expect(state.undo()).toBe(true);
    expect(state.require('guild', '100')['name']).toBe('Lab');
    expect(state.redo()).toBe(true);
    expect(state.require('guild', '100')['name']).toBe('Lab 2');
  });

  it('rolls a transaction back atomically and detects tampered snapshots', () => {
    const { state } = createState();
    state.create('guild', { id: '100', name: 'Original' });
    expect(() =>
      state.transaction('bad update', () => {
        state.update('guild', '100', { name: 'Changed' });
        state.create('channel', { id: '200', guild_id: '100' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(state.require('guild', '100')['name']).toBe('Original');
    expect(state.get('channel', '200')).toBeUndefined();

    const snapshot = state.snapshot();
    expect(() => state.restore({ ...snapshot, hash: '0'.repeat(64) })).toThrow(StateConflictError);
  });

  it('creates one history entry for a successful transaction', () => {
    const { state } = createState();
    state.transaction('fixture', () => {
      state.create('guild', { id: '100' });
      state.create('channel', { id: '200', guild_id: '100' });
    });
    expect(state.mutationHistory()).toHaveLength(1);
    expect(state.mutationHistory()[0]?.diff.added).toHaveLength(2);
  });

  it('rejects conflicting ids', () => {
    const { state } = createState();
    state.create('guild', { id: '100' });
    expect(() => state.create('guild', { id: '100' })).toThrow(StateConflictError);
    expect(() => state.update('guild', '100', { id: '101' })).toThrow(StateConflictError);
  });

  it('does not expose mutable state references', () => {
    const { state } = createState();
    state.create('guild', { id: '100', nested: { value: 1 } });
    const copy = state.require('guild', '100');
    (copy['nested'] as { value: number }).value = 999;
    expect(state.require('guild', '100')['nested']).toEqual({ value: 1 });
  });

  it('bounds resources, serialized bytes, nesting, and retained undo history', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const state = new VirtualState(clock, new SnowflakeGenerator(clock), [], {
      maxResources: 2,
      maxHistoryEntries: 2,
      maxResourceBytes: 256,
      maxStateBytes: 512,
      maxHistoryBytes: 1_024,
    });
    state.create('guild', { id: '100', name: 'one' });
    state.create('channel', { id: '200', name: 'two' });
    expect(() => state.create('message', { id: '300', content: 'three' })).toThrow(
      StateCapacityError,
    );
    state.update('guild', '100', { name: 'updated-once' });
    state.update('guild', '100', { name: 'updated-twice' });
    expect(state.mutationHistory()).toHaveLength(2);
    expect(state.undo()).toBe(true);
    expect(state.require('guild', '100')['name']).toBe('updated-once');
    expect(state.undo()).toBe(true);
    expect(state.require('guild', '100')['name']).toBe('one');
    expect(state.undo()).toBe(false);

    const oversized = new VirtualState(clock, new SnowflakeGenerator(clock), [], {
      maxResourceBytes: 64,
    });
    expect(() => oversized.create('message', { id: '1', content: 'x'.repeat(100) })).toThrow(
      StateCapacityError,
    );
    const cyclic: { id: string; self?: unknown } = { id: '2' };
    cyclic.self = cyclic;
    expect(() => oversized.create('message', cyclic)).toThrow(TypeError);

    const barrier = new VirtualState(clock, new SnowflakeGenerator(clock), [], {
      maxHistoryBytes: 128,
      maxResourceBytes: 1_024,
    });
    barrier.create('guild', { id: '10', name: 'small' });
    barrier.update('guild', '10', { name: 'x'.repeat(300) });
    expect(barrier.mutationHistory()).toHaveLength(0);
    expect(barrier.undo()).toBe(false);
    expect(barrier.require('guild', '10')['name']).toBe('x'.repeat(300));
  });
});
