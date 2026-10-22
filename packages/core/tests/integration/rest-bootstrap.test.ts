import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { InteractionEngine } from '../../src/interactions.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';
import { RateLimitEngine } from '../../src/rate-limits.js';
import { LocalRestEmulator } from '../../src/rest-emulator.js';
import { createSimulationProfile } from '../../src/scenario.js';
import { VirtualState } from '../../src/state.js';

// Handwritten literals; the Gateway is configured with the same literal IDs, never derived.
const TOKEN = 'disrunner.offline.bootstrap-integration-token';

type Packet = { op: number; d: unknown; t?: string | null; s?: number | null };

function tcpHandles(): { servers: number; sockets: number } {
  const resources = process.getActiveResourcesInfo();
  return {
    servers: resources.filter((name) => name === 'TCPServerWrap').length,
    sockets: resources.filter((name) => name === 'TCPSocketWrap').length,
  };
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createNetServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}

async function nextPacket(socket: WebSocket, packets: Packet[], cursor: number): Promise<Packet> {
  while (packets.length <= cursor) {
    await once(socket, 'message', { signal: AbortSignal.timeout(2_000) });
  }
  return packets[cursor] as Packet;
}

describe('REST bootstrap profile with the local Gateway', () => {
  it('READY identity matches both REST bootstrap routes over a real socket', async () => {
    const before = tcpHandles();
    const clock = new VirtualClock({ nowMs: 1_420_070_400_000 + 100_000 });
    const random = new SeededRandom(41);
    const snowflakes = new SnowflakeGenerator(clock);
    const gateway = new GatewayEmulator({
      clock,
      random,
      snowflakes,
      fakeToken: TOKEN,
      botUserId: '100000000000000001',
      applicationId: '100000000000000002',
    });
    const gatewayServer = new LocalGatewayServer({ gateway });
    const gatewayAddress = await gatewayServer.start(0);

    const state = new VirtualState(clock, snowflakes);
    const rest = new LocalRestEmulator({
      state,
      interactions: new InteractionEngine({
        clock,
        random,
        snowflakes,
        profile: createSimulationProfile({ seed: 41 }),
      }),
      gateway,
      rateLimits: new RateLimitEngine(clock),
      fakeToken: TOKEN,
      gatewayUrl: gatewayAddress.url,
      bootstrap: {
        user: {
          id: '100000000000000001',
          username: 'DisRunner Test Bot',
          discriminator: '0',
          avatar: null,
          bot: true,
        },
        application: {
          id: '100000000000000002',
          name: 'DisRunner Test Application',
          description: 'Synthetic application profile for local tests.',
          icon: null,
          bot_public: false,
          bot_require_code_grant: false,
          owner: {
            id: '100000000000000003',
            username: 'test-owner',
            discriminator: '0',
            avatar: null,
            bot: false,
          },
          verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
          flags: 0,
          team: null,
        },
      },
    });
    const restAddress = await rest.start(0);
    let socket: WebSocket | undefined;
    try {
      const headers = { Authorization: `Bot ${TOKEN}` };
      const gatewayBot = (await (
        await fetch(`${restAddress.apiBaseUrl}/gateway/bot`, { headers })
      ).json()) as { url: string };
      expect(gatewayBot.url).toBe(gatewayAddress.url);

      const restUser = (await (
        await fetch(`${restAddress.apiBaseUrl}/users/@me`, { headers })
      ).json()) as { id: string };
      const restApplication = (await (
        await fetch(`${restAddress.apiBaseUrl}/oauth2/applications/@me`, { headers })
      ).json()) as { id: string; owner: { id: string } };
      expect(restUser.id).toBe('100000000000000001');
      expect(restApplication.id).toBe('100000000000000002');
      expect(restApplication.owner.id).toBe('100000000000000003');

      const packets: Packet[] = [];
      const sent: Packet[] = [];
      const client = new WebSocket(gatewayBot.url);
      socket = client;
      client.on('error', () => undefined);
      client.on('message', (data: Buffer) => packets.push(JSON.parse(data.toString()) as Packet));
      const hello = await nextPacket(client, packets, 0);
      expect(hello.op).toBe(10);
      const identify: Packet = { op: 2, d: { token: TOKEN, intents: 1 } };
      sent.push(identify);
      client.send(JSON.stringify(identify));
      const ready = await nextPacket(client, packets, 1);
      expect(sent[0]?.op).toBe(2);
      expect(ready.op).toBe(0);
      expect(ready.t).toBe('READY');
      const readyData = ready.d as { user: { id: string }; application: { id: string } };
      expect(readyData.user.id).toBe('100000000000000001');
      expect(readyData.application.id).toBe('100000000000000002');
      expect(readyData.user.id).toBe(restUser.id);
      expect(readyData.application.id).toBe(restApplication.id);

      const closed = once(client, 'close', { signal: AbortSignal.timeout(2_000) });
      client.close();
      await closed;
      expect(client.readyState).toBe(WebSocket.CLOSED);
    } finally {
      if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await rest.stop();
      await gatewayServer.stop();
    }
    expect(await canBind(restAddress.port)).toBe(true);
    expect(await canBind(gatewayAddress.port)).toBe(true);
    await expect.poll(() => tcpHandles()).toEqual(before);
  });
});
