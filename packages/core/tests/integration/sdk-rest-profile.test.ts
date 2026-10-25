import { describe, it, expect } from 'vitest';
import {
  GatewayEmulator,
  VirtualClock,
  SeededRandom,
  SnowflakeGenerator,
  VirtualState,
  InteractionEngine,
  LocalRestEmulator,
  RateLimitEngine,
  createSimulationProfile,
  Permissions,
} from '../../src/index.js';

async function stack() {
  const clock = new VirtualClock({ nowMs: 1_800_000_000_000 });
  const random = new SeededRandom(42);
  const ids = new SnowflakeGenerator(clock);
  const bot = { id: '500', username: 'bot', discriminator: '0', avatar: null, bot: true } as const;
  const human = {
    id: '300',
    username: 'human',
    discriminator: '0',
    avatar: null,
    bot: false,
  } as const;
  const state = new VirtualState(clock, ids, [
    { resourceType: 'guild', id: '100', name: 'Guild', owner_id: '300' },
    {
      resourceType: 'channel',
      id: '200',
      type: 0,
      guild_id: '100',
      name: 'general',
      permission_overwrites: [],
    },
    {
      resourceType: 'role',
      id: '100',
      guild_id: '100',
      name: '@everyone',
      position: 0,
      permissions: '68608',
    },
    {
      resourceType: 'role',
      id: '110',
      guild_id: '100',
      name: 'bot',
      position: 10,
      permissions: (
        Permissions.VIEW_CHANNEL |
        Permissions.SEND_MESSAGES |
        Permissions.READ_MESSAGE_HISTORY |
        Permissions.MANAGE_CHANNELS |
        Permissions.MANAGE_ROLES
      ).toString(),
    },
    { ...bot, resourceType: 'user' },
    { ...human, resourceType: 'user' },
    { resourceType: 'member', id: '501', guild_id: '100', user_id: '500', roles: ['110'] },
    { resourceType: 'member', id: '301', guild_id: '100', user_id: '300', roles: [] },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes: ids,
    botUserId: '500',
    applicationId: '400',
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes: ids,
    applicationId: '400',
    profile: createSimulationProfile(),
    messageAuthority: { state, gateway, author: bot, context: { runId: 'rest-profile' } },
  });
  const rateLimits = new RateLimitEngine(clock);
  const server = new LocalRestEmulator({
    state,
    gateway,
    interactions,
    rateLimits,
    commandRegistry: { profile: 'command-registry-v2', guildIds: ['100'] },
    ordinaryMessagePermissions: 'guild-text-own-messages-v1',
    bootstrap: {
      user: bot,
      application: {
        id: '400',
        name: 'Local',
        description: '',
        icon: null,
        bot_public: false,
        bot_require_code_grant: false,
        owner: human,
        verify_key: '0'.repeat(64),
        flags: 0,
        team: null,
      },
    },
  });
  const { apiBaseUrl } = await server.start();
  const call = (route: string, method = 'GET', body?: unknown) =>
    fetch(apiBaseUrl + route, {
      method,
      headers: {
        Authorization: `Bot ${server.sessionToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { state, gateway, interactions, server, apiBaseUrl, call, rateLimits };
}

describe('SDK REST profile over HTTP', () => {
  it('rejects private flags on ordinary routes without mutating state or events', async () => {
    const s = await stack();
    try {
      const events: string[] = [];
      s.gateway.identify({ token: s.gateway.sessionToken, intents: 513 });
      s.gateway.subscribeBroadcast((_session, packet) => events.push(packet.t));
      const before = s.state.snapshot().hash;
      for (const flags of [64, 68, 128, null, '4']) {
        expect(
          (await s.call('/channels/200/messages', 'POST', { content: 'private', flags })).status,
        ).toBe(400);
        expect(s.state.snapshot().hash).toBe(before);
      }
      const created = await s.call('/channels/200/messages', 'POST', {
        content: 'public',
        flags: 4096,
      });
      expect(created.status).toBe(200);
      const message = (await created.json()) as { id: string; flags: number };
      expect(message.flags).toBe(4096);
      const committed = s.state.snapshot().hash;
      for (const flags of [64, 68, 128, null, '4']) {
        expect(
          (await s.call(`/channels/200/messages/${message.id}`, 'PATCH', { flags })).status,
        ).toBe(400);
        expect(s.state.snapshot().hash).toBe(committed);
      }
      expect(events).toEqual(['MESSAGE_CREATE']);
      const edited = await s.call(`/channels/200/messages/${message.id}`, 'PATCH', { flags: 4 });
      expect(edited.status).toBe(200);
      expect(((await edited.json()) as { flags: number }).flags).toBe(4);
      expect(events).toEqual(['MESSAGE_CREATE', 'MESSAGE_UPDATE']);
    } finally {
      await s.server.stop();
    }
  });
  it('deduplicates a real Python-style enforced nonce without cross-channel reuse', async () => {
    const s = await stack();
    try {
      const payload = {
        content: 'Pong!',
        tts: false,
        nonce: '1234567890123456789',
        enforce_nonce: true,
      };
      const first = await s.call('/channels/200/messages', 'POST', payload);
      expect(first.status).toBe(200);
      const a = (await first.json()) as { id: string };
      const second = await s.call('/channels/200/messages', 'POST', payload);
      expect(second.status).toBe(200);
      expect(((await second.json()) as { id: string }).id).toBe(a.id);
      expect(s.state.list('message')).toHaveLength(1);
      const bad = await s.call('/channels/200/messages', 'POST', {
        ...payload,
        nonce: { secret: 'invalid' },
      });
      expect(bad.status).toBe(400);
      expect(s.state.list('message')).toHaveLength(1);
    } finally {
      await s.server.stop();
    }
  });
  it('commits fixture changes through authorized routes and rejects revoked grants atomically', async () => {
    const s = await stack();
    try {
      const events: string[] = [];
      s.gateway.identify({ token: s.gateway.sessionToken, intents: 1 });
      s.gateway.subscribeBroadcast((_session, packet) => events.push(packet.t));
      const create = await s.call('/guilds/100/channels', 'POST', { name: 'new-channel', type: 0 });
      expect(create.status).toBe(201);
      const channel = (await create.json()) as { id: string };
      expect(events).toEqual(['CHANNEL_CREATE']);
      expect((await s.call('/channels/' + channel.id, 'PATCH', { name: 'renamed' })).status).toBe(
        200,
      );
      expect(s.state.require('channel', channel.id)['name']).toBe('renamed');
      expect((await s.call('/guilds/100/members/500')).status).toBe(200);
      expect((await s.call('/guilds/100/roles')).status).toBe(200);
      s.state.update('role', '110', { permissions: '68608' });
      const before = s.state.snapshot().hash;
      expect((await s.call('/channels/' + channel.id, 'PATCH', { name: 'forbidden' })).status).toBe(
        403,
      );
      expect(s.state.snapshot().hash).toBe(before);
      expect(events).toEqual(['CHANNEL_CREATE', 'CHANNEL_UPDATE']);
    } finally {
      await s.server.stop();
    }
  });
  it('roundtrips native multipart bytes while unauthenticated reads and deleted ownership are rejected', async () => {
    const s = await stack();
    try {
      const interaction = s.interactions.create({
        type: 'command',
        messageProfile: 'interactions-v1',
        context: { actorId: '300', guildId: '100', channelId: '200' },
        data: { type: 1, name: 'attachment' },
      });
      const form = new FormData();
      form.set(
        'payload_json',
        JSON.stringify({
          type: 4,
          data: { content: 'A file', attachments: [{ id: 0, filename: 'note.txt' }] },
        }),
      );
      form.set('files[0]', new Blob(['Hello 世界\n'], { type: 'text/plain' }), 'note.txt');
      const response = await fetch(
        `${s.apiBaseUrl}/interactions/${interaction.id}/${interaction.token}/callback`,
        { method: 'POST', body: form },
      );
      expect(response.status).toBe(204);
      const message = s.interactions.getOriginalMessage(interaction.id);
      const file = (message['attachments'] as { id: string; url: string; size: number }[])[0]!;
      expect(file.size).toBe(Buffer.byteLength('Hello 世界\n'));
      expect((await fetch(file.url)).status).toBe(401);
      const download = await fetch(file.url, {
        headers: { Authorization: `Bot ${s.server.sessionToken}` },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('Hello 世界\n');
      s.interactions.deleteOriginal(interaction.id);
      expect(
        (await fetch(file.url, { headers: { Authorization: `Bot ${s.server.sessionToken}` } }))
          .status,
      ).toBe(404);
    } finally {
      await s.server.stop();
    }
  });
});
