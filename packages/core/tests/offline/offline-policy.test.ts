import { describe, expect, it, vi } from 'vitest';

import {
  OfflineNetworkError,
  assertOfflineUrl,
  createOfflineFetch,
  sanitizeBotEnvironment,
} from '../../src/index.js';

describe('offline network policy', () => {
  it.each([
    'https://discord.com/api/v10/gateway',
    'https://canary.discord.com/api',
    'https://cdn.discordapp.com/asset.png',
    'wss://gateway.discord.gg',
    'https://example.com',
    'http://localhost.evil.invalid',
    'file:///tmp/token',
  ])('blocks %s', (target) => {
    expect(() => assertOfflineUrl(target)).toThrowError(OfflineNetworkError);
  });

  it.each([
    'http://127.0.0.1:3000/api/v10',
    'http://127.20.30.40:8080',
    'ws://localhost:4000/gateway',
    'http://[::1]:5000/interactions',
  ])('allows loopback target %s', (target) => {
    expect(assertOfflineUrl(target).href).toBe(new URL(target).href);
  });

  it('blocks before delegating to fetch', async () => {
    const baseFetch = vi.fn<typeof fetch>();
    const offlineFetch = createOfflineFetch(baseFetch);
    await expect(offlineFetch('https://discord.com/api/v10')).rejects.toThrow(OfflineNetworkError);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('never forwards real token environment variables into a bot', () => {
    const env = sanitizeBotEnvironment(
      {
        PATH: 'path',
        DISCORD_TOKEN: 'real',
        BOT_TOKEN: 'also-real',
        API_KEY: 'secret',
        UNRELATED_PARENT_VALUE: 'must-not-inherit',
      },
      {
        env: { CUSTOM_SECRET: 'secret', SAFE_VALUE: 'yes' },
        restBaseUrl: 'http://127.0.0.1:1/api/v10',
        gatewayUrl: 'ws://127.0.0.1:2',
      },
    );
    expect(env).toMatchObject({
      PATH: 'path',
      SAFE_VALUE: 'yes',
      DISRUNNER_OFFLINE: '1',
      DISRUNNER_NETWORK_POLICY: 'loopback-only',
    });
    expect(env['DISCORD_TOKEN']).toMatch(/^disrunner\.offline\./);
    expect(env['BOT_TOKEN']).toBeUndefined();
    expect(env['API_KEY']).toBeUndefined();
    expect(env['CUSTOM_SECRET']).toBeUndefined();
    expect(env['UNRELATED_PARENT_VALUE']).toBeUndefined();
    expect(() =>
      sanitizeBotEnvironment(
        {},
        {
          env: {
            SAFE_NAME: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.ABCDEF.abcdefghijklmnopqrstuvwxyz',
          },
          restBaseUrl: 'http://127.0.0.1:1/api/v10',
          gatewayUrl: 'ws://127.0.0.1:2',
        },
      ),
    ).toThrow(/Discord credential/);

    const peerSecret = 'ab'.repeat(32);
    const protectedEnvironment = sanitizeBotEnvironment(
      {},
      {
        env: { DISRUNNER_WEBHOOK_PEER_SECRET: 'project-controlled-value' },
        restBaseUrl: 'http://127.0.0.1:1/api/v10',
        gatewayUrl: 'ws://127.0.0.1:2',
        interactionEndpoint: 'http://127.0.0.1:3/interactions',
        interactionPeerSecret: peerSecret,
      },
    );
    expect(protectedEnvironment['DISRUNNER_WEBHOOK_PEER_SECRET']).toBe(peerSecret);
    expect(JSON.stringify(protectedEnvironment)).not.toContain('project-controlled-value');

    expect(() =>
      sanitizeBotEnvironment(
        {},
        {
          restBaseUrl: 'http://127.0.0.1:1/api/v10',
          gatewayUrl: 'ws://127.0.0.1:2',
          interactionEndpoint: 'http://127.0.0.1:3/interactions',
        },
      ),
    ).toThrow(/must be supplied together/u);
    expect(() =>
      sanitizeBotEnvironment(
        {},
        {
          restBaseUrl: 'http://127.0.0.1:1/api/v10',
          gatewayUrl: 'ws://127.0.0.1:2',
          interactionEndpoint: 'http://127.0.0.1:3/interactions',
          interactionPeerSecret: 'not-hex',
        },
      ),
    ).toThrow(/32-byte hexadecimal/u);
  });
});
