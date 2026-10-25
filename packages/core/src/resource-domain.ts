import { isDeepStrictEqual } from 'node:util';

import type { ResourceRecord } from './contracts.js';
import type { GatewayEmulator } from './gateway.js';
import { cloneInteractionPayload } from './interaction-message-domain.js';
import { DiscordApiError } from './interactions.js';
import {
  calculatePermissions,
  canManageMember,
  canManageRole,
  Permissions,
  type PermissionMember,
  type PermissionOverwrite,
  type PermissionRole,
} from './permissions.js';
import type { VirtualState } from './state.js';

export interface ResourceDomainOptions {
  readonly state: VirtualState;
  readonly gateway: GatewayEmulator;
  readonly botUserId?: string;
  readonly enforcePermissions?: boolean;
}
export interface ResourceDomainCommand {
  readonly kind: 'channel' | 'role' | 'member';
  readonly operation: 'create' | 'update' | 'delete';
  readonly guildId: string;
  /** Channel/role ID, or the user's ID for member operations. */
  readonly resourceId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
interface Authority {
  readonly member: PermissionMember;
  readonly roles: readonly PermissionRole[];
  readonly ownerId: string;
  readonly effective: bigint;
}
interface ResourceEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}
const active = new WeakSet<VirtualState>();
const MAX_UINT64 = 18_446_744_073_709_551_615n;

/** Supported fixture REST writes share one transaction and explicit Gateway projections. */
export class ResourceDomainService {
  readonly #state: VirtualState;
  readonly #gateway: GatewayEmulator;
  readonly #botUserId: string;
  readonly #enforce: boolean;

  public constructor(options: ResourceDomainOptions) {
    this.#state = options.state;
    this.#gateway = options.gateway;
    this.#botUserId = options.botUserId ?? options.gateway.botUserId;
    if (this.#botUserId !== options.gateway.botUserId)
      throw new TypeError('Resource actor must match the Gateway bot identity.');
    this.#enforce = options.enforcePermissions ?? false;
  }

  public get(
    kind: 'guild' | 'channel' | 'role' | 'member',
    resourceId: string,
    guildId?: string,
  ): Readonly<Record<string, unknown>> {
    snowflake(resourceId);
    if (kind === 'guild') {
      const guild = this.#guild(resourceId);
      this.#authorize(resourceId, 0n);
      return {
        ...pick(guild, ['id', 'name', 'owner_id', 'icon', 'description', 'preferred_locale']),
        icon: guild['icon'] ?? null,
        features: Array.isArray(guild['features']) ? structuredClone(guild['features']) : [],
        roles: this.list('role', resourceId),
        emojis: [],
        stickers: [],
        member_count: this.#state
          .list('member')
          .filter((member) => member['guild_id'] === resourceId).length,
      };
    }
    if (kind === 'channel') {
      const channel = this.#rawChannel(resourceId);
      if (guildId !== undefined && channel['guild_id'] !== guildId) unknown('channel');
      if (channel['type'] === 1 && channel['guild_id'] === undefined)
        return this.#channelWire(channel);
      if (typeof channel['guild_id'] !== 'string') invalid();
      this.#authorize(channel['guild_id'], Permissions.VIEW_CHANNEL, channel);
      return this.#channelWire(channel);
    }
    if (guildId === undefined) invalid();
    this.#guild(guildId);
    this.#authorize(guildId, 0n);
    return kind === 'role'
      ? this.#roleWire(this.#rawRole(guildId, resourceId))
      : this.#memberWire(this.#rawMember(guildId, resourceId));
  }

  public list(
    kind: 'channel' | 'role' | 'member',
    guildId: string,
  ): readonly Readonly<Record<string, unknown>>[] {
    this.#guild(guildId);
    this.#authorize(guildId, 0n);
    const resources = this.#state.list(kind).filter((resource) => resource['guild_id'] === guildId);
    if (kind === 'channel') {
      return resources.flatMap((channel) => {
        try {
          this.#authorize(guildId, Permissions.VIEW_CHANNEL, channel);
          return [this.#channelWire(channel)];
        } catch (error) {
          if (error instanceof DiscordApiError && error.status === 403) return [];
          throw error;
        }
      });
    }
    return resources.map((resource) =>
      kind === 'role' ? this.#roleWire(resource) : this.#memberWire(resource),
    );
  }

  public execute(command: ResourceDomainCommand): ResourceRecord | null {
    if (active.has(this.#state) || this.#state.transactionActive)
      throw new DiscordApiError(409, 0, 'Resource commands require an outermost transaction.');
    this.#guild(command.guildId);
    const data = input(command.data ?? {});
    if (command.operation !== 'create' && command.resourceId === undefined) invalid();
    if (command.resourceId !== undefined) snowflake(command.resourceId);
    if (command.operation === 'delete' && Object.keys(data).length !== 0) invalid();
    if (command.operation === 'create' && command.resourceId !== undefined) invalid();
    active.add(this.#state);
    const events: ResourceEvent[] = [];
    try {
      const result = this.#state.transaction(
        'resource:' + command.kind + ':' + command.operation,
        () => {
          let resource: ResourceRecord | null;
          if (command.kind === 'channel') resource = this.#channel(command, data, events);
          else if (command.kind === 'role') resource = this.#role(command, data, events);
          else if (command.kind === 'member' && command.operation === 'update')
            resource = this.#member(command, data, events);
          else unsupported();
          for (const event of events) this.#gateway.preflightBroadcast(event.name, event.data);
          return resource;
        },
      );
      for (const event of events) this.#gateway.broadcast(event.name, event.data);
      return result;
    } catch (error) {
      if (error instanceof DiscordApiError) throw error;
      throw new DiscordApiError(503, 0, 'Resource state could not be changed.');
    } finally {
      active.delete(this.#state);
    }
  }

  #channel(
    command: ResourceDomainCommand,
    data: Record<string, unknown>,
    events: ResourceEvent[],
  ): ResourceRecord | null {
    keys(data, [
      'name',
      'type',
      'topic',
      'nsfw',
      'position',
      'parent_id',
      'rate_limit_per_user',
      'permission_overwrites',
    ]);
    const current =
      command.operation === 'create' ? undefined : this.#rawChannel(command.resourceId!);
    if (current !== undefined && current['guild_id'] !== command.guildId) unknown('channel');
    if (current !== undefined && current['type'] !== 0) unsupported();
    const authority = this.#authorize(command.guildId, Permissions.MANAGE_CHANNELS, current);
    if (data['type'] !== undefined && data['type'] !== 0) unsupported();
    const changes: Record<string, unknown> = {};
    if ('name' in data) changes['name'] = text(data['name'], 1, 100);
    if ('type' in data) changes['type'] = 0;
    if ('topic' in data)
      changes['topic'] = data['topic'] === null ? null : text(data['topic'], 0, 1024);
    if ('nsfw' in data) changes['nsfw'] = boolean(data['nsfw']);
    if ('position' in data) changes['position'] = integer(data['position'], 0, 10000);
    if ('rate_limit_per_user' in data)
      changes['rate_limit_per_user'] = integer(data['rate_limit_per_user'], 0, 21600);
    if ('parent_id' in data) {
      if (data['parent_id'] !== null) {
        const parent = this.#rawChannel(snowflake(data['parent_id']));
        if (parent['guild_id'] !== command.guildId || parent['type'] !== 4) invalid();
      }
      changes['parent_id'] = data['parent_id'];
    }
    if ('permission_overwrites' in data) {
      const overwrites = this.#overwrites(command.guildId, data['permission_overwrites']);
      if (current !== undefined || overwrites.length > 0)
        this.#authorize(command.guildId, Permissions.MANAGE_ROLES, current);
      if (authority !== undefined) {
        for (const overwrite of overwrites) {
          if (((BigInt(overwrite.allow) | BigInt(overwrite.deny)) & ~authority.effective) !== 0n)
            missing();
        }
      }
      changes['permission_overwrites'] = overwrites;
    }
    if (command.operation === 'delete') {
      for (const message of this.#state.list('message')) {
        if (message['channel_id'] === current!.id) this.#state.delete('message', message.id);
      }
      this.#state.delete('channel', current!.id);
      events.push({ name: 'CHANNEL_DELETE', data: this.#channelWire(current!) });
      return null;
    }
    if (current !== undefined && unchanged(current, changes)) return current;
    const resource =
      current === undefined
        ? this.#state.create('channel', {
            guild_id: command.guildId,
            type: 0,
            name: text(data['name'], 1, 100),
            position: 0,
            topic: null,
            parent_id: null,
            nsfw: false,
            rate_limit_per_user: 0,
            permission_overwrites: [],
            ...changes,
          })
        : this.#state.update('channel', current.id, changes);
    events.push({
      name: current === undefined ? 'CHANNEL_CREATE' : 'CHANNEL_UPDATE',
      data: this.#channelWire(resource),
    });
    return resource;
  }

  #role(
    command: ResourceDomainCommand,
    data: Record<string, unknown>,
    events: ResourceEvent[],
  ): ResourceRecord | null {
    keys(data, [
      'name',
      'permissions',
      'color',
      'colors',
      'hoist',
      'mentionable',
      'icon',
      'unicode_emoji',
    ]);
    const authority = this.#authorize(command.guildId, Permissions.MANAGE_ROLES);
    const current =
      command.operation === 'create'
        ? undefined
        : this.#rawRole(command.guildId, command.resourceId!);
    if (current !== undefined) {
      if (current['managed'] === true) missing();
      if (
        current.id === command.guildId &&
        (command.operation === 'delete' || Object.keys(data).some((key) => key !== 'permissions'))
      )
        invalid();
      this.#roleHierarchy(current, authority);
    }
    const changes: Record<string, unknown> = {};
    if ('name' in data) {
      changes['name'] = text(data['name'], 1, 100);
      if (changes['name'] === '@everyone') invalid();
    }
    if ('permissions' in data) {
      const permissions = bits(data['permissions']);
      if (authority !== undefined && (BigInt(permissions) & ~authority.effective) !== 0n) missing();
      changes['permissions'] = permissions;
    }
    for (const key of ['hoist', 'mentionable']) if (key in data) changes[key] = boolean(data[key]);
    if ('color' in data) changes['color'] = integer(data['color'], 0, 16_777_215);
    if ('colors' in data) {
      const colors = input(data['colors']);
      keys(colors, ['primary_color', 'secondary_color', 'tertiary_color']);
      if (colors['secondary_color'] != null || colors['tertiary_color'] != null) unsupported();
      const color = integer(colors['primary_color'], 0, 16_777_215);
      if ('color' in changes && changes['color'] !== color) invalid();
      changes['color'] = color;
    }
    if ('icon' in data && data['icon'] !== null) unsupported();
    if ('unicode_emoji' in data && data['unicode_emoji'] !== null) unsupported();
    if ('icon' in data) changes['icon'] = null;
    if ('unicode_emoji' in data) changes['unicode_emoji'] = null;
    if ('color' in changes)
      changes['colors'] = {
        primary_color: changes['color'],
        secondary_color: null,
        tertiary_color: null,
      };
    if (command.operation === 'delete') {
      this.#state.delete('role', current!.id);
      events.push({
        name: 'GUILD_ROLE_DELETE',
        data: { guild_id: command.guildId, role_id: current!.id },
      });
      for (const member of this.#state
        .list('member')
        .filter((item) => item['guild_id'] === command.guildId)) {
        const roles = this.#roleIds(command.guildId, member['roles'], current!.id);
        if (!roles.includes(current!.id)) continue;
        const updated = this.#state.update('member', member.id, {
          roles: roles.filter((id) => id !== current!.id),
        });
        events.push({
          name: 'GUILD_MEMBER_UPDATE',
          data: { guild_id: command.guildId, ...this.#memberWire(updated) },
        });
      }
      for (const channel of this.#state
        .list('channel')
        .filter((item) => item['guild_id'] === command.guildId)) {
        const overwrites = this.#overwrites(
          command.guildId,
          channel['permission_overwrites'] ?? [],
          current!.id,
        );
        const filtered = overwrites.filter(
          (overwrite) => !(overwrite.type === 0 && overwrite.id === current!.id),
        );
        if (filtered.length === overwrites.length) continue;
        const updated = this.#state.update('channel', channel.id, {
          permission_overwrites: filtered,
        });
        events.push({ name: 'CHANNEL_UPDATE', data: this.#channelWire(updated) });
      }
      return null;
    }
    if (current !== undefined && unchanged(current, changes)) return current;
    const resource =
      current === undefined
        ? this.#state.create('role', {
            guild_id: command.guildId,
            name: 'new role',
            permissions: '0',
            position: 1,
            color: 0,
            hoist: false,
            mentionable: false,
            managed: false,
            flags: 0,
            ...changes,
          })
        : this.#state.update('role', current.id, changes);
    this.#roleHierarchy(resource, authority);
    events.push({
      name: current === undefined ? 'GUILD_ROLE_CREATE' : 'GUILD_ROLE_UPDATE',
      data: { guild_id: command.guildId, role: this.#roleWire(resource) },
    });
    return resource;
  }

  #member(
    command: ResourceDomainCommand,
    data: Record<string, unknown>,
    events: ResourceEvent[],
  ): ResourceRecord {
    keys(data, ['nick', 'roles']);
    const current = this.#rawMember(command.guildId, command.resourceId!);
    let requested = 0n;
    if ('roles' in data) requested |= Permissions.MANAGE_ROLES;
    if ('nick' in data)
      requested |=
        command.resourceId === this.#botUserId
          ? Permissions.CHANGE_NICKNAME
          : Permissions.MANAGE_NICKNAMES;
    const authority = this.#authorize(command.guildId, requested);
    if (
      authority !== undefined &&
      'nick' in data &&
      command.resourceId !== this.#botUserId &&
      !canManageMember(
        authority.member,
        { id: command.resourceId!, roleIds: this.#roleIds(command.guildId, current['roles']) },
        authority.roles,
        authority.ownerId,
      ).allowed
    )
      missing();
    const changes: Record<string, unknown> = {};
    if ('nick' in data) changes['nick'] = data['nick'] === null ? null : text(data['nick'], 1, 32);
    if ('roles' in data) {
      const roles = this.#roleIds(command.guildId, data['roles']);
      const previous = this.#roleIds(command.guildId, current['roles']);
      for (const id of new Set([...previous, ...roles])) {
        if (previous.includes(id) === roles.includes(id)) continue;
        const role = this.#rawRole(command.guildId, id);
        if (role['managed'] === true) missing();
        this.#roleHierarchy(role, authority);
      }
      changes['roles'] = roles;
    }
    if (unchanged(current, changes)) return current;
    const updated = this.#state.update('member', current.id, changes);
    events.push({
      name: 'GUILD_MEMBER_UPDATE',
      data: { guild_id: command.guildId, ...this.#memberWire(updated) },
    });
    return updated;
  }

  #authorize(guildId: string, requested: bigint, channel?: ResourceRecord): Authority | undefined {
    if (!this.#enforce) return undefined;
    const guild = this.#guild(guildId);
    const ownerId = snowflake(guild['owner_id']);
    const user = this.#state.get('user', this.#botUserId);
    if (user?.['bot'] !== true) missing();
    let rawMember: ResourceRecord;
    try {
      rawMember = this.#rawMember(guildId, this.#botUserId);
    } catch {
      missing();
    }
    const member: PermissionMember = {
      id: this.#botUserId,
      roleIds: this.#roleIds(guildId, rawMember['roles']),
    };
    const until = rawMember['communication_disabled_until'];
    if (until !== undefined && until !== null) {
      if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) invalid();
      (member as { timedOutUntilMs?: number }).timedOutUntilMs = Date.parse(until);
    }
    const roles = this.#state
      .list('role')
      .filter((role) => role['guild_id'] === guildId)
      .map((role) => ({
        id: snowflake(role.id),
        permissions: bits(role['permissions']),
        position: integer(role['position'] ?? 0, 0, 10000),
      }));
    if (!roles.some((role) => role.id === guildId)) missing();
    const overwrites =
      channel === undefined
        ? undefined
        : this.#overwrites(guildId, channel['permission_overwrites'] ?? []);
    const decision = calculatePermissions({
      guildId,
      ownerId,
      member,
      roles,
      requested,
      nowMs: this.#state.now(),
      ...(channel === undefined
        ? {}
        : {
            channel: {
              id: channel.id,
              overwrites: overwrites!.map((overwrite): PermissionOverwrite => ({
                id: overwrite.id,
                type: overwrite.type === 0 ? 'role' : 'member',
                allow: overwrite.allow,
                deny: overwrite.deny,
              })),
            },
          }),
    });
    if (!decision.allowed) missing();
    return { member, roles, ownerId, effective: decision.effective };
  }

  #roleHierarchy(role: ResourceRecord, authority: Authority | undefined): void {
    if (authority === undefined) return;
    if (
      !canManageRole(
        authority.member,
        {
          id: role.id,
          permissions: bits(role['permissions']),
          position: integer(role['position'] ?? 0, 0, 10000),
        },
        authority.roles,
        authority.ownerId,
      ).allowed
    )
      missing();
  }

  #guild(id: string): ResourceRecord {
    snowflake(id);
    const guild = this.#state.get('guild', id);
    if (guild === undefined) unknown('guild');
    return guild;
  }
  #rawChannel(id: string): ResourceRecord {
    snowflake(id);
    const channel = this.#state.get('channel', id);
    if (channel === undefined) unknown('channel');
    return channel;
  }
  #rawRole(guildId: string, id: string): ResourceRecord {
    snowflake(id);
    const role = this.#state.get('role', id);
    if (role === undefined || role['guild_id'] !== guildId) unknown('role');
    if (role['managed'] !== undefined && typeof role['managed'] !== 'boolean') invalid();
    return role;
  }
  #rawMember(guildId: string, userId: string): ResourceRecord {
    snowflake(userId);
    const members = this.#state
      .list('member')
      .filter(
        (member) => member['guild_id'] === guildId && (member['user_id'] ?? member.id) === userId,
      );
    if (members.length !== 1) unknown('member');
    return members[0]!;
  }
  #roleIds(guildId: string, value: unknown, deleting?: string): string[] {
    if (!Array.isArray(value) || value.length > 250) invalid();
    const ids = (value as unknown[]).map(snowflake);
    if (new Set(ids).size !== ids.length || ids.includes(guildId)) invalid();
    for (const id of ids) if (id !== deleting) this.#rawRole(guildId, id);
    return ids;
  }
  #overwrites(
    guildId: string,
    value: unknown,
    deleting?: string,
  ): { id: string; type: 0 | 1; allow: string; deny: string }[] {
    if (!Array.isArray(value) || value.length > 1000) invalid();
    const seen = new Set<string>();
    return (value as unknown[]).map((entry) => {
      const overwrite = input(entry);
      keys(overwrite, ['id', 'type', 'allow', 'deny']);
      const id = snowflake(overwrite['id']);
      const type = overwrite['type'];
      if (type !== 0 && type !== 1) invalid();
      if (type === 0 && id !== deleting) this.#rawRole(guildId, id);
      if (type === 1) this.#rawMember(guildId, id);
      const key = type + ':' + id;
      if (seen.has(key)) invalid();
      seen.add(key);
      return { id, type, allow: bits(overwrite['allow']), deny: bits(overwrite['deny']) };
    });
  }
  #channelWire(channel: ResourceRecord): Readonly<Record<string, unknown>> {
    const result = pick(channel, [
      'id',
      'type',
      'guild_id',
      'name',
      'topic',
      'position',
      'parent_id',
      'nsfw',
      'rate_limit_per_user',
      'permission_overwrites',
      'last_message_id',
      'recipients',
      'bitrate',
      'user_limit',
    ]);
    if (channel['type'] !== 1) {
      result['permission_overwrites'] ??= [];
      result['position'] ??= 0;
      result['parent_id'] ??= null;
      result['topic'] ??= null;
      result['nsfw'] ??= false;
      result['rate_limit_per_user'] ??= 0;
    }
    return result;
  }
  #roleWire(role: ResourceRecord): Readonly<Record<string, unknown>> {
    const color = integer(role['color'] ?? 0, 0, 16_777_215);
    return {
      id: role.id,
      name: text(role['name'], 1, 100),
      permissions: bits(role['permissions']),
      position: integer(role['position'] ?? 0, 0, 10000),
      color,
      colors: { primary_color: color, secondary_color: null, tertiary_color: null },
      hoist: role['hoist'] === true,
      managed: role['managed'] === true,
      mentionable: role['mentionable'] === true,
      flags: integer(role['flags'] ?? 0, 0, Number.MAX_SAFE_INTEGER),
      icon: null,
      unicode_emoji: null,
    };
  }
  #memberWire(member: ResourceRecord): Readonly<Record<string, unknown>> {
    const id = snowflake(member['user_id'] ?? member.id);
    const user = this.#state.get('user', id);
    if (user === undefined) unknown('user');
    return {
      user: {
        id,
        username: text(user['username'], 1, 100),
        discriminator: user['discriminator'] ?? '0',
        avatar: user['avatar'] ?? null,
        bot: user['bot'] === true,
        ...(user['global_name'] === undefined ? {} : { global_name: user['global_name'] }),
      },
      roles: this.#roleIds(snowflake(member['guild_id']), member['roles']),
      nick: member['nick'] ?? null,
      joined_at: member['joined_at'] ?? '2015-01-01T00:00:00.000Z',
      deaf: member['deaf'] === true,
      mute: member['mute'] === true,
      pending: member['pending'] === true,
      flags: integer(member['flags'] ?? 0, 0, Number.MAX_SAFE_INTEGER),
      communication_disabled_until: member['communication_disabled_until'] ?? null,
    };
  }
}

function input(value: unknown): Record<string, unknown> {
  let cloned: unknown;
  try {
    cloned = cloneInteractionPayload(value, 1_048_576);
  } catch {
    invalid();
  }
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) invalid();
  return cloned as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported();
}
function snowflake(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_UINT64)
    invalid();
  return value;
}
function bits(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > MAX_UINT64
  )
    invalid();
  return value;
}
function text(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  )
    invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function pick(resource: ResourceRecord, names: readonly string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const name of names)
    if (Object.hasOwn(resource, name)) selected[name] = structuredClone(resource[name]);
  return selected;
}
function unchanged(resource: ResourceRecord, changes: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(changes).every(([key, value]) => isDeepStrictEqual(resource[key], value));
}
function invalid(): never {
  throw new DiscordApiError(400, 50035, 'Invalid guild resource payload.');
}
function missing(): never {
  throw new DiscordApiError(403, 50013, 'Missing Permissions');
}
function unsupported(): never {
  throw new DiscordApiError(501, 0, 'Unsupported guild resource operation or field.');
}
function unknown(kind: 'guild' | 'channel' | 'role' | 'member' | 'user'): never {
  const code = { guild: 10004, channel: 10003, role: 10011, member: 10007, user: 10013 }[kind];
  throw new DiscordApiError(404, code, 'Unknown ' + kind + '.');
}
