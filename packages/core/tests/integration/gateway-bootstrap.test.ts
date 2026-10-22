import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

// Frozen wire oracles are literals, independent of production opcodes and engine output.
const token = 'disrunner.offline.bootstrap-regression-test';
type Packet = { op: number; d?: unknown; t?: string; s?: number };
type Peer = { socket: WebSocket; packets: Packet[]; cursor: number };
const hello = { op: 10, d: { heartbeat_interval: 41250 } };
const ack = { op: 11, d: null };

async function next(peer: Peer): Promise<Packet> {
  if (peer.cursor === peer.packets.length) {
    await once(peer.socket, 'message', { signal: AbortSignal.timeout(2000) });
  }
  const packet = peer.packets[peer.cursor++];
  if (packet === undefined) throw new Error('Expected gateway packet.');
  return packet;
}
function send(peer: Peer, packet: Packet): void {
  peer.socket.send(JSON.stringify(packet));
}
function closed(peer: Peer) {
  return once(peer.socket, 'close', { signal: AbortSignal.timeout(2000) });
}
async function fixture(identifyTimeoutMs = 1000) {
  const clock = new VirtualClock({ nowMs: 1420070400000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(17),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
  });
  const server = new LocalGatewayServer({ gateway, maxConnections: 1, identifyTimeoutMs });
  const address = await server.start();
  const peers: Peer[] = [];
  async function connect() {
    const socket = new WebSocket(address.url);
    const peer: Peer = { socket, packets: [], cursor: 0 };
    peers.push(peer);
    socket.on('error', () => undefined);
    socket.on('message', (data: Buffer) =>
      peer.packets.push(JSON.parse(data.toString()) as Packet),
    );
    expect(await next(peer)).toEqual(hello);
    return peer;
  }
  async function identify(peer: Peer) {
    send(peer, { op: 2, d: { token, intents: 0 } });
    const ready = await next(peer);
    expect(ready).toMatchObject({ op: 0, t: 'READY', s: 1 });
    expect(gateway.sessions()).toHaveLength(1);
    return (ready.d as { session_id: string }).session_id;
  }
  async function cleanup() {
    for (const peer of peers) peer.socket.terminate();
    await server.stop();
  }
  return { gateway, server, connect, identify, cleanup };
}

describe('Gateway pre-authentication heartbeat bootstrap', () => {
  it.each([null, 0, Number.MAX_SAFE_INTEGER])(
    'ACKs %s without allocating before IDENTIFY',
    async (sequence) => {
      const f = await fixture();
      try {
        const peer = await f.connect();
        send(peer, { op: 1, d: sequence });
        expect(await next(peer)).toEqual(ack);
        expect(peer.packets).toEqual([hello, ack]);
        expect(f.gateway.sessions()).toEqual([]);
        await f.identify(peer);
        send(peer, { op: 1, d: 1 });
        expect(await next(peer)).toEqual(ack);
      } finally {
        await f.cleanup();
      }
    },
  );

  it('ACKs a prior sequence without touching the disconnected session before RESUME replay', async () => {
    const f = await fixture();
    try {
      const original = await f.connect();
      const sessionId = await f.identify(original);
      const disconnected = closed(original);
      original.socket.close();
      await disconnected;
      await expect.poll(() => f.gateway.session(sessionId)?.state).toBe('disconnected');
      expect(f.server.dispatch(sessionId, 'A', { value: 'a' })).toBe(false);
      const before = f.gateway.sessions();
      const replacement = await f.connect();
      send(replacement, { op: 1, d: 1 });
      expect(await next(replacement)).toEqual(ack);
      expect(f.gateway.sessions()).toEqual(before);
      expect(replacement.packets).toEqual([hello, ack]);
      send(replacement, { op: 6, d: { token, session_id: sessionId, seq: 1 } });
      expect(await next(replacement)).toEqual({ op: 0, t: 'A', s: 2, d: { value: 'a' } });
      expect(await next(replacement)).toEqual({ op: 0, t: 'RESUMED', s: 3, d: { _trace: [] } });
      send(replacement, { op: 1, d: 3 });
      expect(await next(replacement)).toEqual(ack);
      expect(replacement.cursor).toBe(replacement.packets.length);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps the original auth deadline despite repeated heartbeats and releases capacity', async () => {
    const f = await fixture(150);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const peer = await f.connect();
      const disconnected = closed(peer);
      send(peer, { op: 1, d: null });
      expect(await next(peer)).toEqual(ack);
      await vi.advanceTimersByTimeAsync(100);
      send(peer, { op: 1, d: 99 });
      expect(await next(peer)).toEqual(ack);
      await vi.advanceTimersByTimeAsync(49);
      expect(peer.socket.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      expect((await disconnected)[0]).toBe(4003);
      expect(peer.packets).toEqual([hello, ack, ack]);
      expect(f.gateway.sessions()).toEqual([]);
      await f.identify(await f.connect());
    } finally {
      await f.cleanup();
      vi.useRealTimers();
    }
  });

  it('does not authenticate an ACKed client with a wrong token', async () => {
    const f = await fixture();
    try {
      const peer = await f.connect();
      send(peer, { op: 1, d: null });
      expect(await next(peer)).toEqual(ack);
      const disconnected = closed(peer);
      send(peer, { op: 2, d: { token: 'disrunner.offline.wrong', intents: 0 } });
      expect((await disconnected)[0]).toBe(4004);
      expect(peer.packets).toEqual([hello, ack]);
      expect(f.gateway.sessions()).toEqual([]);
      await f.identify(await f.connect());
    } finally {
      await f.cleanup();
    }
  });

  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', {}, [], true])(
    'rejects malformed preauth sequence %j without allocation',
    async (sequence) => {
      const f = await fixture();
      try {
        const peer = await f.connect();
        const disconnected = closed(peer);
        send(peer, { op: 1, d: sequence });
        expect((await disconnected)[0]).toBe(4002);
        expect(peer.packets).toEqual([hello]);
        expect(f.gateway.sessions()).toEqual([]);
        await f.identify(await f.connect());
      } finally {
        await f.cleanup();
      }
    },
  );

  it('retains postauth sequence validation and heartbeat fault injection', async () => {
    const f = await fixture();
    try {
      const peer = await f.connect();
      await f.identify(peer);
      const disconnected = closed(peer);
      send(peer, { op: 1, d: 2 });
      expect((await disconnected)[0]).toBe(4007);
      const replacement = await f.connect();
      f.gateway.setHeartbeatAckEnabled(false);
      send(replacement, { op: 1, d: null });
      expect(await next(replacement)).toEqual(ack); // Bootstrap ACK is not session fault injection.
      send(replacement, { op: 2, d: { token, intents: 0 } });
      expect(await next(replacement)).toMatchObject({ op: 0, t: 'READY', s: 1 });
      const timedOut = closed(replacement);
      send(replacement, { op: 1, d: 1 });
      send(replacement, { op: 1, d: 1 });
      expect((await timedOut)[0]).toBe(4009);
      expect(replacement.packets.map((packet) => packet.op)).toEqual([10, 11, 0]);
    } finally {
      await f.cleanup();
    }
  });
});
