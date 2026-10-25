import { calculatePermissions, Permissions } from '@disrunner/core';

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}
/** Viewer permissions are computed from the same retained resources as mutations. */
export function canViewChannel(
  resources: readonly Readonly<Record<string, unknown>>[],
  actorId: string,
  channel: Readonly<Record<string, unknown>>,
  nowMs: number,
): boolean {
  if (channel['type'] === 1 && channel['guild_id'] === undefined)
    return records(channel['recipients']).some((user) => user['id'] === actorId);
  if (channel['type'] !== 0 || typeof channel['guild_id'] !== 'string') return false;
  const guildId = channel['guild_id'];
  const guild = resources.find((r) => r['resourceType'] === 'guild' && r['id'] === guildId);
  if (!guild) return false;
  if (guild['owner_id'] === actorId) return true;
  const member = resources.find(
    (r) =>
      r['resourceType'] === 'member' &&
      r['guild_id'] === guildId &&
      (r['user_id'] === actorId || r['id'] === actorId),
  );
  if (
    !member ||
    !Array.isArray(member['roles']) ||
    !member['roles'].every((r) => typeof r === 'string')
  )
    return false;
  const rawRoles = resources.filter(
    (r) => r['resourceType'] === 'role' && r['guild_id'] === guildId,
  );
  if (rawRoles.some((r) => typeof r['permissions'] !== 'string' || !/^\d+$/.test(r['permissions'])))
    return false;
  const roles = rawRoles.map((r) => ({
    id: String(r['id']),
    position: typeof r['position'] === 'number' ? r['position'] : 0,
    permissions: r['permissions'] as string,
  }));
  try {
    return calculatePermissions({
      guildId,
      ownerId: typeof guild['owner_id'] === 'string' ? guild['owner_id'] : '',
      member: { id: actorId, roleIds: member['roles'] },
      roles,
      channel: {
        id: String(channel['id']),
        overwrites: records(channel['permission_overwrites']).map((o) => ({
          id: typeof o['id'] === 'string' ? o['id'] : '',
          type: o['type'] === 0 ? ('role' as const) : ('member' as const),
          allow: typeof o['allow'] === 'string' ? o['allow'] : '0',
          deny: typeof o['deny'] === 'string' ? o['deny'] : '0',
        })),
      },
      requested: Permissions.VIEW_CHANNEL,
      nowMs,
    }).allowed;
  } catch {
    return false;
  }
}
