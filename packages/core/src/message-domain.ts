import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { BootstrapUser } from './bootstrap-profile.js';
import type { ResourceRecord, SimulationMode } from './contracts.js';
import type { GatewayEmulator } from './gateway.js';
import { sanitizeForExport } from './export-sanitizer.js';
import { DiscordApiError } from './interactions.js';
import {
  isOrdinaryMessage,
  mapMessageEvent,
  projectMessageWire,
  type MessageDomainEvent,
  type MessageEventName,
} from './message-events.js';
import { assertValidMessagePayload } from './protocol-limits.js';
import { ResourceNotFoundError, type VirtualState } from './state.js';

export interface MessageDomainContext {
  readonly runId: string;
  readonly clockDomain?: 'virtual' | 'realtime';
}
export interface MessageDelivery {
  readonly status: 'accepted' | 'partial' | 'unchanged';
  readonly accepted: number;
  readonly filtered: number;
  readonly failed: number;
  readonly transportFailed: number;
}
export interface MessageMutationResult {
  readonly message: ResourceRecord;
  readonly stateRevision: number;
  readonly eventId: string | null;
  readonly delivery: MessageDelivery;
}
export interface MessageDomainOptions {
  readonly state: VirtualState;
  readonly gateway: GatewayEmulator;
  readonly author?: BootstrapUser;
  readonly context?: MessageDomainContext;
  readonly mode?: SimulationMode;
}

const activeStates = new WeakSet<VirtualState>();
const MAX_EVENT_BYTES = 1_048_576;

/** Ordinary channel messages only. No generic store-change or interaction-event bridge. */
export class MessageDomainService {
  readonly #state: VirtualState;
  readonly #gateway: GatewayEmulator;
  readonly #author: BootstrapUser | undefined;
  readonly #context: Required<MessageDomainContext>;
  readonly #mode: SimulationMode;
  #sequence = 0;
  #recordBytes = 0;
  #records: { event: MessageDomainEvent; delivery: MessageDelivery; bytes: number }[] = [];
  #dropped = 0;

  public constructor(options: MessageDomainOptions) {
    this.#state = options.state;
    this.#gateway = options.gateway;
    this.#author = options.author === undefined ? undefined : structuredClone(options.author);
    const runId = options.context?.runId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new TypeError('Invalid message-domain runId.');
    this.#context = { runId, clockDomain: options.context?.clockDomain ?? 'virtual' };
    this.#mode = options.mode ?? 'strict';
  }

  public evidence(): {
    readonly records: readonly { event: MessageDomainEvent; delivery: MessageDelivery }[];
    readonly dropped: number;
  } {
    return {
      records: this.#records.map(({ event, delivery }) => structuredClone({ event, delivery })),
      dropped: this.#dropped,
    };
  }

  public create(
    channelId: string,
    payload: Readonly<Record<string, unknown>>,
  ): MessageMutationResult {
    return this.#execute('MESSAGE_CREATE', channelId, undefined, payload);
  }
  public update(
    channelId: string,
    messageId: string,
    payload: Readonly<Record<string, unknown>>,
  ): MessageMutationResult {
    return this.#execute('MESSAGE_UPDATE', channelId, messageId, payload);
  }
  public delete(channelId: string, messageId: string): MessageMutationResult {
    return this.#execute('MESSAGE_DELETE', channelId, messageId, {});
  }

  #revision(): number {
    const revision: unknown = (this.#state as VirtualState & { readonly revision?: unknown })
      .revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
      throw new DiscordApiError(503, 0, 'Revisioned message state is unavailable.');
    return revision;
  }

  #execute(
    type: MessageEventName,
    channelId: string,
    messageId: string | undefined,
    payload: Readonly<Record<string, unknown>>,
  ): MessageMutationResult {
    if (activeStates.has(this.#state))
      throw new DiscordApiError(409, 0, 'Reentrant message commands are not supported.');
    activeStates.add(this.#state);
    try {
      const transactionActive: unknown = (
        this.#state as VirtualState & { readonly transactionActive?: unknown }
      ).transactionActive;
      if (typeof transactionActive !== 'boolean')
        throw new DiscordApiError(503, 0, 'Outermost message transaction guard is unavailable.');
      if (transactionActive)
        throw new DiscordApiError(409, 0, 'Message commands require an outermost transaction.');
      const beforeRevision = this.#revision();
      if (beforeRevision >= Number.MAX_SAFE_INTEGER || this.#sequence >= Number.MAX_SAFE_INTEGER)
        throw new DiscordApiError(503, 0, 'Message revision or sequence capacity exceeded.');
      const channel = this.#state.require('channel', channelId);
      let guildId: string | undefined;
      if (channel['type'] === 0 && typeof channel['guild_id'] === 'string') {
        guildId = this.#state.require('guild', channel['guild_id']).id;
      } else if (channel['type'] !== 1 || channel['guild_id'] !== undefined) {
        throw new DiscordApiError(
          400,
          50035,
          'Only explicit guild text and DM channels are supported.',
        );
      }
      const rawAuthor = this.#author ?? this.#state.require('user', this.#gateway.botUserId);
      if (rawAuthor.id !== this.#gateway.botUserId || rawAuthor.bot !== true)
        throw new DiscordApiError(
          403,
          50013,
          'Message actor does not match the authenticated bot.',
        );
      const author = projectAuthor(rawAuthor);
      const current =
        messageId === undefined ? undefined : this.#state.require('message', messageId);
      if (current !== undefined) {
        if (current['channel_id'] !== channelId || current['guild_id'] !== guildId)
          throw new ResourceNotFoundError('message', messageId as string);
        const owner = current['author'];
        if (!isRecord(owner) || owner['id'] !== author['id'])
          throw new DiscordApiError(
            403,
            50005,
            'Only messages authored by this bot can be changed.',
          );
        if (!isOrdinaryMessage(current))
          throw new DiscordApiError(
            403,
            50013,
            'Message visibility is not supported by this route.',
          );
      }
      const changes =
        type === 'MESSAGE_DELETE'
          ? {}
          : validatePayload(payload, this.#mode, type === 'MESSAGE_UPDATE');
      if (
        current !== undefined &&
        type === 'MESSAGE_UPDATE' &&
        Object.entries(changes).every(([key, value]) => isDeepStrictEqual(current[key], value))
      ) {
        return {
          message: current,
          stateRevision: beforeRevision,
          eventId: null,
          delivery: {
            status: 'unchanged',
            accepted: 0,
            filtered: 0,
            failed: 0,
            transportFailed: 0,
          },
        };
      }
      const timestamp = this.#state.now();
      const requestId = randomUUID();
      let projection: ReturnType<typeof mapMessageEvent>;
      const eventBase = {
        schemaVersion: 1 as const,
        runId: this.#context.runId,
        eventId: randomUUID(),
        sequence: this.#sequence + 1,
        stateRevision: beforeRevision + 1,
        correlationId: requestId,
        causationId: requestId,
        origin: 'rest' as const,
        clockDomain: this.#context.clockDomain,
        timestamp,
      };
      const message = this.#state.transaction(`ordinary-message:${type}`, () => {
        let result: ResourceRecord;
        if (type === 'MESSAGE_CREATE') {
          result = this.#state.create('message', {
            content: '',
            embeds: [],
            attachments: [],
            components: [],
            flags: 0,
            tts: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            pinned: false,
            type: 0,
            ...changes,
            channel_id: channelId,
            ...(guildId === undefined ? {} : { guild_id: guildId }),
            author,
            visibility: 'channel',
            timestamp: new Date(timestamp).toISOString(),
            edited_timestamp: null,
          });
        } else if (type === 'MESSAGE_UPDATE') {
          result = this.#state.update('message', messageId as string, {
            ...changes,
            edited_timestamp: new Date(timestamp).toISOString(),
          });
        } else {
          result = current as ResourceRecord;
          this.#state.delete('message', messageId as string);
        }
        projection = mapMessageEvent({
          ...eventBase,
          payload: { type, message: result, visibility: 'channel' },
        });
        if (projection === undefined)
          throw new DiscordApiError(400, 50035, 'Message visibility is unsupported.');
        this.#gateway.preflightBroadcast(projection.eventName, projection.data);
        return result;
      });
      // The state contract is authoritative. No fabricated per-service state revision.
      const stateRevision = this.#revision();
      this.#sequence += 1;
      const event: MessageDomainEvent = {
        ...eventBase,
        stateRevision,
        payload: {
          type,
          message: {
            ...projectMessageWire(message),
            id: message.id,
            resourceType: 'message',
            visibility: 'channel',
          },
          visibility: 'channel',
        },
      };
      let delivery: MessageDelivery;
      try {
        const mapped = projection!;
        if (mapped === undefined) throw new Error('Missing committed message projection.');
        const counts = this.#gateway.broadcast(mapped.eventName, mapped.data);
        delivery = {
          ...counts,
          status: counts.failed + counts.transportFailed === 0 ? 'accepted' : 'partial',
        };
      } catch {
        // A committed mutation must never be converted into a retryable REST mutation error.
        delivery = { status: 'partial', accepted: 0, filtered: 0, failed: 1, transportFailed: 0 };
      }
      // Diagnostic evidence is redacted and bounded independently of replay history.
      try {
        const safe = sanitizeForExport(
          { event, delivery },
          { sensitiveValues: [this.#gateway.sessionToken] },
        );
        const bytes = Buffer.byteLength(JSON.stringify(safe));
        if (bytes > MAX_EVENT_BYTES) this.#dropped += 1;
        else {
          while (this.#records.length >= 100 || this.#recordBytes + bytes > MAX_EVENT_BYTES) {
            const removed = this.#records.shift();
            if (removed === undefined) break;
            this.#recordBytes -= removed.bytes;
            this.#dropped += 1;
          }
          this.#records.push({ ...safe, bytes });
          this.#recordBytes += bytes;
        }
      } catch {
        this.#dropped += 1;
      }
      return { message, stateRevision, eventId: event.eventId, delivery };
    } finally {
      activeStates.delete(this.#state);
    }
  }
}

function validatePayload(
  payload: Readonly<Record<string, unknown>>,
  mode: SimulationMode,
  partial: boolean,
): Readonly<Record<string, unknown>> {
  const allowed = ['content', 'embeds', 'components', 'attachments', 'flags', 'tts'];
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new DiscordApiError(400, 50035, 'Unsupported ordinary message field.');
  if (
    payload['flags'] !== undefined &&
    (typeof payload['flags'] !== 'number' ||
      !Number.isSafeInteger(payload['flags']) ||
      ![0, 4, 4096, 4100].includes(payload['flags']))
  )
    throw new DiscordApiError(400, 50035, 'Unsupported ordinary message flags.');
  if (payload['tts'] !== undefined && typeof payload['tts'] !== 'boolean')
    throw new DiscordApiError(400, 50035, 'tts must be boolean.');
  if (
    !partial &&
    mode === 'strict' &&
    payload['content'] === undefined &&
    payload['embeds'] === undefined &&
    payload['components'] === undefined
  )
    throw new DiscordApiError(400, 50006, 'Cannot send an empty message.');
  try {
    assertValidMessagePayload(payload, mode);
  } catch {
    throw new DiscordApiError(400, 50035, 'Invalid ordinary message payload.');
  }
  if (!isDeepStrictEqual(payload, projectMessageWire(payload)))
    throw new DiscordApiError(400, 50035, 'Unsupported nested ordinary message field.');
  return structuredClone(payload);
}
function projectAuthor(author: BootstrapUser | ResourceRecord): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = { id: author.id, bot: true };
  for (const key of ['username', 'discriminator', 'avatar']) {
    const value = (author as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' || value === null) result[key] = value;
  }
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
