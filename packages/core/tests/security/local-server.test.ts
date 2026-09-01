import { request } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  GatewayEmulator,
  InteractionEngine,
  LocalRestEmulator,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
} from '../../src/index.js';

describe('local REST boundary', () => {
  it('rejects DNS-rebinding Host headers and oversized payloads', async () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const random = new SeededRandom(1);
    const snowflakes = new SnowflakeGenerator(clock);
    const interactions = new InteractionEngine({
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile(),
    });
    const server = new LocalRestEmulator({
      state: new VirtualState(clock, snowflakes),
      interactions,
      gateway: new GatewayEmulator({ clock, random, snowflakes }),
      rateLimits: new RateLimitEngine(clock),
      maxBodyBytes: 16,
    });
    const address = await server.start();
    try {
      const rebound = await rawRequest(
        address.port,
        'GET',
        '/api/v10/gateway',
        'attacker.example',
        '',
      );
      expect(rebound.status).toBe(403);
      const interaction = interactions.create();
      const oversized = await rawRequest(
        address.port,
        'POST',
        `/api/v10/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`,
        `127.0.0.1:${address.port}`,
        JSON.stringify({ content: 'this is too large' }),
      );
      expect(oversized.status).toBe(413);
    } finally {
      await server.stop();
    }
  });
});

async function rawRequest(
  port: number,
  method: string,
  path: string,
  host: string,
  body: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}
