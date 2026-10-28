import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { FaultPolicy } from '../../src/fault-policy.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

type Packet = { op: number; t?: string; s?: number; d: unknown };
const token = 'disrunner.offline.gateway-fault-test';
const message = {
  id: '9',
  guild_id: '1000',
  channel_id: '2000',
  content: 'Actual event',
  author: { id: '4000' },
};

async function fixture(policy: FaultPolicy) {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(3),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
    botUserId: '4000',
  });
  const server = new LocalGatewayServer({ gateway, faultPolicy: policy });
  const address = await server.start();
  const peers: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(address.url);
    peers.push(socket);
    const packets: Packet[] = [];
    socket.on('message', (data: Buffer) => packets.push(JSON.parse(data.toString()) as Packet));
    socket.on('error', () => undefined);
    await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
    return { socket, packets };
  };
  const identify = async () => {
    const peer = await connect();
    peer.socket.send(JSON.stringify({ op: 2, d: { token, intents: 513 } }));
    await expect.poll(() => peer.packets.length).toBe(2);
    return {
      ...peer,
      sessionId: String((peer.packets[1]!.d as Record<string, unknown>)['session_id']),
    };
  };
  const cleanup = async () => {
    for (const socket of peers) socket.terminate();
    await server.stop();
  };
  return { gateway, server, connect, identify, cleanup };
}

describe('fault effects on the actual Gateway transport', () => {
  it('duplicates one logical fan-out for every live peer with one fault activation', async () => {
    const policy = new FaultPolicy([
      { id: 'repeat-message', kind: 'duplicate', event: 'MESSAGE_CREATE', count: 1 },
    ]);
    const f = await fixture(policy);
    try {
      const a = await f.identify();
      const b = await f.identify();
      expect(f.gateway.broadcast('MESSAGE_CREATE', message)).toMatchObject({
        accepted: 2,
        failed: 0,
      });
      await expect.poll(() => [a.packets.length, b.packets.length]).toEqual([4, 4]);
      for (const peer of [a, b]) {
        expect(peer.packets.slice(2)).toEqual([
          { op: 0, t: 'MESSAGE_CREATE', s: 2, d: message },
          { op: 0, t: 'MESSAGE_CREATE', s: 2, d: message },
        ]);
        expect(f.gateway.replay(peer.sessionId, 1)).toEqual([
          { op: 0, t: 'MESSAGE_CREATE', s: 2, d: message },
        ]);
      }
      expect(policy.evidence().events).toEqual([
        {
          sequence: 1,
          activation: 1,
          planId: 'repeat-message',
          kind: 'duplicate',
          target: 'gateway',
          phase: 'selected',
        },
      ]);
      f.gateway.broadcast('MESSAGE_CREATE', { ...message, id: '10' });
      await expect.poll(() => [a.packets.length, b.packets.length]).toEqual([5, 5]);
      expect(a.packets[4]?.s).toBe(3);
      expect(b.packets[4]?.s).toBe(3);
    } finally {
      await f.cleanup();
    }
  });

  it('disconnects before delivery while retaining the packet for a real RESUME', async () => {
    const policy = new FaultPolicy([
      { id: 'drop-once', kind: 'disconnect', event: 'MESSAGE_CREATE', count: 1 },
    ]);
    const f = await fixture(policy);
    try {
      const original = await f.identify();
      const closed = once(original.socket, 'close', { signal: AbortSignal.timeout(2000) });
      expect(f.server.dispatch(original.sessionId, 'MESSAGE_CREATE', message)).toBe(false);
      expect((await closed)[0]).toBe(1012);
      expect(original.packets).toHaveLength(2);
      expect(f.gateway.session(original.sessionId)?.state).toBe('disconnected');
      const resumed = await f.connect();
      resumed.socket.send(
        JSON.stringify({ op: 6, d: { token, session_id: original.sessionId, seq: 1 } }),
      );
      await expect.poll(() => resumed.packets.length).toBe(3);
      expect(resumed.packets.slice(1)).toEqual([
        { op: 0, t: 'MESSAGE_CREATE', s: 2, d: message },
        { op: 0, t: 'RESUMED', s: 3, d: { _trace: [] } },
      ]);
      policy.set([{ id: 'cleared', kind: 'disconnect', event: 'MESSAGE_CREATE' }]);
      policy.clear();
      expect(
        f.server.dispatch(original.sessionId, 'MESSAGE_CREATE', { ...message, id: '10' }),
      ).toBe(true);
      await expect.poll(() => resumed.packets.length).toBe(4);
      expect(resumed.packets[3]).toEqual({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 4,
        d: { ...message, id: '10' },
      });
      expect(policy.evidence().events).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
