import type { PermissionDecision } from './contracts.js';

export const Permissions = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  MODERATE_MEMBERS: 1n << 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  USE_SOUNDBOARD: 1n << 42n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,
  USE_EXTERNAL_APPS: 1n << 50n,
  PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
} as const;

export const ALL_PERMISSIONS = (1n << 64n) - 1n;

export interface PermissionRole {
  readonly id: string;
  readonly permissions: bigint | string;
  readonly position: number;
}

export interface PermissionMember {
  readonly id: string;
  readonly roleIds: readonly string[];
  readonly timedOutUntilMs?: number | null;
}

export interface PermissionOverwrite {
  readonly id: string;
  readonly type: 'role' | 'member';
  readonly allow: bigint | string;
  readonly deny: bigint | string;
}

export interface PermissionChannel {
  readonly id: string;
  readonly overwrites?: readonly PermissionOverwrite[];
  readonly parentOverwrites?: readonly PermissionOverwrite[];
  readonly isThread?: boolean;
  readonly permissionsSynced?: boolean;
}

export interface PermissionContext {
  readonly guildId: string;
  readonly ownerId: string;
  readonly member: PermissionMember;
  readonly roles: readonly PermissionRole[];
  readonly channel?: PermissionChannel;
  readonly requested: bigint | string;
  readonly nowMs?: number;
}

export function calculatePermissions(context: PermissionContext): PermissionDecision {
  const requested = parsePermissionBits(context.requested);
  const sources: PermissionDecision['sources'][number][] = [];

  if (context.member.id === context.ownerId) {
    sources.push({
      source: 'guild-owner',
      effect: 'allow',
      bits: ALL_PERMISSIONS,
      reason: 'Guild owners bypass permission checks.',
    });
    return {
      allowed: true,
      effective: ALL_PERMISSIONS | requested,
      requested,
      sources,
      reason: 'Guild owner bypass.',
    };
  }

  const everyone = context.roles.find((role) => role.id === context.guildId);
  let effective = everyone === undefined ? 0n : parsePermissionBits(everyone.permissions);
  sources.push({
    source: '@everyone',
    effect: effective === 0n ? 'neutral' : 'allow',
    bits: effective,
    reason: everyone === undefined ? 'The @everyone role is missing.' : 'Guild base permissions.',
  });

  const memberRoles = context.roles.filter(
    (role) => role.id !== context.guildId && context.member.roleIds.includes(role.id),
  );
  for (const role of memberRoles) {
    const bits = parsePermissionBits(role.permissions);
    effective |= bits;
    sources.push({
      source: `role:${role.id}`,
      effect: bits === 0n ? 'neutral' : 'allow',
      bits,
      reason: 'Member role permissions are combined.',
    });
  }

  const timedOut =
    context.member.timedOutUntilMs != null &&
    context.member.timedOutUntilMs > (context.nowMs ?? Date.now());
  if ((effective & Permissions.ADMINISTRATOR) !== 0n && !timedOut) {
    sources.push({
      source: 'administrator',
      effect: 'allow',
      bits: ALL_PERMISSIONS,
      reason: 'Administrator bypasses channel overwrites and implicit channel permissions.',
    });
    return {
      allowed: true,
      effective: ALL_PERMISSIONS | requested,
      requested,
      sources,
      reason: 'Administrator bypass.',
    };
  }

  const channel = context.channel;
  if (channel !== undefined) {
    const inherited =
      channel.isThread === true && channel.overwrites === undefined
        ? channel.parentOverwrites
        : channel.permissionsSynced === true
          ? (channel.parentOverwrites ?? channel.overwrites)
          : channel.overwrites;
    effective = applyChannelOverwrites(effective, inherited ?? [], context, sources);
  }

  effective = applyImplicitPermissions(effective, timedOut, sources);
  const missing = requested & ~effective;
  const allowed = missing === 0n;
  return {
    allowed,
    effective,
    requested,
    sources,
    reason: allowed
      ? 'All requested permission bits are present.'
      : `Missing permission bits ${missing.toString()}.`,
  };
}

export function compareRoleHierarchy(left: PermissionRole, right: PermissionRole): number {
  if (left.id === right.id) return 0;
  if (left.position !== right.position) return left.position - right.position;
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? 1 : -1;
  }
  return right.id.localeCompare(left.id);
}

export interface HierarchyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly actorHighestRole?: PermissionRole;
  readonly targetHighestRole?: PermissionRole;
}

export function canManageRole(
  actor: PermissionMember,
  target: PermissionRole,
  roles: readonly PermissionRole[],
  ownerId?: string,
): HierarchyDecision {
  if (actor.id === ownerId) return { allowed: true, reason: 'Guild owner bypass.' };
  const actorHighestRole = highestRole(actor, roles);
  if (actorHighestRole === undefined)
    return { allowed: false, reason: 'Actor has no role above @everyone.' };
  const allowed = compareRoleHierarchy(actorHighestRole, target) > 0;
  return {
    allowed,
    reason: allowed
      ? 'Actor role is higher than target role.'
      : 'Bot cannot manage an equal or higher role.',
    actorHighestRole,
    targetHighestRole: target,
  };
}

export function canManageMember(
  actor: PermissionMember,
  target: PermissionMember,
  roles: readonly PermissionRole[],
  ownerId: string,
): HierarchyDecision {
  if (actor.id === ownerId) return { allowed: true, reason: 'Guild owner bypass.' };
  if (target.id === ownerId)
    return { allowed: false, reason: 'The guild owner cannot be managed.' };
  if (actor.id === target.id)
    return { allowed: false, reason: 'A member cannot perform this action on itself.' };
  const actorHighestRole = highestRole(actor, roles);
  const targetHighestRole = highestRole(target, roles);
  if (actorHighestRole === undefined) {
    return {
      allowed: false,
      reason: 'Actor has no manageable role.',
      ...(targetHighestRole === undefined ? {} : { targetHighestRole }),
    };
  }
  if (targetHighestRole === undefined) {
    return { allowed: true, reason: 'Target only has @everyone.', actorHighestRole };
  }
  const allowed = compareRoleHierarchy(actorHighestRole, targetHighestRole) > 0;
  return {
    allowed,
    reason: allowed
      ? 'Actor role is higher than target member role.'
      : 'Bot cannot manage an equal or higher member.',
    actorHighestRole,
    targetHighestRole,
  };
}

export function parsePermissionBits(value: bigint | string): bigint {
  const result = typeof value === 'bigint' ? value : BigInt(value);
  if (result < 0n) throw new RangeError('Permission bitfields cannot be negative.');
  return result;
}

function applyChannelOverwrites(
  initial: bigint,
  overwrites: readonly PermissionOverwrite[],
  context: PermissionContext,
  sources: PermissionDecision['sources'][number][],
): bigint {
  let effective = initial;
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 'role' && overwrite.id === context.guildId,
  );
  if (everyone !== undefined)
    effective = applyOverwrite(effective, everyone, '@everyone-overwrite', sources);

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 'role' && context.member.roleIds.includes(overwrite.id)) {
      roleDeny |= parsePermissionBits(overwrite.deny);
      roleAllow |= parsePermissionBits(overwrite.allow);
    }
  }
  if (roleDeny !== 0n || roleAllow !== 0n) {
    effective &= ~roleDeny;
    effective |= roleAllow;
    if (roleDeny !== 0n) {
      sources.push({
        source: 'combined-role-overwrites',
        effect: 'deny',
        bits: roleDeny,
        reason: 'All matching role denies are applied before role allows.',
      });
    }
    if (roleAllow !== 0n) {
      sources.push({
        source: 'combined-role-overwrites',
        effect: 'allow',
        bits: roleAllow,
        reason: 'Matching role allows override matching role denies.',
      });
    }
  }

  const member = overwrites.find(
    (overwrite) => overwrite.type === 'member' && overwrite.id === context.member.id,
  );
  if (member !== undefined)
    effective = applyOverwrite(effective, member, 'member-overwrite', sources);
  return effective;
}

function applyOverwrite(
  initial: bigint,
  overwrite: PermissionOverwrite,
  source: string,
  sources: PermissionDecision['sources'][number][],
): bigint {
  const deny = parsePermissionBits(overwrite.deny);
  const allow = parsePermissionBits(overwrite.allow);
  let effective = initial & ~deny;
  effective |= allow;
  if (deny !== 0n)
    sources.push({ source, effect: 'deny', bits: deny, reason: 'Channel overwrite deny.' });
  if (allow !== 0n)
    sources.push({ source, effect: 'allow', bits: allow, reason: 'Channel overwrite allow.' });
  return effective;
}

function applyImplicitPermissions(
  initial: bigint,
  timedOut: boolean,
  sources: PermissionDecision['sources'][number][],
): bigint {
  let effective = initial;
  if ((effective & Permissions.VIEW_CHANNEL) === 0n) {
    const denied = effective & CHANNEL_DEPENDENT_PERMISSIONS;
    effective &= ~CHANNEL_DEPENDENT_PERMISSIONS;
    if (denied !== 0n) {
      sources.push({
        source: 'implicit:view-channel',
        effect: 'deny',
        bits: denied,
        reason: 'Channel-dependent permissions are unusable without View Channel.',
      });
    }
  }
  if ((effective & Permissions.SEND_MESSAGES) === 0n) {
    const denied = effective & SEND_DEPENDENT_PERMISSIONS;
    effective &= ~SEND_DEPENDENT_PERMISSIONS;
    if (denied !== 0n) {
      sources.push({
        source: 'implicit:send-messages',
        effect: 'deny',
        bits: denied,
        reason: 'Message composition permissions are unusable without Send Messages.',
      });
    }
  }
  if ((effective & Permissions.CONNECT) === 0n) {
    const denied = effective & VOICE_DEPENDENT_PERMISSIONS;
    effective &= ~VOICE_DEPENDENT_PERMISSIONS;
    if (denied !== 0n) {
      sources.push({
        source: 'implicit:connect',
        effect: 'deny',
        bits: denied,
        reason: 'Voice permissions are unusable without Connect.',
      });
    }
  }
  if (timedOut) {
    const retained = Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY;
    const denied = effective & ~retained;
    effective &= retained;
    sources.push({
      source: 'member-timeout',
      effect: 'deny',
      bits: denied,
      reason: 'Timed-out members retain only viewing and message-history access.',
    });
  }
  return effective;
}

function highestRole(
  member: PermissionMember,
  roles: readonly PermissionRole[],
): PermissionRole | undefined {
  return roles
    .filter((role) => member.roleIds.includes(role.id))
    .sort((left, right) => compareRoleHierarchy(right, left))[0];
}

const SEND_DEPENDENT_PERMISSIONS =
  Permissions.SEND_TTS_MESSAGES |
  Permissions.MENTION_EVERYONE |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.SEND_VOICE_MESSAGES |
  Permissions.SEND_POLLS;

const VOICE_DEPENDENT_PERMISSIONS =
  Permissions.SPEAK |
  Permissions.STREAM |
  Permissions.USE_VAD |
  Permissions.PRIORITY_SPEAKER |
  Permissions.REQUEST_TO_SPEAK |
  Permissions.USE_SOUNDBOARD |
  Permissions.USE_EXTERNAL_SOUNDS;

const CHANNEL_DEPENDENT_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.SEND_TTS_MESSAGES |
  Permissions.MANAGE_MESSAGES |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.MENTION_EVERYONE |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.STREAM |
  Permissions.MUTE_MEMBERS |
  Permissions.DEAFEN_MEMBERS |
  Permissions.MOVE_MEMBERS |
  Permissions.USE_VAD |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_WEBHOOKS |
  Permissions.USE_APPLICATION_COMMANDS |
  Permissions.MANAGE_THREADS |
  Permissions.CREATE_PUBLIC_THREADS |
  Permissions.CREATE_PRIVATE_THREADS |
  Permissions.SEND_MESSAGES_IN_THREADS |
  Permissions.SEND_VOICE_MESSAGES |
  Permissions.SEND_POLLS;
