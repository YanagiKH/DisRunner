'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Shared with the CommonJS bootstrap. */

const { types } = require('node:util');

function createHandlerTracker(write, onError) {
  const active = new Set();
  let sequence = 0n;
  let capacityReported = false;
  const report = (message) => {
    try {
      onError(new Error(message));
    } catch {
      /* Preserve callback behavior. */
    }
  };
  const end = (id) => {
    if (id === null || !active.delete(id)) return;
    try {
      write({ id, phase: 'end' });
    } catch {
      report('Handler completion could not be observed.');
    }
  };
  return {
    get activeCount() {
      return active.size;
    },
    invoke(listener, receiver, args) {
      let id = null;
      if (active.size >= 1_000) {
        if (!capacityReported) report('The active handler limit of 1,000 was exceeded.');
        capacityReported = true;
      } else {
        do {
          sequence = (sequence + 1n) & 0xffff_ffff_ffff_ffffn;
          id = `js-${process.pid}-${sequence}`;
        } while (active.has(id));
        active.add(id);
        try {
          write({ id, phase: 'start' });
        } catch {
          active.delete(id);
          id = null;
          report('Handler startup could not be observed.');
        }
      }
      let result;
      try {
        result = Reflect.apply(listener, receiver, args);
      } catch (error) {
        end(id);
        throw error;
      }
      if (types.isPromise(result)) return Promise.prototype.finally.call(result, () => end(id));
      if (customThenable(result))
        report(
          'Tracked handlers must use async functions or return native Promises; custom thenables are unsupported.',
        );
      end(id);
      return result;
    },
  };
}

function customThenable(value) {
  if (value === null || !['object', 'function'].includes(typeof value)) return false;
  try {
    for (
      let current = value, depth = 0;
      current !== null;
      current = Object.getPrototypeOf(current), depth += 1
    ) {
      if (depth >= 16 || types.isProxy(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
      if (descriptor)
        return !Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function';
    }
  } catch {
    return true;
  }
  return false;
}

function trackEventListeners(prototype, events, tracker) {
  const nativeOn = prototype.on;
  const nativeAdd = prototype.addListener;
  const nativePrepend = prototype.prependListener;
  const nativeRemove = prototype.removeListener;
  const nativeRaw = prototype.rawListeners;
  const wrapped = new WeakMap();
  const callback = (event, listener) => {
    if (!events.has(event) || typeof listener !== 'function') return listener;
    const descriptor = Object.getOwnPropertyDescriptor(listener, 'listener');
    const original =
      descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        ? descriptor.value
        : listener;
    const tracked = function (...args) {
      return tracker.invoke(listener, this, args);
    };
    Object.defineProperty(tracked, 'listener', { value: original });
    wrapped.set(tracked, listener);
    return tracked;
  };
  prototype.on = function (event, listener) {
    return nativeOn.call(this, event, callback(event, listener));
  };
  prototype.addListener =
    nativeAdd === nativeOn
      ? prototype.on
      : function (event, listener) {
          return nativeAdd.call(this, event, callback(event, listener));
        };
  prototype.prependListener = function (event, listener) {
    return nativePrepend.call(this, event, callback(event, listener));
  };
  const remove = function (event, listener) {
    if (typeof listener !== 'function') return nativeRemove.call(this, event, listener);
    const listeners = nativeRaw.call(this, event);
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      const candidate = listeners[index];
      if (
        candidate === listener ||
        candidate.listener === listener ||
        wrapped.get(candidate) === listener
      )
        return nativeRemove.call(this, event, candidate);
    }
    return nativeRemove.call(this, event, listener);
  };
  prototype.removeListener = remove;
  prototype.off = remove;
  prototype.rawListeners = function (event) {
    return nativeRaw.call(this, event).map((listener) => wrapped.get(listener) ?? listener);
  };
}

module.exports = { createHandlerTracker, trackEventListeners };
