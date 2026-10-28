import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator, type GatewayEmulatorOptions } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';
import { VirtualState } from '../../src/state.js';

const token = 'disrunner.offline.guild-bootstrap-test';
type Packet = { op: number; s?: number; t?: string; d: Record<string, unknown> };

function fixture(options: Partial<GatewayEmulatorOptions> = {}) {
  const clock = new VirtualClock({ nowMs: 1_420_070_400_000 });
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: '1000', name: 'Fixture Guild', owner_id: '3000' },
    { resourceType: 'role', id: '1000', guild_id: '1000', name: '@everyone', permissions: '68608' },
    { resourceType: 'role', id: '1100', guild_id: '1000', name: 'Reviewer', permissions: '8' },
    { resourceType: 'channel', id: '2000', guild_id: '1000', type: 0, name: 'general' },
    { resourceType: 'user', id: '3000', username: 'Alice' },
    { resourceType: 'member', id: '3000', guild_id: '1000', roles: ['1100'] },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(1),
    snowflakes,
    fakeToken: token,
    botUserId: '4000',
    applicationId: '5000',
    ...options,
    bootstrap: {
      state,
      user: { id: '4000', username: 'Fixture Bot', discriminator: '0', avatar: null, bot: true },
    },
  });
  return { gateway, state };
}

async function connect(server: LocalGatewayServer) {
  const address = await server.start();
  const socket = new WebSocket(address.url);
  const packets: Packet[] = [];
  socket.on('message', (data: Buffer) => packets.push(JSON.parse(data.toString()) as Packet));
  socket.on('error', () => undefined);
  await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  return { socket, packets };
}

describe('live Gateway fixture bootstrap', () => {
  it('populates READY and GUILD_CREATE caches from the same current state', async () => {
    const { gateway, state } = fixture();
    state.update('channel', '2000', { name: 'renamed-before-login' });
    const server = new LocalGatewayServer({ gateway });
    try {
      const { socket, packets } = await connect(server);
      socket.send(JSON.stringify({ op: 2, d: { token, intents: 1 } }));
      await expect.poll(() => packets.length).toBe(3);
      const ready = packets[1]!;
      expect(ready).toMatchObject({
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          user: {
            id: '4000',
            username: 'Fixture Bot',
            discriminator: '0',
            avatar: null,
            bot: true,
          },
          application: { id: '5000', flags: 0 },
          guilds: [{ id: '1000', unavailable: true }],
        },
      });
      const created = packets[2]!;
      expect(created).toMatchObject({
        op: 0,
        s: 2,
        t: 'GUILD_CREATE',
        d: {
          id: '1000',
          name: 'Fixture Guild',
          owner_id: '3000',
          unavailable: false,
          roles: [
            { id: '1000', name: '@everyone', permissions: '68608' },
            { id: '1100', name: 'Reviewer', permissions: '8' },
          ],
          channels: [{ id: '2000', guild_id: '1000', type: 0, name: 'renamed-before-login' }],
          members: [
            { user: { id: '3000', username: 'Alice' }, roles: ['1100'] },
            { user: { id: '4000', username: 'Fixture Bot', bot: true }, roles: [] },
          ],
          emojis: [],
          voice_states: [],
          presences: [],
        },
      });
      expect(gateway.replay(String(ready.d['session_id']), 1)).toEqual([created]);
      socket.send(JSON.stringify({ op: 1, d: 1 }));
      await expect.poll(() => packets.length).toBe(4);
      expect(packets[3]).toEqual({ op: 11, d: null });
      expect(state.get('channel', '2000')).not.toHaveProperty('permission_overwrites');
      expect(state.list('member')).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('omits fixture guilds and their payload when GUILDS was not requested', async () => {
    const { gateway } = fixture();
    const server = new LocalGatewayServer({ gateway });
    try {
      const { socket, packets } = await connect(server);
      socket.send(JSON.stringify({ op: 2, d: { token, intents: 0 } }));
      await expect.poll(() => packets.length).toBe(2);
      socket.send(JSON.stringify({ op: 1, d: 1 }));
      await expect.poll(() => packets.length).toBe(3);
      expect(packets.map((packet) => packet.t ?? packet.op)).toEqual([10, 'READY', 11]);
      expect(packets[1]?.d['guilds']).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('rolls back replay accounting when a fixture packet exceeds capacity after READY', () => {
    const { gateway } = fixture({ maxDispatchBytes: 512, maxTotalReplayBytes: 1024 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => gateway.identify({ token, intents: 1 })).toThrow(/byte limit/);
      expect(gateway.sessions()).toEqual([]);
    }
    // A small valid session still fits; failed bootstrap packets did not reserve bytes.
    expect(gateway.identify({ token, intents: 0 }).ready.t).toBe('READY');
  });

  it('closes an authenticated silent peer on the host watchdog without advancing model time', async () => {
    const { gateway } = fixture();
    const server = new LocalGatewayServer({ gateway, heartbeatTimeoutMs: 100 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { socket, packets } = await connect(server);
      socket.send(JSON.stringify({ op: 2, d: { token, intents: 0 } }));
      await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
      const sessionId = String(packets[1]?.d['session_id']);
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
      await vi.advanceTimersByTimeAsync(60);
      socket.send(JSON.stringify({ op: 1, d: 1 }));
      await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
      await vi.advanceTimersByTimeAsync(99);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      expect((await closed)[0]).toBe(4009);
      expect(gateway.session(sessionId)).toMatchObject({
        state: 'disconnected',
        disconnectedAtMs: 1_420_070_400_000,
      });
    } finally {
      await server.stop();
      vi.useRealTimers();
    }
  });
});
