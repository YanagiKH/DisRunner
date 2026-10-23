import { DiscordApiError } from './interactions.js';
import { StateConflictError, type VirtualState } from './state.js';
import {
  canonicalCommandId,
  commandError,
  commandRecord,
  inspectCommandData,
  parseCommandFields,
  parseCommandRegistryProfile,
  COMMAND_UINT64_MAX,
  type CommandFields,
  type CommandRegistryProfile,
} from './application-command-profile.js';

export interface CommandWire extends Readonly<Record<string, unknown>>, CommandFields {
  readonly id: string;
  readonly application_id: string;
  readonly version: string;
}
const active = new WeakSet<VirtualState>();
const resourceType = 'application-command';
const marker = 'command-registry-v1';
const key = (c: CommandFields): string => JSON.stringify([c.type, c.name]);
function wire(
  fields: CommandFields,
  id: string,
  version: string,
  app: string,
  guild?: string,
): CommandWire {
  return {
    id,
    type: fields.type,
    application_id: app,
    name: fields.name,
    description: fields.description,
    ...(fields.type === 1 ? { options: [] } : {}),
    default_member_permissions: null,
    nsfw: false,
    version,
    ...(guild === undefined
      ? { integration_types: [0], contexts: [0], dm_permission: false }
      : { guild_id: guild }),
  };
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((k) => Object.hasOwn(y, k) && equal(x[k], y[k]))
  );
}
/** Authoritative, opt-in registration only. Does not dispatch commands or Gateway events. */
export class ApplicationCommandRegistry {
  readonly #state: VirtualState;
  readonly #app: string;
  readonly #profile: CommandRegistryProfile;
  public constructor(state: VirtualState, applicationId: string, profile: CommandRegistryProfile) {
    if (!canonicalCommandId(applicationId)) throw commandError('payload');
    this.#state = state;
    this.#app = applicationId;
    this.#profile = parseCommandRegistryProfile(profile);
    for (const id of this.#profile.guildIds)
      if (state.get('guild', id) === undefined)
        throw new DiscordApiError(404, 10004, 'Unknown guild.');
  }
  public verifyScope(app: string, guild?: string): void {
    if (!canonicalCommandId(app) || (guild !== undefined && !canonicalCommandId(guild)))
      throw commandError('route');
    if (app !== this.#app || (guild !== undefined && !this.#profile.guildIds.includes(guild)))
      throw new DiscordApiError(403, 50001, 'Missing access.');
    if (guild !== undefined && this.#state.get('guild', guild) === undefined)
      throw new DiscordApiError(404, 10004, 'Unknown guild.');
  }
  public list(app: string, guild?: string): CommandWire[] {
    this.verifyScope(app, guild);
    const all: CommandWire[] = [];
    try {
      for (const raw of this.#state.list(resourceType)) {
        const record = commandRecord(raw);
        if (
          !canonicalCommandId(record['id']) ||
          !canonicalCommandId(record['application_id']) ||
          !canonicalCommandId(record['version']) ||
          ('guild_id' in record && !canonicalCommandId(record['guild_id'])) ||
          record['registry_profile'] !== marker ||
          record['resourceType'] !== resourceType
        )
          throw commandError('state');
        const rGuild = record['guild_id'] as string | undefined;
        const fields = parseCommandFields(
          { type: record['type'], name: record['name'], description: record['description'] },
          rGuild !== undefined,
        );
        const expected = wire(
          fields,
          record['id'],
          record['version'],
          record['application_id'],
          rGuild,
        );
        if (!equal(record, { ...expected, registry_profile: marker, resourceType }))
          throw commandError('state');
        if (record['application_id'] === app && rGuild === guild) all.push(expected);
      }
      if (new Set(all.map(key)).size !== all.length) throw commandError('state');
      this.#counts(all);
    } catch {
      throw commandError('state');
    }
    return all.sort(
      (a, b) =>
        a.type - b.type ||
        compareCodePoints(a.name, b.name) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
    );
  }
  public get(app: string, guild: string | undefined, id: string): CommandWire {
    if (!canonicalCommandId(id)) throw commandError('route');
    const result = this.list(app, guild).find((c) => c.id === id);
    if (!result) throw new DiscordApiError(404, 10063, 'Unknown application command.');
    return result;
  }
  public post(
    app: string,
    guild: string | undefined,
    input: unknown,
  ): { created: boolean; command: CommandWire } {
    return this.#mutate(() => {
      const old = this.list(app, guild),
        fields = parseCommandFields(input, guild !== undefined);
      const existing = old.find((c) => key(c) === key(fields));
      this.#counts(existing ? old : [...old, fields]);
      return { created: existing === undefined, command: this.#save(fields, existing, app, guild) };
    });
  }
  public patch(app: string, guild: string | undefined, id: string, input: unknown): CommandWire {
    return this.#mutate(() => {
      const current = this.get(app, guild, id),
        fields = parseCommandFields(input, guild !== undefined, current);
      if (this.list(app, guild).some((c) => c.id !== id && key(c) === key(fields)))
        throw commandError('payload');
      return this.#save(fields, current, app, guild);
    });
  }
  public delete(app: string, guild: string | undefined, id: string): void {
    this.#mutate(() => {
      this.get(app, guild, id);
      this.#state.delete(resourceType, id);
    });
  }
  public put(app: string, guild: string | undefined, input: unknown): CommandWire[] {
    return this.#mutate(() => {
      const old = this.list(app, guild);
      const data = inspectCommandData(input);
      if (!Array.isArray(data)) throw commandError('payload');
      if (data.length > 130) throw commandError('capacity');
      const fields = data.map((c) => parseCommandFields(c, guild !== undefined, undefined, true));
      this.#counts(fields);
      if (new Set(fields.map(key)).size !== fields.length) throw commandError('payload');
      const used = new Set<string>();
      const plan = fields.map((f) => {
        const current =
          f.id === undefined ? old.find((c) => key(c) === key(f)) : old.find((c) => c.id === f.id);
        if (f.id !== undefined && (!current || current.type !== f.type))
          throw commandError('payload');
        if (current) {
          if (used.has(current.id)) throw commandError('payload');
          used.add(current.id);
        }
        return { fields: f, current };
      });
      for (const c of old) if (!used.has(c.id)) this.#state.delete(resourceType, c.id);
      return plan.map((p) => this.#save(p.fields, p.current, app, guild));
    });
  }
  #counts(fields: readonly CommandFields[]): void {
    for (const [type, max] of [
      [1, 100],
      [2, 15],
      [3, 15],
    ] as const)
      if (fields.filter((c) => c.type === type).length > max) throw commandError('capacity');
  }
  #save(
    fields: CommandFields,
    old: CommandWire | undefined,
    app: string,
    guild: string | undefined,
  ): CommandWire {
    if (
      old &&
      old.type === fields.type &&
      old.name === fields.name &&
      old.description === fields.description
    )
      return wire(fields, old.id, old.version, app, guild);
    const anticipated = BigInt(this.#state.revision) + 1n;
    const version =
      old && BigInt(old.version) + 1n > anticipated ? BigInt(old.version) + 1n : anticipated;
    if (version > COMMAND_UINT64_MAX) throw commandError('capacity');
    const candidate = wire(fields, old?.id ?? '1', String(version), app, guild);
    if (Buffer.byteLength(JSON.stringify(candidate)) > 65536) throw commandError('capacity');
    if (old) {
      this.#state.update(resourceType, old.id, { ...candidate, registry_profile: marker });
      return candidate;
    }
    const data: Record<string, unknown> = { ...candidate, registry_profile: marker };
    delete data['id'];
    let created;
    try {
      created = this.#state.create(resourceType, data);
    } catch {
      throw commandError('capacity');
    }
    if (!canonicalCommandId(created.id)) throw commandError('capacity');
    return wire(fields, created.id, String(version), app, guild);
  }
  #mutate<T>(operation: () => T): T {
    if (active.has(this.#state) || this.#state.transactionActive) throw commandError('mutation');
    active.add(this.#state);
    let entered = false;
    try {
      return this.#state.transaction('application-command-registry', () => {
        entered = true;
        return operation();
      });
    } catch (error) {
      if (error instanceof DiscordApiError) throw error;
      if (error instanceof StateConflictError && !entered) throw commandError('mutation');
      throw commandError('capacity');
    } finally {
      active.delete(this.#state);
    }
  }
}
function compareCodePoints(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
