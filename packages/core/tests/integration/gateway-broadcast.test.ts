import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

type Packet = { op: number; s?: number; t?: string; d: { session_id?: string } };
const token = 'disrunner.offline.gateway-broadcast-wire-test';
function fixture() {
  const clock = new VirtualClock({ nowMs: 1420070400000 });
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(7),
    snowflakes: new SnowflakeGenerator(clock),
    fakeToken: token,
  });
  const server = new LocalGatewayServer({ gateway });
  return { gateway, server };
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  const packets: Packet[] = [];
  socket.on('message', (data: Buffer) => packets.push(JSON.parse(data.toString()) as Packet));
  const next = async (): Promise<Packet> => {
    if (packets.length === 0) await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
    return packets.shift()!;
  };
  expect((await next()).op).toBe(10);
  return { socket, next };
}

describe('Gateway broadcast transport', () => {
  it('sends broadcast once, preserves legacy dispatch once, and resumes disconnected backlog', async () => {
    const { gateway, server } = fixture();
    const address = await server.start();
    const peer = await connect(address.url);
    let resumed: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      peer.socket.send(JSON.stringify({ op: 2, d: { token, intents: 512 } }));
      const ready = await peer.next();
      const id = ready.d.session_id!;
      expect(gateway.broadcast('MESSAGE_CREATE', { guild_id: 'guild', content: 'hidden' })).toEqual(
        { accepted: 1, filtered: 0, failed: 0, transportFailed: 0 },
      );
      expect(await peer.next()).toMatchObject({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: { content: '' },
      });
      expect(server.dispatch(id, 'A', {})).toBe(true);
      expect(await peer.next()).toEqual({ op: 0, t: 'A', s: 3, d: {} });
      peer.socket.send(JSON.stringify({ op: 1, d: 3 }));
      expect(await peer.next()).toEqual({ op: 11, d: null });
      const closed = once(peer.socket, 'close');
      peer.socket.close();
      await closed;
      await expect.poll(() => gateway.session(id)?.state).toBe('disconnected');
      expect(gateway.broadcast('A', { offline: true })).toEqual({
        accepted: 1,
        filtered: 0,
        failed: 0,
        transportFailed: 0,
      });
      resumed = await connect(address.url);
      resumed.socket.send(JSON.stringify({ op: 6, d: { token, session_id: id, seq: 3 } }));
      expect(await resumed.next()).toEqual({ op: 0, t: 'A', s: 4, d: { offline: true } });
      expect(await resumed.next()).toMatchObject({ t: 'RESUMED', s: 5 });
    } finally {
      peer.socket.terminate();
      resumed?.socket.terminate();
      await server.stop();
    }
  });

  it('unsubscribes on confirmed stop and does not leak subscriptions on failed start', async () => {
    const { gateway, server } = fixture();
    const original = gateway.subscribeBroadcast.bind(gateway);
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(gateway, 'subscribeBroadcast').mockImplementation((listener) => {
      const remove = vi.fn(original(listener));
      unsubscribes.push(remove);
      return remove;
    });
    await server.start();
    await server.stop();
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    gateway.identify({ token, intents: 0 });
    await expect(server.start()).rejects.toThrow('Cannot change the Gateway endpoint');
    expect(unsubscribes).toHaveLength(1);
    expect(server.address).toBeUndefined();
  });
});
