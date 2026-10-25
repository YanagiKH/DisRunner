import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import tracking from '../../packages/adapter-discordjs/handler-tracking.cjs';

function setup(captureRejections = false) {
  class TrackedEmitter extends EventEmitter {}
  const records = [];
  const errors = [];
  const tracker = tracking.createHandlerTracker(
    (record) => records.push(record),
    (error) => errors.push(error),
  );
  tracking.trackEventListeners(TrackedEmitter.prototype, new Set(['dispatch']), tracker);
  return { emitter: new TrackedEmitter({ captureRejections }), records, errors, tracker };
}

test('handler scopes preserve listener identity, order, once and removal APIs', () => {
  const { emitter, records, tracker } = setup();
  assert.equal(emitter.on, emitter.addListener);
  assert.equal(emitter.off, emitter.removeListener);
  const calls = [];
  const normal = function () {
    assert.equal(this, emitter);
    calls.push('normal');
  };
  const one = () => calls.push('once');
  const first = () => calls.push('first');
  emitter.on('dispatch', normal);
  emitter.once('dispatch', one);
  emitter.prependOnceListener('dispatch', first);
  assert.deepEqual(emitter.listeners('dispatch'), [first, normal, one]);
  const raw = emitter.rawListeners('dispatch');
  assert.equal(raw[0].listener, first);
  assert.equal(raw[1], normal);
  assert.equal(raw[2].listener, one);
  emitter.emit('dispatch');
  emitter.emit('dispatch');
  assert.deepEqual(calls, ['first', 'normal', 'once', 'normal']);
  assert.equal(tracker.activeCount, 0);
  assert.equal(records.filter((record) => record.phase === 'start').length, 4);
  assert.deepEqual(emitter.listeners('dispatch'), [normal]);
  emitter.addListener('dispatch', normal);
  assert.equal(emitter.listenerCount('dispatch', normal), 2);
  emitter.removeListener('dispatch', normal);
  assert.equal(emitter.listenerCount('dispatch', normal), 1);
  emitter.off('dispatch', normal);
  assert.deepEqual(emitter.listeners('dispatch'), []);
  emitter.once('dispatch', one);
  emitter.off('dispatch', one);
  assert.deepEqual(emitter.listeners('dispatch'), []);
  emitter.once('dispatch', one);
  emitter.removeListener('dispatch', emitter.rawListeners('dispatch')[0]);
  assert.deepEqual(emitter.listeners('dispatch'), []);
  emitter.on('dispatch', normal);
  assert.throws(() => emitter.removeListener('dispatch', undefined), TypeError);
  assert.equal(emitter.listenerCount('dispatch'), 1);
  emitter.removeAllListeners('dispatch');
  assert.equal(emitter.listenerCount('dispatch'), 0);
});

test('an async once listener stays active through its awaited work and runs once', async () => {
  const { emitter, records, tracker } = setup();
  const gate = Promise.withResolvers();
  let calls = 0;
  emitter.once('dispatch', async () => {
    calls += 1;
    await gate.promise;
  });
  emitter.emit('dispatch');
  emitter.emit('dispatch');
  assert.equal(calls, 1);
  assert.equal(tracker.activeCount, 1);
  assert.equal(emitter.listenerCount('dispatch'), 0);
  assert.deepEqual(
    records.map((record) => record.phase),
    ['start'],
  );
  gate.resolve();
  await setImmediate();
  assert.equal(tracker.activeCount, 0);
  assert.deepEqual(
    records.map((record) => record.phase),
    ['start', 'end'],
  );
  assert.equal(records[0].id, records[1].id);
});

test('handler scopes preserve synchronous throws and native rejection capture', async () => {
  const { emitter, records, tracker } = setup(true);
  const failure = new Error('handler failed');
  const rejected = once(emitter, 'error');
  emitter.on('dispatch', async () => {
    throw failure;
  });
  emitter.emit('dispatch');
  assert.equal((await rejected)[0], failure);
  assert.equal(tracker.activeCount, 0);
  assert.deepEqual(
    records.map((record) => record.phase),
    ['start', 'end'],
  );
  emitter.removeAllListeners('dispatch');
  emitter.on('dispatch', () => {
    throw failure;
  });
  assert.throws(
    () => emitter.emit('dispatch'),
    (error) => error === failure,
  );
  assert.equal(tracker.activeCount, 0);
});

test('custom thenables keep native execution and produce an unsupported diagnostic', () => {
  const plain = setup();
  let plainCalls = 0;
  plain.emitter.on('dispatch', () => ({
    then: () => {
      plainCalls += 1;
    },
  }));
  plain.emitter.emit('dispatch');
  assert.equal(plainCalls, 0);
  assert.equal(plain.tracker.activeCount, 0);
  assert.match(plain.errors[0].message, /custom thenables are unsupported/);
  const captured = setup(true);
  let capturedCalls = 0;
  captured.emitter.on('dispatch', () => ({
    then: () => {
      capturedCalls += 1;
    },
  }));
  captured.emitter.emit('dispatch');
  assert.equal(capturedCalls, 1);
  assert.match(captured.errors[0].message, /custom thenables are unsupported/);
});

test('active handler scopes are bounded and their markers contain no event payload', async () => {
  const { emitter, records, errors, tracker } = setup();
  const gate = Promise.withResolvers();
  emitter.on('dispatch', async () => gate.promise);
  for (let index = 0; index < 1001; index += 1)
    emitter.emit('dispatch', { secret: 'payload-must-not-be-logged' });
  assert.equal(tracker.activeCount, 1000);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /active handler limit/);
  assert.equal(new Set(records.map((record) => record.id)).size, 1000);
  assert.ok(records.every((record) => /^[A-Za-z0-9_-]{1,64}$/.test(record.id)));
  assert.doesNotMatch(JSON.stringify(records), /payload-must-not-be-logged/);
  gate.resolve();
  await setImmediate();
  assert.equal(tracker.activeCount, 0);
  assert.equal(records.filter((record) => record.phase === 'end').length, 1000);
});
