import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  GatewayIntentError,
  GatewayIntents,
  Permissions,
  calculatePermissions,
  canManageMember,
  canManageRole,
  filterGatewayEvent,
  validateIdentifyIntents,
} from '../../src/index.js';

describe('permission precedence', () => {
  it('applies everyone, combined roles, then member overwrite in Discord order', () => {
    const decision = calculatePermissions({
      guildId: '1',
      ownerId: 'owner',
      member: { id: 'member', roleIds: ['2', '3'] },
      roles: [
        { id: '1', permissions: Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, position: 0 },
        { id: '2', permissions: Permissions.MANAGE_MESSAGES, position: 1 },
        { id: '3', permissions: 1n << 61n, position: 2 },
      ],
      channel: {
        id: '10',
        overwrites: [
          { id: '1', type: 'role', deny: Permissions.SEND_MESSAGES, allow: 0n },
          { id: '2', type: 'role', deny: 0n, allow: Permissions.SEND_MESSAGES },
          { id: 'member', type: 'member', deny: Permissions.SEND_MESSAGES, allow: 0n },
        ],
      },
      requested: Permissions.SEND_MESSAGES,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.effective & Permissions.MANAGE_MESSAGES).toBe(Permissions.MANAGE_MESSAGES);
    expect(decision.effective & (1n << 61n)).toBe(1n << 61n);
    expect(decision.sources.at(-1)).toMatchObject({ source: 'member-overwrite', effect: 'deny' });
  });

  it('uses BigInt administrator bypass and timeout restrictions', () => {
    const admin = calculatePermissions({
      guildId: '1',
      ownerId: 'owner',
      member: { id: 'admin', roleIds: ['2'] },
      roles: [
        { id: '1', permissions: '0', position: 0 },
        { id: '2', permissions: Permissions.ADMINISTRATOR.toString(), position: 1 },
      ],
      requested: 1n << 63n,
    });
    expect(admin).toMatchObject({ allowed: true, effective: ALL_PERMISSIONS });

    const timedOut = calculatePermissions({
      guildId: '1',
      ownerId: 'owner',
      member: { id: 'admin', roleIds: ['2'], timedOutUntilMs: 10_001 },
      roles: [
        {
          id: '1',
          permissions: Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY,
          position: 0,
        },
        { id: '2', permissions: Permissions.ADMINISTRATOR, position: 1 },
      ],
      requested: Permissions.SEND_MESSAGES,
      nowMs: 10_000,
    });
    expect(timedOut.allowed).toBe(false);
  });

  it('enforces role and member hierarchy, including equal roles and guild owner', () => {
    const roles = [
      { id: '1', permissions: 0n, position: 0 },
      { id: '10', permissions: 0n, position: 5 },
      { id: '11', permissions: 0n, position: 5 },
    ];
    const actor = { id: 'bot', roleIds: ['11'] };
    expect(canManageRole(actor, roles[1]!, roles).allowed).toBe(false);
    expect(canManageMember(actor, { id: 'owner', roleIds: [] }, roles, 'owner').allowed).toBe(
      false,
    );
  });
});

describe('Gateway intent filtering', () => {
  it('suppresses events missing their intent', () => {
    const result = filterGatewayEvent('GUILD_MEMBER_ADD', { guild_id: '1' }, GatewayIntents.GUILDS);
    expect(result).toMatchObject({
      delivered: false,
      requiredIntent: GatewayIntents.GUILD_MEMBERS,
    });
  });

  it('delivers MESSAGE_CREATE but strips content-bearing fields without MESSAGE_CONTENT', () => {
    const payload = {
      id: '3',
      guild_id: '1',
      content: 'secret text',
      embeds: [{ title: 'secret' }],
      attachments: [{ id: '4' }],
      components: [{ type: 1 }],
      poll: { question: 'secret' },
      author: { id: '2' },
    };
    const result = filterGatewayEvent('MESSAGE_CREATE', payload, GatewayIntents.GUILD_MESSAGES, {
      botUserId: 'bot',
    });
    expect(result.delivered).toBe(true);
    expect(result.strippedMessageContent).toBe(true);
    expect(result.data).toMatchObject({
      content: '',
      embeds: [],
      attachments: [],
      components: [],
      poll: null,
    });
    expect(payload.content).toBe('secret text');
  });

  it('keeps content in DMs and bot-mentioned guild messages', () => {
    const dm = filterGatewayEvent(
      'MESSAGE_CREATE',
      { content: 'dm' },
      GatewayIntents.DIRECT_MESSAGES,
    );
    expect(dm).toMatchObject({ delivered: true, strippedMessageContent: false });
    const mention = filterGatewayEvent(
      'MESSAGE_CREATE',
      { guild_id: '1', content: 'hello', author: { id: 'user' }, mentions: [{ id: 'bot' }] },
      GatewayIntents.GUILD_MESSAGES,
      { botUserId: 'bot' },
    );
    expect(mention).toMatchObject({ delivered: true, strippedMessageContent: false });
  });

  it('rejects invalid and portal-disabled privileged identify intents', () => {
    expect(() => validateIdentifyIntents(1n << 62n)).toThrowError(GatewayIntentError);
    try {
      validateIdentifyIntents(GatewayIntents.MESSAGE_CONTENT, 0n);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ closeCode: 4014 });
    }
  });
});
