import type { ResourceRecord } from './contracts.js';
import { DiscordApiError } from './interactions.js';
import {
  calculatePermissions,
  Permissions,
  type PermissionOverwrite,
  type PermissionRole,
} from './permissions.js';
import type { VirtualState } from './state.js';

/** Core-only opt-in; omission preserves the legacy unenforced message routes. */
export type OrdinaryMessagePermissionProfile = 'legacy-unenforced' | 'guild-text-own-messages-v1';
type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';
export function parseOrdinaryMessagePermissionProfile(
  value: unknown,
): OrdinaryMessagePermissionProfile {
  if (value === undefined) return 'legacy-unenforced';
  if (value === 'legacy-unenforced' || value === 'guild-text-own-messages-v1') return value;
  throw new TypeError('Unsupported ordinary message permission profile.');
}

/** Resolves fresh authoritative state for each operation. Never stores a grant. */
export class OrdinaryMessagePolicy {
  public readonly profile: OrdinaryMessagePermissionProfile;
  public constructor(
    private readonly state: VirtualState,
    private readonly actorId: string,
    profile: unknown,
    private readonly author?: { readonly id: string; readonly bot?: boolean },
  ) {
    this.profile = parseOrdinaryMessagePermissionProfile(profile);
  }
  public authorize(
    channel: ResourceRecord,
    operation: Operation,
  ): { readonly history: boolean; readonly tts: boolean } {
    if (
      this.profile === 'legacy-unenforced' ||
      (channel['type'] === 1 && channel['guild_id'] === undefined)
    )
      return { history: true, tts: true };
    if (channel['type'] !== 0)
      throw new DiscordApiError(
        400,
        50035,
        'Only explicit guild text and DM channels are supported.',
      );
    const guildId = channel['guild_id'];
    if (!id(channel.id) || !id(guildId) || !id(this.actorId)) return missing();
    const guild = this.state.get('guild', guildId);
    const user = this.state.get('user', this.actorId);
    if (
      !guild ||
      !id(guild['owner_id']) ||
      !user ||
      user['bot'] !== true ||
      (this.author !== undefined && (this.author.id !== this.actorId || this.author.bot !== true))
    )
      return missing();
    const members = this.state
      .list('member')
      .filter((m) => m['guild_id'] === guildId && m['user_id'] === this.actorId);
    if (members.length !== 1) return missing();
    const member = members[0]!;
    if (!id(member.id)) return missing();
    const roleIds = member['roles'];
    if (
      !Array.isArray(roleIds) ||
      !roleIds.every(id) ||
      new Set(roleIds).size !== roleIds.length ||
      roleIds.includes(guildId)
    )
      return missing();
    const roles: PermissionRole[] = [];
    for (const role of this.state.list('role').filter((r) => r['guild_id'] === guildId)) {
      if (!id(role.id) || !bits(role['permissions'])) return missing();
      roles.push({ id: role.id, permissions: role['permissions'], position: 0 });
    }
    if (
      !roles.some((r) => r.id === guildId) ||
      !roleIds.every((r) => roles.some((role) => role.id === r))
    )
      return missing();
    const rawOverwrites = channel['permission_overwrites'];
    if (!Array.isArray(rawOverwrites)) return missing();
    const overwrites: PermissionOverwrite[] = [];
    const seen = new Set<string>();
    for (const overwrite of rawOverwrites) {
      if (
        !record(overwrite) ||
        !id(overwrite['id']) ||
        (overwrite['type'] !== 0 && overwrite['type'] !== 1) ||
        !bits(overwrite['allow']) ||
        !bits(overwrite['deny'])
      )
        return missing();
      const key = `${overwrite['type']}:${overwrite['id']}`;
      if (
        seen.has(key) ||
        (overwrite['type'] === 0 && !roles.some((r) => r.id === overwrite['id']))
      )
        return missing();
      seen.add(key);
      overwrites.push({
        id: overwrite['id'],
        type: overwrite['type'] === 0 ? 'role' : 'member',
        allow: overwrite['allow'],
        deny: overwrite['deny'],
      });
    }
    const until = member['communication_disabled_until'];
    let timeout: number | undefined;
    if (until !== undefined && until !== null) {
      if (typeof until !== 'string') return missing();
      timeout = Date.parse(until);
      if (!Number.isFinite(timeout) || new Date(timeout).toISOString() !== until) return missing();
    }
    const base = roles
      .filter((r) => r.id === guildId || roleIds.includes(r.id))
      .reduce((value, r) => value | BigInt(r.permissions), 0n);
    const exempt = guild['owner_id'] === this.actorId || (base & Permissions.ADMINISTRATOR) !== 0n;
    const activeTimeout = !exempt && timeout !== undefined && timeout > this.state.now();
    // This profile's admin timeout exemption intentionally does not alter the legacy calculator.
    const decision = calculatePermissions({
      guildId,
      ownerId: guild['owner_id'],
      member: {
        id: this.actorId,
        roleIds,
        ...(activeTimeout && timeout !== undefined ? { timedOutUntilMs: timeout } : {}),
      },
      roles,
      channel: { id: channel.id, overwrites },
      requested: Permissions.VIEW_CHANNEL,
      nowMs: this.state.now(),
    });
    const effective = decision.effective;
    let requested = Permissions.VIEW_CHANNEL;
    if (operation === 'get') requested |= Permissions.READ_MESSAGE_HISTORY;
    if (operation === 'create') requested |= Permissions.SEND_MESSAGES;
    if (
      (effective & requested) !== requested ||
      (activeTimeout && operation !== 'get' && operation !== 'list')
    )
      return missing();
    return {
      history: (effective & Permissions.READ_MESSAGE_HISTORY) !== 0n,
      tts: (effective & Permissions.SEND_TTS_MESSAGES) !== 0n,
    };
  }
}
export function missingOrdinaryMessagePermissions(): never {
  return missing();
}
function missing(): never {
  throw new DiscordApiError(403, 50013, 'Missing Permissions');
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
function bits(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
