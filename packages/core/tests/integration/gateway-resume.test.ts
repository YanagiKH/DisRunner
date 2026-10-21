import { once } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator, type GatewayEmulatorOptions } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

// Wire expectations are handwritten literals, not production constants or replay output.
const token = 'disrunner.offline.resume-wire-test';
type Packet = { op: number; d: unknown; t?: string; s?: number };
type Peer = { socket: WebSocket; packets: Packet[]; cursor: number };

async function next(peer: Peer): Promise<Packet> {
  if (peer.cursor === peer.packets.length) {
    await once(peer.socket, 'message', { signal: AbortSignal.timeout(2000) });
  }
  const packet = peer.packets[peer.cursor++];
  if (packet === undefined) throw new Error('Expected a gateway packet.');
  return packet;
}

function send(peer: Peer, packet: Packet): void {
  peer.socket.send(JSON.stringify(packet));
}

async function close(peer: Peer): Promise<void> {
  if (peer.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(peer.socket, 'close', { signal: AbortSignal.timeout(2000) });
  peer.socket.close();
  await closed;
}

async function fixture(options: Partial<GatewayEmulatorOptions> = {}) {
  const clock = new VirtualClock({ nowMs: 1420070400000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(17),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
    botUserId: 'bot',
    ...options,
  });
  const server = new LocalGatewayServer({ gateway });
  const peers: Peer[] = [];
  const address = await server.start(0);
  async function connect(url: string): Promise<Peer> {
    const socket = new WebSocket(url);
    const peer: Peer = { socket, packets: [], cursor: 0 };
    peers.push(peer);
    socket.on('error', () => undefined);
    socket.on('message', (data: Buffer) => {
      peer.packets.push(JSON.parse(data.toString()) as Packet);
    });
    expect(await next(peer)).toEqual({ op: 10, d: { heartbeat_interval: 41250 } });
    return peer;
  }
  async function identify(intents = 1) {
    const peer = await connect(address.url);
    send(peer, { op: 2, d: { token, intents } });
    const ready = await next(peer);
    expect(ready).toMatchObject({ op: 0, t: 'READY', s: 1 });
    const data = ready.d as { session_id: string; resume_gateway_url: string };
    expect(typeof data.session_id).toBe('string');
    expect(data.resume_gateway_url).toBe(address.url);
    expect(new URL(data.resume_gateway_url).port).toBe(String(address.port));
    expect(address.port).toBeGreaterThan(0);
    return { peer, sessionId: data.session_id, resumeUrl: data.resume_gateway_url };
  }
  async function disconnect(peer: Peer, sessionId: string) {
    await close(peer);
    await expect.poll(() => gateway.session(sessionId)?.state).toBe('disconnected');
  }
  async function cleanup() {
    for (const peer of peers) {
      if (peer.socket.readyState !== WebSocket.CLOSED) peer.socket.terminate();
    }
    await server.stop();
    expect(server.address).toBeUndefined();
  }
  return { clock, gateway, server, connect, identify, disconnect, cleanup };
}

function resume(peer: Peer, sessionId: string, seq: number, credential = token): void {
  send(peer, { op: 6, d: { token: credential, session_id: sessionId, seq } });
}

async function barrier(peer: Peer, seq: number): Promise<void> {
  send(peer, { op: 1, d: seq });
  expect(await next(peer)).toEqual({ op: 11, d: null });
  expect(peer.cursor).toBe(peer.packets.length);
}

describe('Gateway resume over real loopback WebSockets', () => {
  it('closes the listener on endpoint refusal and permits a subsequent start', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (address === null || typeof address === 'string') throw new Error('Missing reserved port.');
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const clock = new VirtualClock({ nowMs: 1420070400000 });
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(19),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
    });
    const original = gateway.identify({ token, intents: 0 });
    const server = new LocalGatewayServer({ gateway });
    try {
      await expect(server.start(address.port)).rejects.toThrow(
        'Cannot change the Gateway endpoint',
      );
      expect(server.address).toBeUndefined();
      expect(gateway.session(original.sessionId)?.state).toBe('ready');
      expect(gateway.replay(original.sessionId, 0)).toEqual([original.ready]);
      gateway.invalidate(original.sessionId, false);
      const bound = await server.start(address.port);
      expect(bound.port).toBe(address.port);
      expect(gateway.identify({ token, intents: 0 }).resumeGatewayUrl).toBe(bound.url);
    } finally {
      await server.stop();
    }
  });

  it('advertises the bound endpoint and replays disconnected A, B exactly once before RESUMED', async () => {
    const f = await fixture();
    try {
      const original = await f.identify();
      await f.disconnect(original.peer, original.sessionId);
      expect(f.server.dispatch(original.sessionId, 'A', { value: 'a' })).toBe(false);
      expect(f.server.dispatch(original.sessionId, 'B', { value: 'b' })).toBe(false);
      const replacement = await f.connect(original.resumeUrl);
      resume(replacement, original.sessionId, 1);
      expect(await next(replacement)).toEqual({ op: 0, t: 'A', s: 2, d: { value: 'a' } });
      expect(await next(replacement)).toEqual({ op: 0, t: 'B', s: 3, d: { value: 'b' } });
      expect(await next(replacement)).toEqual({ op: 0, t: 'RESUMED', s: 4, d: { _trace: [] } });
      await barrier(replacement, 4);
      expect(replacement.packets.slice(1)).toEqual([
        { op: 0, t: 'A', s: 2, d: { value: 'a' } },
        { op: 0, t: 'B', s: 3, d: { value: 'b' } },
        { op: 0, t: 'RESUMED', s: 4, d: { _trace: [] } },
        { op: 11, d: null },
      ]);
      expect(f.server.dispatch(original.sessionId, 'C', { value: 'c' })).toBe(true);
      expect(await next(replacement)).toEqual({ op: 0, t: 'C', s: 5, d: { value: 'c' } });
      await barrier(replacement, 5);
    } finally {
      await f.cleanup();
    }
  });

  it('filters disconnected events without sequence cost and replays only stripped message content', async () => {
    const f = await fixture();
    try {
      const original = await f.identify(512);
      await f.disconnect(original.peer, original.sessionId);
      expect(f.server.dispatch(original.sessionId, 'GUILD_MEMBER_ADD', { guild_id: 'g' })).toBe(
        false,
      );
      const message = {
        id: 'message',
        guild_id: 'g',
        channel_id: 'c',
        author: { id: 'other' },
        mentions: [],
        content: 'private content',
        embeds: [{ title: 'private embed' }],
        attachments: [{ id: 'attachment' }],
        components: [{ type: 1 }],
        poll: { question: 'private' },
      };
      expect(f.server.dispatch(original.sessionId, 'MESSAGE_CREATE', message)).toBe(false);
      const replacement = await f.connect(original.resumeUrl);
      resume(replacement, original.sessionId, 1);
      expect(await next(replacement)).toEqual({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: {
          id: 'message',
          guild_id: 'g',
          channel_id: 'c',
          author: { id: 'other' },
          mentions: [],
          content: '',
          embeds: [],
          attachments: [],
          components: [],
          poll: null,
        },
      });
      expect(await next(replacement)).toEqual({ op: 0, t: 'RESUMED', s: 3, d: { _trace: [] } });
      await barrier(replacement, 3);
      expect(message.content).toBe('private content');
      expect(message.embeds).toEqual([{ title: 'private embed' }]);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'expired',
    'invalidated',
    'unknown',
    'wrong token',
    'future sequence',
    'replay gap',
  ] as const)('rejects %s atomically without a partial replay', async (reason) => {
    const f = await fixture({ sessionTtlMs: 100, replayLimit: reason === 'replay gap' ? 1 : 10 });
    try {
      const original = await f.identify();
      await f.disconnect(original.peer, original.sessionId);
      expect(f.server.dispatch(original.sessionId, 'A', { value: 'a' })).toBe(false);
      expect(f.server.dispatch(original.sessionId, 'B', { value: 'b' })).toBe(false);
      if (reason === 'expired') f.clock.advanceBy(100);
      if (reason === 'invalidated') f.gateway.invalidate(original.sessionId, false);
      const replacement = await f.connect(original.resumeUrl);
      resume(
        replacement,
        reason === 'unknown' ? 'session_does_not_exist' : original.sessionId,
        reason === 'future sequence' ? 4 : 1,
        reason === 'wrong token' ? 'disrunner.offline.wrong-wire-token' : token,
      );
      expect(await next(replacement)).toEqual({ op: 9, d: false });
      const closed = once(replacement.socket, 'close', { signal: AbortSignal.timeout(2000) });
      send(replacement, { op: 1, d: null });
      const [code] = (await closed) as unknown[];
      expect(code).toBe(4003);
      expect(replacement.packets).toEqual([
        { op: 10, d: { heartbeat_interval: 41250 } },
        { op: 9, d: false },
      ]);
      if (reason === 'wrong token' || reason === 'future sequence') {
        const valid = await f.connect(original.resumeUrl);
        resume(valid, original.sessionId, 1);
        expect(await next(valid)).toEqual({ op: 0, t: 'A', s: 2, d: { value: 'a' } });
        expect(await next(valid)).toEqual({ op: 0, t: 'B', s: 3, d: { value: 'b' } });
        expect(await next(valid)).toEqual({ op: 0, t: 'RESUMED', s: 4, d: { _trace: [] } });
        await barrier(valid, 4);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('rejects duplicate ownership and keeps the replacement connected after old clients close', async () => {
    const f = await fixture();
    try {
      const original = await f.identify();
      const contender = await f.connect(original.resumeUrl);
      const rejected = once(contender.socket, 'close', { signal: AbortSignal.timeout(2000) });
      resume(contender, original.sessionId, 1);
      const [code] = (await rejected) as unknown[];
      expect(code).toBe(4005);
      expect(contender.packets).toEqual([{ op: 10, d: { heartbeat_interval: 41250 } }]);
      await barrier(original.peer, 1);
      expect(f.server.dispatch(original.sessionId, 'OWNER', { value: true })).toBe(true);
      expect(await next(original.peer)).toEqual({ op: 0, t: 'OWNER', s: 2, d: { value: true } });
      await f.disconnect(original.peer, original.sessionId);
      const replacement = await f.connect(original.resumeUrl);
      resume(replacement, original.sessionId, 2);
      expect(await next(replacement)).toEqual({ op: 0, t: 'RESUMED', s: 3, d: { _trace: [] } });
      // Public transport refuses takeover until the old owner closes; do not inject private callbacks.
      original.peer.socket.close();
      contender.socket.close();
      await barrier(replacement, 3);
      expect(f.server.dispatch(original.sessionId, 'REPLACEMENT', { value: true })).toBe(true);
      expect(await next(replacement)).toEqual({
        op: 0,
        t: 'REPLACEMENT',
        s: 4,
        d: { value: true },
      });
      await barrier(replacement, 4);
      expect(f.gateway.session(original.sessionId)?.state).toBe('ready');
    } finally {
      await f.cleanup();
    }
  });
});
