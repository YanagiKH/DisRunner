import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { LocalGatewayServer } from '../../src/gateway-server.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';

// Literal wire values are independent of the production error and intent constants.
const token = 'disrunner.offline.gateway-regression-test';
const identify = (intents: number | string): string =>
  JSON.stringify({ op: 2, d: { token, intents } });

const rejectedPackets = [
  { name: 'unknown intent bit', payload: identify(131072), code: 4013 },
  { name: 'guild members without portal permission', payload: identify(2), code: 4014 },
  { name: 'guild presences without portal permission', payload: identify(256), code: 4014 },
  { name: 'message content without portal permission', payload: identify(32768), code: 4014 },
  { name: 'malformed JSON', payload: '{', code: 4002 },
  { name: 'malformed IDENTIFY shape', payload: '{"op":2,"d":null}', code: 4002 },
  { name: 'unparseable intent value', payload: identify('not-a-bitfield'), code: 4002 },
];

describe('Gateway close-code transport regressions', () => {
  it.each(rejectedPackets)(
    '$name closes with $code and releases its slot',
    async ({ payload, code }) => {
      const clock = new VirtualClock({ nowMs: 1420070400000 });
      const gateway = new GatewayEmulator({
        clock,
        random: new SeededRandom(1),
        snowflakes: new SnowflakeGenerator(clock),
        fakeToken: token,
        portalEnabledPrivilegedIntents: 0n,
      });
      const server = new LocalGatewayServer({ gateway, maxConnections: 1 });
      const sockets: WebSocket[] = [];
      try {
        const address = await server.start();
        expect(address.host).toBe('127.0.0.1');
        const socket = new WebSocket(address.url);
        sockets.push(socket);
        const received: unknown[] = [];
        socket.on('message', (data: Buffer) =>
          received.push(JSON.parse(data.toString()) as unknown),
        );
        await once(socket, 'message', { signal: AbortSignal.timeout(2000) });
        expect(received).toEqual([{ op: 10, d: { heartbeat_interval: 41250 } }]);
        const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
        socket.send(payload);
        const [actualCode] = (await closed) as unknown[];
        expect(actualCode).toBe(code);
        expect(socket.readyState).toBe(WebSocket.CLOSED);
        expect(received).toHaveLength(1); // No READY or session after a rejected IDENTIFY.
        expect(gateway.sessions()).toEqual([]);

        // maxConnections=1 makes leaked failed connections observable without private state access.
        const replacement = new WebSocket(address.url);
        sockets.push(replacement);
        await once(replacement, 'message', { signal: AbortSignal.timeout(2000) });
        const ready = once(replacement, 'message', { signal: AbortSignal.timeout(2000) });
        replacement.send(identify(1));
        const [data] = (await ready) as [Buffer];
        expect(JSON.parse(data.toString()) as unknown).toMatchObject({ op: 0, t: 'READY' });
        expect(gateway.sessions()).toHaveLength(1);
        expect(gateway.sessions()[0]?.state).toBe('ready');
        const replacementClosed = once(replacement, 'close', { signal: AbortSignal.timeout(2000) });
        await server.stop();
        await replacementClosed;
        expect(gateway.sessions()[0]?.state).toBe('disconnected');
        expect(server.address).toBeUndefined();
      } finally {
        for (const socket of sockets) {
          // Keep unexpected socket errors from escaping cleanup if a preceding assertion failed.
          socket.on('error', () => undefined);
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }
        await server.stop();
      }
    },
  );
});
