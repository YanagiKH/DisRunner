import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator, type GatewayEmulatorOptions } from '../../src/gateway.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

const token = 'disrunner.offline.gateway-resume-unit-test';
function harness(options: Partial<GatewayEmulatorOptions> = {}) {
  const clock = new VirtualClock({ nowMs: 1420070400000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(7),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
    ...options,
  });
  return { clock, gateway };
}

describe('Gateway reconnect integrity', () => {
  it('binds only offline endpoints, with immutable live and resumable endpoint identity', () => {
    const { gateway, clock } = harness({ sessionTtlMs: 10 });
    for (const endpoint of [
      'wss://discord.com/gateway',
      'ws://example.com/gateway',
      'http://127.0.0.1/gateway',
      'ws://user:password@127.0.0.1/gateway',
    ]) {
      expect(() => gateway.bindTransportEndpoint(endpoint)).toThrow();
    }
    gateway.bindTransportEndpoint('ws://127.0.0.1:12345/gateway');
    const first = gateway.identify({ token, intents: 0 });
    expect(first.resumeGatewayUrl).toBe('ws://127.0.0.1:12345/gateway');
    gateway.bindTransportEndpoint(first.resumeGatewayUrl);
    expect(() => gateway.bindTransportEndpoint('ws://127.0.0.1:12346/gateway')).toThrow();
    gateway.disconnect(first.sessionId);
    expect(() => gateway.bindTransportEndpoint('ws://127.0.0.1:12346/gateway')).toThrow();
    expect(gateway.replay(first.sessionId, 0)).toEqual([first.ready]);
    clock.advanceBy(10);
    gateway.bindTransportEndpoint('ws://127.0.0.1:12346/gateway');
    const second = gateway.identify({ token, intents: 0 });
    expect(second.resumeGatewayUrl).toBe('ws://127.0.0.1:12346/gateway');
    gateway.invalidate(second.sessionId, false);
    gateway.bindTransportEndpoint('ws://127.0.0.1:12347/gateway');
  });

  it('buffers disconnected dispatches with isolated input, output, and replay copies', () => {
    const { gateway } = harness();
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    const data = { nested: { value: 'A' } };
    const packet = gateway.dispatch(sessionId, 'A', data)!;
    data.nested.value = 'mutated input';
    (packet.d as typeof data).nested.value = 'mutated output';
    gateway.dispatch(sessionId, 'B', { value: 'B' });
    const replay = gateway.replay(sessionId, 1);
    (replay[0]!.d as typeof data).nested.value = 'mutated replay';
    const result = gateway.resume(sessionId, token, 1);
    expect(result.replayed).toEqual([
      { op: 0, t: 'A', s: 2, d: { nested: { value: 'A' } } },
      { op: 0, t: 'B', s: 3, d: { value: 'B' } },
    ]);
    expect(result.resumed).toEqual({ op: 0, t: 'RESUMED', s: 4, d: { _trace: [] } });
    (result.replayed[0]!.d as typeof data).nested.value = 'mutated resume';
    expect(gateway.replay(sessionId, 1)[0]?.d).toEqual({ nested: { value: 'A' } });
  });

  it('applies identical disconnected intent/content filters without sequence cost', () => {
    const { gateway } = harness();
    const { sessionId } = gateway.identify({ token, intents: 512 });
    gateway.disconnect(sessionId);
    expect(gateway.dispatch(sessionId, 'GUILD_MEMBER_ADD', { guild_id: '1' })).toBeUndefined();
    expect(gateway.session(sessionId)?.sequence).toBe(1);
    expect(
      gateway.dispatch(sessionId, 'MESSAGE_CREATE', {
        guild_id: '1',
        content: 'hidden',
        embeds: [{ title: 'hidden' }],
        attachments: [],
        components: [],
        mentions: [],
      }),
    ).toMatchObject({ s: 2, d: { content: '', embeds: [], attachments: [], components: [] } });
  });

  it.each(['expired', 'invalid'] as const)('rejects %s dispatch', (state) => {
    const { gateway, clock } = harness({ sessionTtlMs: 10 });
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    if (state === 'expired') clock.advanceBy(10);
    else gateway.invalidate(sessionId, false);
    expect(() => gateway.dispatch(sessionId, 'A', {})).toThrow(
      expect.objectContaining({ closeCode: 4009 }),
    );
    expect(gateway.resume(sessionId, token, 1)).toEqual({
      accepted: false,
      replayed: [],
      invalidSession: { op: 9, d: false },
    });
  });

  it('does not extend disconnected TTL while buffering', () => {
    const { gateway, clock } = harness({ sessionTtlMs: 10 });
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    clock.advanceBy(9);
    expect(gateway.dispatch(sessionId, 'A', {})).toMatchObject({ s: 2 });
    clock.advanceBy(1);
    expect(() => gateway.dispatch(sessionId, 'B', {})).toThrow(
      expect.objectContaining({ closeCode: 4009 }),
    );
    expect(gateway.resume(sessionId, token, 1).accepted).toBe(false);
  });

  it('evicts disconnected backlog by per-session bytes without weakening gap rejection', () => {
    const { gateway } = harness({ maxDispatchBytes: 512, maxReplayBytesPerSession: 512 });
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    gateway.dispatch(sessionId, 'A', 'a'.repeat(240));
    gateway.dispatch(sessionId, 'B', 'b'.repeat(240));
    expect(gateway.replay(sessionId, 0)).toEqual([{ op: 0, t: 'B', s: 3, d: 'b'.repeat(240) }]);
    expect(gateway.resume(sessionId, token, 1)).toEqual({
      accepted: false,
      replayed: [],
      invalidSession: { op: 9, d: false },
    });
  });

  it('keeps oversized disconnected dispatch transactional', () => {
    const { gateway } = harness({ maxDispatchBytes: 512 });
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    const before = gateway.replay(sessionId, 0);
    expect(() => gateway.dispatch(sessionId, 'A', { value: 'x'.repeat(600) })).toThrow(
      expect.objectContaining({ closeCode: 4002 }),
    );
    expect(gateway.replay(sessionId, 0)).toEqual(before);
    expect(gateway.session(sessionId)?.sequence).toBe(1);
  });

  it('keeps global-budget dispatch and RESUMED failures transactional', () => {
    const { gateway } = harness({ maxDispatchBytes: 512, maxTotalReplayBytes: 512 });
    const { sessionId } = gateway.identify({ token, intents: 0 });
    gateway.disconnect(sessionId);
    const readyBytes = Buffer.byteLength(JSON.stringify(gateway.replay(sessionId, 0)[0]));
    const overhead = Buffer.byteLength(JSON.stringify({ op: 0, t: 'A', s: 2, d: '' }));
    gateway.dispatch(sessionId, 'A', 'x'.repeat(512 - readyBytes - overhead));
    const before = gateway.replay(sessionId, 0);
    expect(() => gateway.dispatch(sessionId, 'B', {})).toThrow(
      expect.objectContaining({ closeCode: 4008 }),
    );
    expect(() => gateway.resume(sessionId, token, 1)).toThrow(
      expect.objectContaining({ closeCode: 4008 }),
    );
    expect(gateway.replay(sessionId, 0)).toEqual(before);
    expect(gateway.session(sessionId)).toMatchObject({ sequence: 2, state: 'disconnected' });
  });
});
