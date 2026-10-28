import { describe, expect, it } from 'vitest';

import type { ResourceRecord } from '../../src/contracts.js';
import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';
import { ResourceDomainService } from '../../src/resource-domain.js';
import { VirtualState } from '../../src/state.js';
import { LocalRestEmulator } from '../../src/rest-emulator.js';
import { InteractionEngine } from '../../src/interactions.js';
import { RateLimitEngine } from '../../src/rate-limits.js';
import { createSimulationProfile } from '../../src/scenario.js';

const token = 'disrunner.offline.resource-domain-test';
function fixture(enforcePermissions = true) {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: '1', name: 'Guild', owner_id: '11' },
    {
      resourceType: 'user',
      id: '10',
      username: 'Bot',
      bot: true,
      discriminator: '0',
      avatar: null,
    },
    {
      resourceType: 'user',
      id: '11',
      username: 'Owner',
      bot: false,
      discriminator: '0',
      avatar: null,
    },
    {
      resourceType: 'user',
      id: '12',
      username: 'Member',
      bot: false,
      discriminator: '0',
      avatar: null,
    },
    {
      resourceType: 'role',
      id: '1',
      guild_id: '1',
      name: '@everyone',
      permissions: '3072',
      position: 0,
    },
    { resourceType: 'role', id: '2', guild_id: '1', name: 'Low', permissions: '0', position: 1 },
    {
      resourceType: 'role',
      id: '3',
      guild_id: '1',
      name: 'Bot',
      permissions: '402653200',
      position: 10,
    },
    { resourceType: 'role', id: '4', guild_id: '1', name: 'High', permissions: '8', position: 20 },
    { resourceType: 'member', id: '100', guild_id: '1', user_id: '10', roles: ['3'] },
    { resourceType: 'member', id: '101', guild_id: '1', user_id: '11', roles: ['4'] },
    { resourceType: 'member', id: '102', guild_id: '1', user_id: '12', roles: ['2'] },
    {
      resourceType: 'channel',
      id: '20',
      guild_id: '1',
      type: 0,
      name: 'general',
      permission_overwrites: [],
    },
    { resourceType: 'channel', id: '21', type: 1, recipients: [{ id: '12', username: 'Member' }] },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random: new SeededRandom(2),
    snowflakes,
    fakeToken: token,
    botUserId: '10',
    portalEnabledPrivilegedIntents: 2n,
  });
  const { sessionId } = gateway.identify({ token, intents: 3 });
  const events: { name: string; data: unknown; revision: number }[] = [];
  gateway.subscribeBroadcast((id, packet) => {
    if (id !== sessionId) return;
    expect(state.transactionActive).toBe(false);
    events.push({ name: packet.t, data: packet.d, revision: state.revision });
  });
  const service = new ResourceDomainService({
    state,
    gateway,
    botUserId: '10',
    enforcePermissions,
  });
  return { state, gateway, service, events };
}

describe('authoritative guild resource mutations', () => {
  it('serves real HTTP resource CRUD with SDK wire shapes and an atomic 403 after revocation', async () => {
    const { state, gateway, events } = fixture();
    const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
    const interactions = new InteractionEngine({
      clock,
      random: new SeededRandom(8),
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
      applicationId: gateway.applicationId,
    });
    const rest = new LocalRestEmulator({
      state,
      gateway,
      interactions,
      rateLimits: new RateLimitEngine(clock),
      fakeToken: token,
      commandRegistry: { profile: 'command-registry-v2', guildIds: ['1'] },
      bootstrap: {
        user: { id: '10', username: 'Bot', discriminator: '0', avatar: null, bot: true },
        application: {
          id: '10',
          name: 'Local application',
          description: '',
          icon: null,
          bot_public: false,
          bot_require_code_grant: false,
          owner: { id: '11', username: 'Owner', discriminator: '0', avatar: null, bot: false },
          verify_key: '0'.repeat(64),
          flags: 0,
          team: null,
        },
      },
    });
    const address = await rest.start();
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(address.apiBaseUrl + path, {
        method,
        headers: {
          authorization: 'Bot ' + token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const source = await response.text();
      return {
        status: response.status,
        body: source ? (JSON.parse(source) as Record<string, unknown>) : null,
      };
    };
    try {
      const role = await request('POST', '/guilds/1/roles', {
        name: 'HTTP role',
        colors: { primary_color: 255 },
        permissions: '0',
      });
      expect(role).toMatchObject({
        status: 200,
        body: { name: 'HTTP role', color: 255, colors: { primary_color: 255 } },
      });
      const roleId = String(role.body?.['id']);
      expect(
        await request('PATCH', '/guilds/1/members/12', {
          roles: ['2', roleId],
          nick: 'HTTP member',
        }),
      ).toMatchObject({
        status: 200,
        body: { user: { id: '12', username: 'Member' }, roles: ['2', roleId], nick: 'HTTP member' },
      });
      expect(
        await request('PATCH', '/guilds/1/roles/' + roleId, { name: 'Renamed role' }),
      ).toMatchObject({ status: 200, body: { name: 'Renamed role' } });
      const channel = await request('POST', '/guilds/1/channels', {
        name: 'http-channel',
        type: 0,
      });
      expect(channel).toMatchObject({
        status: 201,
        body: { guild_id: '1', name: 'http-channel', type: 0 },
      });
      const channelId = String(channel.body?.['id']);
      expect(
        await request('PATCH', '/channels/' + channelId, { topic: 'HTTP topic' }),
      ).toMatchObject({ status: 200, body: { topic: 'HTTP topic' } });
      expect(await request('DELETE', '/guilds/1/roles/' + roleId)).toEqual({
        status: 204,
        body: null,
      });
      expect((await request('GET', '/guilds/1/members/12')).body?.['roles']).toEqual(['2']);
      expect(await request('DELETE', '/channels/' + channelId)).toEqual({
        status: 204,
        body: null,
      });
      state.update('role', '3', { permissions: '0' });
      const before = state.snapshot();
      const count = events.length;
      expect(
        await request('PATCH', '/channels/20', { name: 'Denied by fresh permissions' }),
      ).toMatchObject({ status: 403, body: { code: 50013 } });
      expect(state.snapshot()).toEqual(before);
      expect(events).toHaveLength(count);
    } finally {
      await rest.stop();
    }
  });
  it('reads Discord-shaped users/members/roles/channels and publishes channel CRUD only after commit', () => {
    const { state, service, events } = fixture();
    expect(service.get('member', '12', '1')).toMatchObject({
      user: { id: '12', username: 'Member' },
      roles: ['2'],
      flags: 0,
    });
    expect(service.get('member', '12', '1')).not.toHaveProperty('resourceType');
    expect(service.get('channel', '21')).toMatchObject({
      id: '21',
      type: 1,
      recipients: [{ id: '12' }],
    });
    expect(service.list('role', '1')).toHaveLength(4);
    const created = service.execute({
      kind: 'channel',
      operation: 'create',
      guildId: '1',
      data: { name: 'testing', type: 0, permission_overwrites: [] },
    })!;
    expect(state.get('channel', created.id)).toMatchObject({
      name: 'testing',
      guild_id: '1',
      type: 0,
    });
    expect(events).toMatchObject([
      { name: 'CHANNEL_CREATE', data: { id: created.id, name: 'testing' }, revision: 1 },
    ]);
    service.execute({
      kind: 'channel',
      operation: 'update',
      guildId: '1',
      resourceId: created.id,
      data: { topic: 'Updated topic' },
    });
    expect(events[1]).toMatchObject({
      name: 'CHANNEL_UPDATE',
      data: { id: created.id, topic: 'Updated topic' },
      revision: 2,
    });
    state.create('message', {
      id: '30',
      channel_id: created.id,
      guild_id: '1',
      content: 'Removed with channel',
    });
    const beforeDelete = state.revision;
    expect(
      service.execute({
        kind: 'channel',
        operation: 'delete',
        guildId: '1',
        resourceId: created.id,
      }),
    ).toBeNull();
    expect(state.get('message', '30')).toBeUndefined();
    expect(state.revision).toBe(beforeDelete + 1);
    expect(events[2]).toMatchObject({
      name: 'CHANNEL_DELETE',
      data: { id: created.id },
      revision: beforeDelete + 1,
    });
  });

  it('rechecks current member roles and channel overwrites, with owner and administrator bypass', () => {
    const { state, service, events } = fixture();
    service.execute({
      kind: 'channel',
      operation: 'update',
      guildId: '1',
      resourceId: '20',
      data: { permission_overwrites: [{ id: '10', type: 1, allow: '0', deny: '1024' }] },
    });
    const before = state.snapshot();
    expect(() =>
      service.execute({ kind: 'channel', operation: 'delete', guildId: '1', resourceId: '20' }),
    ).toThrow('Missing Permissions');
    expect(state.snapshot()).toEqual(before);
    expect(events).toHaveLength(1);
    state.update('role', '3', { permissions: '8' });
    service.execute({
      kind: 'channel',
      operation: 'update',
      guildId: '1',
      resourceId: '20',
      data: { name: 'admin-allowed' },
    });
    state.update('role', '3', { permissions: '0' });
    state.update('guild', '1', { owner_id: '10' });
    service.execute({ kind: 'channel', operation: 'delete', guildId: '1', resourceId: '20' });
    expect(events.map((event) => event.name)).toEqual([
      'CHANNEL_UPDATE',
      'CHANNEL_UPDATE',
      'CHANNEL_DELETE',
    ]);
  });

  it('updates roles and members with hierarchy checks and cleans role references atomically', () => {
    const { state, service, events } = fixture();
    const role = service.execute({
      kind: 'role',
      operation: 'create',
      guildId: '1',
      data: {
        name: 'Reviewer',
        colors: { primary_color: 255, secondary_color: null, tertiary_color: null },
        permissions: '0',
      },
    })!;
    expect(service.get('role', role.id, '1')).toMatchObject({
      name: 'Reviewer',
      color: 255,
      colors: { primary_color: 255 },
      position: 1,
      managed: false,
    });
    service.execute({
      kind: 'role',
      operation: 'update',
      guildId: '1',
      resourceId: role.id,
      data: { name: 'Reviewed', permissions: 1024 },
    });
    expect(service.get('role', role.id, '1')).toMatchObject({
      name: 'Reviewed',
      permissions: '1024',
    });
    service.execute({
      kind: 'member',
      operation: 'update',
      guildId: '1',
      resourceId: '12',
      data: { nick: 'Test member', roles: ['2', role.id] },
    });
    expect(service.get('member', '12', '1')).toMatchObject({
      nick: 'Test member',
      roles: ['2', role.id],
    });
    state.update('channel', '20', {
      permission_overwrites: [{ id: role.id, type: 0, allow: '0', deny: '2048' }],
    });
    const revision = state.revision;
    service.execute({ kind: 'role', operation: 'delete', guildId: '1', resourceId: role.id });
    expect(state.revision).toBe(revision + 1);
    expect(service.get('member', '12', '1')['roles']).toEqual(['2']);
    expect(service.get('channel', '20')['permission_overwrites']).toEqual([]);
    expect(events.map((event) => event.name)).toEqual([
      'GUILD_ROLE_CREATE',
      'GUILD_ROLE_UPDATE',
      'GUILD_MEMBER_UPDATE',
      'GUILD_ROLE_DELETE',
      'GUILD_MEMBER_UPDATE',
      'CHANNEL_UPDATE',
    ]);
    expect(events.slice(-3).every((event) => event.revision === revision + 1)).toBe(true);
  });

  it('requires the relevant live permission and preserves no-op state and events', () => {
    const { state, service, events } = fixture();
    const initial = state.snapshot();
    service.execute({
      kind: 'channel',
      operation: 'update',
      guildId: '1',
      resourceId: '20',
      data: { name: 'general' },
    });
    expect(state.snapshot()).toEqual(initial);
    expect(events).toEqual([]);
    state.update('role', '3', { permissions: '16' });
    // discord.py includes an empty overwrite list in an ordinary channel create.
    const created = service.execute({
      kind: 'channel',
      operation: 'create',
      guildId: '1',
      data: { name: 'Channel only', permission_overwrites: [] },
    });
    expect(created).toMatchObject({ name: 'Channel only' });
    const before = state.snapshot();
    expect(() =>
      service.execute({
        kind: 'member',
        operation: 'update',
        guildId: '1',
        resourceId: '12',
        data: { nick: 'Denied' },
      }),
    ).toThrow('Missing Permissions');
    expect(state.snapshot()).toEqual(before);
    state.update('role', '3', { permissions: '8' });
    state.update('member', '100', { communication_disabled_until: '2015-01-01T00:02:00.000Z' });
    expect(() =>
      service.execute({
        kind: 'role',
        operation: 'update',
        guildId: '1',
        resourceId: '2',
        data: { name: 'Timed out' },
      }),
    ).toThrow('Missing Permissions');
  });

  it('checks changed-role hierarchy separately from nickname target hierarchy', () => {
    const { service, state, events } = fixture();
    service.execute({
      kind: 'member',
      operation: 'update',
      guildId: '1',
      resourceId: '10',
      data: { roles: ['3', '2'] },
    });
    expect(service.get('member', '10', '1')['roles']).toEqual(['3', '2']);
    service.execute({
      kind: 'member',
      operation: 'update',
      guildId: '1',
      resourceId: '11',
      data: { roles: ['4', '2'] },
    });
    expect(service.get('member', '11', '1')['roles']).toEqual(['4', '2']);
    const before = state.snapshot();
    expect(() =>
      service.execute({
        kind: 'member',
        operation: 'update',
        guildId: '1',
        resourceId: '10',
        data: { roles: ['2'] },
      }),
    ).toThrow('Missing Permissions');
    expect(() =>
      service.execute({
        kind: 'member',
        operation: 'update',
        guildId: '1',
        resourceId: '11',
        data: { nick: 'Owner nickname' },
      }),
    ).toThrow('Missing Permissions');
    expect(state.snapshot()).toEqual(before);
    expect(events.map((event) => event.name)).toEqual([
      'GUILD_MEMBER_UPDATE',
      'GUILD_MEMBER_UPDATE',
    ]);
  });

  it('rejects higher/managed roles, owner member changes, escalation and malformed payloads without mutation or events', () => {
    const { state, service, events } = fixture();
    state.update('role', '2', { managed: true });
    for (const request of [
      {
        kind: 'role',
        operation: 'update',
        guildId: '1',
        resourceId: '4',
        data: { name: 'Too high' },
      },
      { kind: 'role', operation: 'delete', guildId: '1', resourceId: '1' },
      { kind: 'role', operation: 'delete', guildId: '1', resourceId: '2' },
      {
        kind: 'role',
        operation: 'create',
        guildId: '1',
        data: { name: 'Admin', permissions: '8' },
      },
      {
        kind: 'member',
        operation: 'update',
        guildId: '1',
        resourceId: '11',
        data: { nick: 'Owner' },
      },
      {
        kind: 'member',
        operation: 'update',
        guildId: '1',
        resourceId: '12',
        data: { roles: ['4'] },
      },
      { kind: 'channel', operation: 'create', guildId: '1', data: { name: 'Voice', type: 2 } },
      {
        kind: 'channel',
        operation: 'update',
        guildId: '1',
        resourceId: '20',
        data: { permission_overwrites: [{ id: '999', type: 0, allow: '0', deny: '0' }] },
      },
      { kind: 'role', operation: 'update', guildId: '1', resourceId: '3', data: { position: 50 } },
      { kind: 'member', operation: 'delete', guildId: '1', resourceId: '12' },
    ] as const) {
      const before = state.snapshot();
      expect(() => service.execute(request)).toThrow();
      expect(state.snapshot()).toEqual(before);
    }
    expect(events).toEqual([]);
  });

  it('rolls back staged resources when Gateway preflight fails and permits explicit legacy permission opt-out', () => {
    const { state, service, gateway, events } = fixture();
    const original = gateway.preflightBroadcast.bind(gateway);
    gateway.preflightBroadcast = () => {
      throw new Error('capacity');
    };
    const before = state.snapshot();
    expect(() =>
      service.execute({
        kind: 'role',
        operation: 'create',
        guildId: '1',
        data: { name: 'No commit' },
      }),
    ).toThrow();
    expect(state.snapshot()).toEqual(before);
    expect(events).toEqual([]);
    gateway.preflightBroadcast = original;
    state.update('role', '3', { permissions: '0' });
    expect(() =>
      service.execute({
        kind: 'channel',
        operation: 'update',
        guildId: '1',
        resourceId: '20',
        data: { name: 'Forbidden' },
      }),
    ).toThrow();
    const legacy = new ResourceDomainService({ state, gateway, enforcePermissions: false });
    expect(
      legacy.execute({
        kind: 'channel',
        operation: 'update',
        guildId: '1',
        resourceId: '20',
        data: { name: 'Explicit legacy' },
      }) as ResourceRecord,
    ).toMatchObject({ name: 'Explicit legacy' });
  });
});
