import { describe, expect, it, vi } from 'vitest';
import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator, type GatewayEmulatorOptions } from '../../src/gateway.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

const token = 'disrunner.offline.gateway-broadcast-unit-test';
function fixture(options: Partial<GatewayEmulatorOptions> = {}) {
  const clock = new VirtualClock({ nowMs: 1420070400000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(7),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
    botUserId: 'bot',
    ...options,
  });
  return { gateway, clock };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('bounded Gateway broadcast', () => {
  it('reports invalid input as failure even without recipients', () => {
    const { gateway } = fixture();
    expect(gateway.broadcast('MESSAGE_CREATE', { invalid: 1n })).toEqual({
      accepted: 0,
      filtered: 0,
      failed: 1,
      transportFailed: 0,
    });
  });
  it('rejects combined budget exhaustion without sequence/history mutation', () => {
    const probe = fixture().gateway;
    const ready = probe.identify({ token, intents: 0 }).ready;
    const event = { text: 'x'.repeat(100) };
    const packetBytes = bytes({ op: 0, t: 'A', s: 2, d: event });
    const { gateway } = fixture({
      maxDispatchBytes: 512,
      maxTotalReplayBytes: bytes(ready) * 2 + packetBytes,
    });
    const a = gateway.identify({ token, intents: 0 });
    const b = gateway.identify({ token, intents: 0 });
    expect(() => gateway.preflightBroadcast('A', event)).toThrow('capacity');
    for (const session of [a, b]) {
      expect(gateway.session(session.sessionId)?.sequence).toBe(1);
      expect(gateway.replay(session.sessionId, 0)).toEqual([session.ready]);
    }
    expect(gateway.broadcast('A', event)).toEqual({
      accepted: 1,
      filtered: 0,
      failed: 1,
      transportFailed: 0,
    });
  });

  it('accounts for per-session count evictions and uses the current audience after preflight', () => {
    const ready = fixture().gateway.identify({ token, intents: 0 }).ready;
    const { gateway } = fixture({
      replayLimit: 1,
      maxDispatchBytes: bytes(ready),
      maxTotalReplayBytes: bytes(ready) * 2,
    });
    const a = gateway.identify({ token, intents: 0 });
    gateway.preflightBroadcast('A', { text: 'ok' });
    const b = gateway.identify({ token, intents: 0 });
    gateway.preflightBroadcast('A', { text: 'ok' });
    expect(gateway.broadcast('A', { text: 'ok' }).accepted).toBe(2);
    for (const id of [a.sessionId, b.sessionId]) {
      expect(gateway.replay(id, 0)).toEqual([{ op: 0, t: 'A', s: 2, d: { text: 'ok' } }]);
    }
  });

  it('filters intents, strips content, retains disconnected history, and isolates listeners/input', () => {
    const { gateway } = fixture();
    const a = gateway.identify({ token, intents: 512 });
    const b = gateway.identify({ token, intents: 0 });
    const c = gateway.identify({ token, intents: 512 });
    gateway.disconnect(c.sessionId);
    const input = { guild_id: 'guild', content: 'private', nested: { value: 1 } };
    const observed: unknown[] = [];
    gateway.subscribeBroadcast((_id, packet) => {
      input.nested.value = 99;
      (packet.d as { nested: { value: number } }).nested.value = 77;
      throw new Error('transport failed');
    });
    gateway.subscribeBroadcast((_id, packet) => {
      observed.push(packet.d);
    });
    gateway.preflightBroadcast('MESSAGE_CREATE', input);
    expect(gateway.broadcast('MESSAGE_CREATE', input)).toEqual({
      accepted: 2,
      filtered: 1,
      failed: 0,
      transportFailed: 2,
    });
    expect(observed).toHaveLength(2);
    for (const data of observed) expect(data).toMatchObject({ content: '', nested: { value: 1 } });
    expect(gateway.session(b.sessionId)?.sequence).toBe(1);
    expect(gateway.replay(a.sessionId, 1)).toEqual(gateway.replay(c.sessionId, 1));
    expect(gateway.resume(c.sessionId, token, 1).replayed).toHaveLength(1);
  });

  it('bounds subscriptions, unsubscribe is idempotent, direct dispatch does not publish', () => {
    const { gateway } = fixture();
    const id = gateway.identify({ token, intents: 0 }).sessionId;
    let count = 0;
    const remove = gateway.subscribeBroadcast(() => {
      count += 1;
    });
    gateway.dispatch(id, 'A', {});
    expect(count).toBe(0);
    gateway.broadcast('A', {});
    expect(count).toBe(1);
    remove();
    remove();
    const removers = Array.from({ length: 100 }, () => gateway.subscribeBroadcast(() => undefined));
    expect(() => gateway.subscribeBroadcast(() => undefined)).toThrow('capacity');
    removers[0]!();
    expect(() => gateway.subscribeBroadcast(() => undefined)).not.toThrow();
  });

  it('accounts for byte-budget evictions and continues after an earlier session fails', () => {
    const ready = fixture().gateway.identify({ token, intents: 0 }).ready;
    const { gateway } = fixture({
      maxDispatchBytes: bytes(ready),
      maxReplayBytesPerSession: bytes(ready),
      maxTotalReplayBytes: bytes(ready) * 2,
    });
    const a = gateway.identify({ token, intents: 0 });
    const b = gateway.identify({ token, intents: 0 });
    expect(() => gateway.preflightBroadcast('A', { text: 'ok' })).not.toThrow();
    expect(gateway.broadcast('A', { text: 'ok' }).accepted).toBe(2);
    expect(gateway.replay(a.sessionId, 0)).toHaveLength(1);
    const dispatch = gateway.dispatch.bind(gateway);
    vi.spyOn(gateway, 'dispatch').mockImplementation((id, event, data) => {
      if (id === a.sessionId) throw new Error('injected failure');
      return dispatch(id, event, data);
    });
    expect(gateway.broadcast('B', {})).toEqual({
      accepted: 1,
      filtered: 0,
      failed: 1,
      transportFailed: 0,
    });
    expect(gateway.session(b.sessionId)?.sequence).toBe(3);
  });

  it('does not sweep expired sessions or accept invalid data during preflight', () => {
    const { gateway, clock } = fixture({ sessionTtlMs: 10, maxDispatchBytes: 512 });
    const id = gateway.identify({ token, intents: 0 }).sessionId;
    gateway.disconnect(id);
    clock.advanceBy(10);
    expect(() => gateway.preflightBroadcast('A', { text: 'x'.repeat(1000) })).toThrow('byte limit');
    expect(() => gateway.preflightBroadcast('A', { text: 'ok' })).not.toThrow();
    expect(gateway.broadcast('A', {})).toEqual({
      accepted: 0,
      filtered: 0,
      failed: 0,
      transportFailed: 0,
    });
  });
});
