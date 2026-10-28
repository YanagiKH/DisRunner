import { describe, expect, it } from 'vitest';
import {
  FaultPolicy,
  FaultPolicyResetError,
  MAX_FAULT_EVENTS,
  parseFaultPlans,
} from '../../src/fault-policy.js';

describe('session fault policy', () => {
  it('consumes only matching requests in deterministic declaration order', () => {
    const policy = new FaultPolicy([
      {
        id: 'retry',
        kind: 'http-status',
        status: 429,
        method: 'POST',
        route: '/channels/:channel/messages',
        count: 2,
      },
      {
        id: 'unavailable',
        kind: 'http-status',
        status: 503,
        method: 'POST',
        route: '/channels/*/messages',
      },
    ]);
    expect(policy.consumeHttp({ method: 'GET', route: '/channels/42/messages' })).toBeNull();
    expect(policy.consumeHttp({ method: 'POST', route: '/channels/42/messages/1' })).toBeNull();
    expect(policy.consumeHttp({ method: 'POST', route: '/channels/42/messages' })).toEqual({
      id: 'retry',
      activation: 1,
      kind: 'http-status',
      status: 429,
      retryAfterMs: 1_000,
    });
    expect(policy.consumeHttp({ method: 'POST', route: '/channels/84/messages' })?.id).toBe(
      'retry',
    );
    expect(policy.consumeHttp({ method: 'POST', route: '/channels/84/messages' })).toMatchObject({
      id: 'unavailable',
      status: 503,
    });
    expect(policy.consumeHttp({ method: 'POST', route: '/channels/84/messages' })).toBeNull();
    expect(policy.plans().map(({ remaining }) => remaining)).toEqual([0, 0]);
  });

  it('keeps HTTP and Gateway actions distinct and targets one event at a time', () => {
    const policy = new FaultPolicy([
      { id: 'disconnect', kind: 'disconnect', event: 'MESSAGE_CREATE' },
      { id: 'duplicate', kind: 'duplicate', event: 'MESSAGE_CREATE' },
      { id: 'server', kind: 'http-status', status: 500 },
    ]);
    expect(policy.consumeGateway('MESSAGE_DELETE')).toBeNull();
    expect(policy.consumeGateway('MESSAGE_CREATE')).toEqual({
      id: 'disconnect',
      activation: 1,
      kind: 'disconnect',
      closeCode: 1012,
    });
    expect(policy.consumeGateway('MESSAGE_CREATE')).toEqual({
      id: 'duplicate',
      activation: 2,
      kind: 'duplicate',
      copies: 2,
    });
    expect(policy.consumeGateway('MESSAGE_CREATE')).toBeNull();
    expect(policy.consumeHttp({ method: 'PATCH', route: '/messages/5' })).toMatchObject({
      id: 'server',
      status: 500,
    });
  });

  it('has isolated counters, restores a repeatable plan, and clears all effects at teardown', () => {
    const plans = [{ id: 'once', kind: 'duplicate', count: 1 }];
    const first = new FaultPolicy(plans);
    const second = new FaultPolicy(plans);
    expect(first.consumeGateway('MESSAGE_CREATE')?.id).toBe('once');
    expect(first.consumeGateway('MESSAGE_CREATE')).toBeNull();
    expect(second.consumeGateway('MESSAGE_CREATE')?.id).toBe('once');
    first.reset();
    expect(first.evidence()).toEqual({ events: [], droppedEvents: 0, complete: true });
    expect(first.consumeGateway('MESSAGE_CREATE')?.activation).toBe(1);
    first.clear();
    expect(first.plans()).toEqual([]);
    expect(first.consumeGateway('MESSAGE_CREATE')).toBeNull();
    first.reset();
    expect(first.consumeGateway('MESSAGE_CREATE')).toBeNull();
  });

  it('waits for a real bounded delay before handing the response back to its transport', async () => {
    const policy = new FaultPolicy([{ id: 'latency', kind: 'delay', delayMs: 20 }]);
    const startedAt = performance.now();
    const effect = await policy.applyHttp({ method: 'GET', route: '/gateway' });
    expect(effect).toMatchObject({ kind: 'delay', delayMs: 20 });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(10);
    expect(policy.evidence().events.map(({ phase }) => phase)).toEqual(['selected', 'ready']);
  });

  it('does not consume plans when an HTTP operation was already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by user');
    controller.abort(reason);
    const policy = new FaultPolicy([{ id: 'later', kind: 'timeout', delayMs: 30_000 }]);
    await expect(
      policy.applyHttp({ method: 'GET', route: '/gateway' }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(policy.plans()[0]?.remaining).toBe(1);
    expect(policy.evidence().events).toEqual([]);
  });

  it('cancels pending waits with the caller and records the consumed occurrence', async () => {
    const controller = new AbortController();
    const policy = new FaultPolicy([{ id: 'timeout', kind: 'timeout', delayMs: 30_000 }]);
    const pending = policy.applyHttp(
      { method: 'GET', route: '/gateway' },
      { signal: controller.signal },
    );
    const reason = new Error('user stopped the run');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(policy.plans()[0]?.remaining).toBe(0);
    expect(policy.evidence().events.map(({ phase }) => phase)).toEqual(['selected', 'cancelled']);
  });

  it.each(['reset', 'clear', 'set'] as const)(
    'cancels old waits when %s starts a new fault scope',
    async (operation) => {
      const policy = new FaultPolicy([{ id: 'old', kind: 'delay', delayMs: 30_000 }]);
      const pending = policy.applyHttp({ method: 'GET', route: '/gateway' });
      if (operation === 'set') policy.set([{ id: 'new', kind: 'duplicate' }]);
      else policy[operation]();
      await expect(pending).rejects.toBeInstanceOf(FaultPolicyResetError);
      expect(policy.evidence().events).toEqual([]);
      expect(policy.plans().map(({ id }) => id)).toEqual(
        operation === 'clear' ? [] : [operation === 'set' ? 'new' : 'old'],
      );
    },
  );

  it('validates replacement plans before altering existing configuration or pending work', async () => {
    const controller = new AbortController();
    const policy = new FaultPolicy([{ id: 'original', kind: 'delay', delayMs: 30_000 }]);
    const pending = policy.applyHttp(
      { method: 'GET', route: '/gateway' },
      { signal: controller.signal },
    );
    expect(() => policy.set([{ id: 'bad', kind: 'http-status', status: 200 }])).toThrow();
    expect(policy.plans()[0]?.id).toBe('original');
    expect(policy.evidence().events[0]?.phase).toBe('selected');
    const reason = new Error('done');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('bounds fault evidence, declares truncation and never records request paths or tokens', () => {
    const policy = new FaultPolicy(
      Array.from({ length: 11 }, (_, index) => ({
        id: `plan${index}`,
        kind: 'http-status',
        status: 502,
        count: 100,
        route: '/interactions/*/*/callback',
      })),
    );
    for (let index = 0; index < 1_100; index += 1) {
      expect(
        policy.consumeHttp({ method: 'POST', route: '/interactions/1/opaque-test-token/callback' }),
      ).not.toBeNull();
    }
    const evidence = policy.evidence();
    expect(evidence.events).toHaveLength(MAX_FAULT_EVENTS);
    expect(evidence.droppedEvents).toBe(100);
    expect(evidence.complete).toBe(false);
    expect(evidence.events[0]?.sequence).toBe(101);
    expect(JSON.stringify(evidence)).not.toContain('opaque-test-token');
    expect(JSON.stringify(evidence)).not.toContain('/interactions');
  });

  it('copies configuration and prevents mutation through returned projections', () => {
    const source = [{ id: 'plan', kind: 'http-status', status: 429, count: 1 }];
    const policy = new FaultPolicy(source);
    source[0]!.status = 500;
    expect(policy.consumeHttp({ method: 'GET', route: '/gateway' })).toMatchObject({ status: 429 });
    const evidence = policy.evidence();
    Reflect.set(evidence.events[0]!, 'planId', 'changed');
    expect(policy.evidence().events[0]?.planId).toBe('plan');
  });
});

describe('fault plan validation', () => {
  it.each(
    [
      null,
      {},
      Array.from({ length: 101 }, (_, index) => ({ id: `p${index}`, kind: 'duplicate' })),
      [
        { id: 'same', kind: 'duplicate' },
        { id: 'same', kind: 'disconnect' },
      ],
      [{ id: 'missing-kind' }],
      [{ id: 'bad', kind: 'latency', delayMs: 10 }],
      [{ id: 'bad', kind: 'duplicate', count: 0 }],
      [{ id: 'bad', kind: 'duplicate', count: 101 }],
      [{ id: 'bad', kind: 'duplicate', count: null }],
      [{ id: 'bad', kind: 'duplicate', count: 1.5 }],
      [{ id: 'bad', kind: 'delay', delayMs: 30_001 }],
      [{ id: 'bad', kind: 'delay', delayMs: -1 }],
      [{ id: 'bad', kind: 'delay' }],
      [{ id: 'bad', kind: 'timeout', delayMs: 0 }],
      [{ id: 'bad', kind: 'http-status', status: 200 }],
      [{ id: 'bad', kind: 'http-status', status: 504 }],
      [{ id: 'bad', kind: 'http-status', status: 503, method: 'get' }],
      [{ id: 'bad', kind: 'disconnect', event: 'messageCreate' }],
      [{ id: 'bad', kind: 'disconnect', route: '/gateway' }],
      [{ id: 'bad', kind: 'http-status', status: 500, event: 'READY' }],
      [{ id: 'bad', kind: 'duplicate', unknown: true }],
      [{ id: 'bad', kind: 'delay', delayMs: 1, route: 'https://discord.com' }],
      [{ id: 'bad', kind: 'delay', delayMs: 1, route: '/channels/**' }],
      [{ id: 'bad', kind: 'delay', delayMs: 1, route: '/channels/:id?' }],
      [{ id: 'bad', kind: 'delay', delayMs: 1, route: '/channels/../messages' }],
    ].map((input) => [input]),
  )('rejects invalid or inapplicable configuration %#', (input) => {
    expect(() => parseFaultPlans(input)).toThrow(TypeError);
  });

  it('rejects accessors without evaluating them', () => {
    let evaluated = false;
    const plan = { id: 'test', kind: 'duplicate' };
    Object.defineProperty(plan, 'count', {
      enumerable: true,
      get() {
        evaluated = true;
        return 1;
      },
    });
    expect(() => parseFaultPlans([plan])).toThrow(TypeError);
    const array = [plan];
    Object.defineProperty(array, '0', {
      enumerable: true,
      get() {
        evaluated = true;
        return plan;
      },
    });
    expect(() => parseFaultPlans(array)).toThrow(TypeError);
    expect(evaluated).toBe(false);
  });

  it('accepts explicit boundary values and supported status codes', () => {
    expect(
      parseFaultPlans([
        { id: 'delay', kind: 'delay', delayMs: 0 },
        { id: 'timeout', kind: 'timeout', delayMs: 30_000, count: 100 },
      ]),
    ).toHaveLength(2);
    for (const status of [429, 500, 502, 503]) {
      expect(parseFaultPlans([{ id: 'status', kind: 'http-status', status }])[0]?.status).toBe(
        status,
      );
    }
  });
});
