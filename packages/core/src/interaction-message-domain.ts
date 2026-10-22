import { types as interactionUtilTypes } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { BootstrapUser } from './bootstrap-profile.js';
import type { ResourceRecord } from './contracts.js';
import type { GatewayEmulator } from './gateway.js';
import { DiscordApiError } from './interactions.js';
import { commitMessageSequence, nextMessageSequence } from './message-command-guard.js';
import {
  mapMessageEvent,
  recordMessageEvidence,
  type MessageDomainEvent,
  type MessageEventName,
} from './message-events.js';
import type {
  InteractionContext,
  InteractionResponseType,
  SimulatedInteraction,
} from './interactions.js';
import type { MessageDelivery, MessageDomainContext } from './message-domain.js';
import type { VirtualState } from './state.js';

export interface InteractionMessageAuthorityOptions {
  readonly state: VirtualState;
  readonly gateway: GatewayEmulator;
  readonly author: BootstrapUser;
  readonly context: MessageDomainContext;
}
export type InteractionMessageProfile = 'model' | 'chat-input-messages-v1';
export interface InteractionMessageSelection {
  readonly messageProfile?: InteractionMessageProfile;
}
export interface AuthoritativeInteractionFields {
  readonly messageProfile?: 'chat-input-messages-v1';
  readonly originalMessageId?: string;
}
export type InteractionMessageCommand =
  | {
      readonly operation: 'respond';
      readonly interactionId: string;
      readonly responseType: InteractionResponseType;
      readonly data?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operation: 'create-followup' | 'edit-original';
      readonly interactionId: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly operation: 'delete-original'; readonly interactionId: string }
  | {
      readonly operation: 'edit-followup';
      readonly interactionId: string;
      readonly messageId: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operation: 'delete-followup';
      readonly interactionId: string;
      readonly messageId: string;
    };
export interface InteractionMessageResult {
  readonly interaction: SimulatedInteraction;
  readonly message: ResourceRecord | null;
  readonly stateRevision: number;
  readonly eventId: string | null;
  readonly delivery: MessageDelivery | null;
}

interface MessageWrite {
  readonly operation: 'create' | 'update' | 'delete' | 'none';
  readonly interactionId: string;
  readonly applicationId: string;
  readonly context: InteractionContext;
  readonly kind?: 'original' | 'followup';
  readonly messageId?: string;
  readonly current?: ResourceRecord;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly loading?: boolean;
}
interface CommittedMessageWrite {
  readonly message: ResourceRecord | null;
  readonly stateRevision: number;
  readonly eventId: string | null;
  readonly delivery: MessageDelivery | null;
}

/** Internal write service; the engine owns the guard and installs registry references atomically. */
export class InteractionMessageDomain {
  readonly #options: InteractionMessageAuthorityOptions;
  readonly #author: Readonly<Record<string, unknown>>;
  readonly #context: Required<MessageDomainContext>;

  public constructor(options: InteractionMessageAuthorityOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.context.runId))
      throw new TypeError('Invalid message-domain runId.');
    if (options.author.id !== options.gateway.botUserId || options.author.bot !== true)
      throw new TypeError('Interaction message author must match the authenticated bot.');
    this.#options = options;
    this.#author = {
      id: options.author.id,
      username: options.author.username,
      discriminator: options.author.discriminator,
      avatar: options.author.avatar,
      bot: true,
    };
    this.#context = {
      runId: options.context.runId,
      clockDomain: options.context.clockDomain ?? 'virtual',
    };
  }

  public assertContext(context: InteractionContext): void {
    const state = this.#options.state;
    const actor = state.get('user', context.actorId);
    const channel = state.get('channel', context.channelId);
    if (actor === undefined || channel === undefined)
      throw new DiscordApiError(400, 50035, 'Invalid interaction message context.');
    if (channel['type'] === 0 && typeof channel['guild_id'] === 'string') {
      if (
        channel['guild_id'] !== context.guildId ||
        state.get('guild', context.guildId) === undefined
      )
        throw new DiscordApiError(400, 50035, 'Invalid interaction message context.');
    } else if (
      channel['type'] !== 1 ||
      channel['guild_id'] !== undefined ||
      context.guildId !== undefined
    ) {
      throw new DiscordApiError(400, 50035, 'Invalid interaction message context.');
    }
  }

  public commit(
    input: MessageWrite,
    install: (message: ResourceRecord | null) => void,
  ): CommittedMessageWrite {
    const { state, gateway } = this.#options;
    const revision = state.revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
      throw new DiscordApiError(503, 0, 'Revisioned message state is unavailable.');
    this.assertContext(input.context);
    const now = state.now();
    let event: MessageDomainEvent | undefined;
    let projection: ReturnType<typeof mapMessageEvent>;
    const result = state.transaction('interaction-message:' + input.operation, () => {
      let message: ResourceRecord | null;
      if (input.operation === 'none') message = null;
      else if (input.operation === 'create') {
        const payload = input.payload as Readonly<Record<string, unknown>>;
        const flags = (payload['flags'] as number) | (input.loading ? 128 : 0);
        const ephemeral = (flags & 64) !== 0;
        message = state.create('message', {
          ...payload,
          id: input.messageId,
          flags,
          type: input.kind === 'original' ? 20 : 0,
          channel_id: input.context.channelId,
          ...(input.context.guildId === undefined ? {} : { guild_id: input.context.guildId }),
          author: this.#author,
          application_id: input.applicationId,
          webhook_id: input.applicationId,
          message_origin: 'interaction',
          interaction_id: input.interactionId,
          interaction_message_kind: input.kind,
          visibility: ephemeral ? 'ephemeral' : 'channel',
          ...(ephemeral ? { recipient_id: input.context.actorId } : {}),
          timestamp: new Date(now).toISOString(),
          edited_timestamp: null,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          pinned: false,
        });
      } else if (input.operation === 'update') {
        const current = input.current as ResourceRecord;
        const next: Record<string, unknown> & ResourceRecord = {
          ...current,
          ...input.payload,
          edited_timestamp: new Date(now).toISOString(),
        };
        if (!Object.hasOwn(input.payload as object, 'allowed_mentions'))
          delete next['allowed_mentions'];
        // Replacing inside the outer transaction removes cleared optional fields and records one net update.
        state.delete('message', current.id);
        message = state.create('message', next);
      } else {
        message = input.current as ResourceRecord;
        state.delete('message', message.id);
      }
      if (
        message !== null &&
        message['visibility'] === 'channel' &&
        ((message['flags'] as number) & 128) === 0
      ) {
        const type: MessageEventName =
          input.operation === 'delete'
            ? 'MESSAGE_DELETE'
            : input.operation === 'create' ||
                (((input.current?.['flags'] as number | undefined) ?? 0) & 128) !== 0
              ? 'MESSAGE_CREATE'
              : 'MESSAGE_UPDATE';
        event = {
          schemaVersion: 1,
          runId: this.#context.runId,
          eventId: randomUUID(),
          sequence: nextMessageSequence(state, this.#context.runId),
          stateRevision: revision + 1,
          correlationId: input.interactionId,
          causationId: randomUUID(),
          origin: 'interaction',
          clockDomain: this.#context.clockDomain,
          timestamp: now,
          payload: { type, message, visibility: 'channel' },
        };
        projection = mapMessageEvent(event);
        if (projection === undefined)
          throw new DiscordApiError(400, 50035, 'Invalid interaction message projection.');
        gateway.preflightBroadcast(projection.eventName, projection.data);
      }
      install(message);
      return message;
    });
    const committedRevision = state.revision;
    if (event === undefined)
      return { message: result, stateRevision: committedRevision, eventId: null, delivery: null };
    commitMessageSequence(state, this.#context.runId, event.sequence);
    let delivery: MessageDelivery;
    try {
      const mapped = projection!;
      if (mapped === undefined) throw new Error('Missing committed message projection.');
      const counts = gateway.broadcast(mapped.eventName, mapped.data);
      delivery = {
        ...counts,
        status: counts.failed + counts.transportFailed === 0 ? 'accepted' : 'partial',
      };
    } catch {
      delivery = { status: 'partial', accepted: 0, filtered: 0, failed: 1, transportFailed: 0 };
    }
    recordMessageEvidence(state, { ...event, stateRevision: committedRevision }, delivery, [
      gateway.sessionToken,
    ]);
    return { message: result, stateRevision: committedRevision, eventId: event.eventId, delivery };
  }
}

/** Detached mutable payload fields; protected identity/provenance never become legacy data. */
export function interactionMessagePayload(
  message: ResourceRecord,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'content',
    'embeds',
    'components',
    'attachments',
    'tts',
    'flags',
    'allowed_mentions',
  ]) {
    if (Object.hasOwn(message, key)) result[key] = structuredClone(message[key]);
  }
  return result;
}

function invalidInteractionMessagePayload(code = 50035): never {
  throw new DiscordApiError(400, code, 'Invalid interaction message payload.');
}

/**
 * Clone a JSON data tree without reading accessors or invoking input proxy traps.
 * Rejects aliases as well as cycles, symbol/non-enumerable properties, sparse or
 * decorated arrays, class instances, non-finite numbers and non-JSON values.
 * Bounds count all values (including containers), with the root at depth zero.
 * Byte accounting is the exact UTF-8 size of compact JSON, without calling an
 * object's toJSON method or serializing an attacker-controlled object.
 */
export function cloneInteractionPayload(value: unknown, maxBytes: number): unknown {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) invalidInteractionMessagePayload();
    let nodes = 0;
    let bytes = 0;
    const seen = new WeakSet<object>();
    const addBytes = (count: number): void => {
      bytes += count;
      if (bytes > maxBytes) invalidInteractionMessagePayload();
    };
    const addString = (input: string): void => {
      // JSON cannot encode a UTF-16 code unit in fewer than one UTF-8 byte.
      if (input.length > maxBytes - bytes) invalidInteractionMessagePayload();
      addBytes(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    };
    const walk = (input: unknown, depth: number): unknown => {
      if (++nodes > 10_000 || depth > 32) invalidInteractionMessagePayload();
      if (input === null) {
        addBytes(4);
        return null;
      }
      if (typeof input === 'string') {
        addString(input);
        return input;
      }
      if (typeof input === 'boolean') {
        addBytes(input ? 4 : 5);
        return input;
      }
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) invalidInteractionMessagePayload();
        addBytes(Buffer.byteLength(JSON.stringify(input), 'utf8'));
        return input === 0 ? 0 : input;
      }
      if (typeof input !== 'object' || interactionUtilTypes.isProxy(input))
        invalidInteractionMessagePayload();
      if (seen.has(input)) invalidInteractionMessagePayload();
      seen.add(input);
      const prototype: unknown = Object.getPrototypeOf(input);
      const keys = Reflect.ownKeys(input);
      if (keys.length > 10_001) invalidInteractionMessagePayload();
      if (Array.isArray(input)) {
        if (prototype !== Array.prototype) invalidInteractionMessagePayload();
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
        if (lengthDescriptor === undefined || !('value' in lengthDescriptor))
          invalidInteractionMessagePayload();
        const length: unknown = lengthDescriptor.value;
        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 10_000 - nodes ||
          keys.length !== length + 1
        )
          invalidInteractionMessagePayload();
        // Every dense array has exactly its indices and the built-in length key.
        if (keys.some((key) => typeof key !== 'string')) invalidInteractionMessagePayload();
        addBytes(2 + Math.max(0, length - 1));
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
            invalidInteractionMessagePayload();
          output.push(walk(descriptor.value, depth + 1));
        }
        return output;
      }
      if (prototype !== Object.prototype && prototype !== null) invalidInteractionMessagePayload();
      if (keys.length > 10_000 - nodes) invalidInteractionMessagePayload();
      addBytes(2 + Math.max(0, keys.length - 1));
      const output: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') invalidInteractionMessagePayload();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
          invalidInteractionMessagePayload();
        addString(key);
        addBytes(1);
        // defineProperty avoids the legacy __proto__ assignment setter.
        Object.defineProperty(output, key, {
          value: walk(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    };
    return walk(value, 0);
  } catch {
    // Never expose input keys, values, exception messages or proxy diagnostics.
    invalidInteractionMessagePayload();
  }
}

function interactionPayloadObject(value: unknown): Record<string, unknown> {
  // Call only after bounded cloning, or for locally constructed objects.
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalidInteractionMessagePayload();
  return value as Record<string, unknown>;
}

function interactionPayloadHas(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function interactionPayloadKeys(
  value: Record<string, unknown>,
  permitted: readonly string[],
  required: readonly string[] = [],
): void {
  if (
    Object.keys(value).some((key) => !permitted.includes(key)) ||
    required.some((key) => !interactionPayloadHas(value, key))
  )
    invalidInteractionMessagePayload();
}

function interactionPayloadString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum)
    invalidInteractionMessagePayload();
  return value;
}

function interactionPayloadBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidInteractionMessagePayload();
  return value;
}

function interactionPayloadInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalidInteractionMessagePayload();
  return value;
}

function interactionPayloadArray(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    invalidInteractionMessagePayload();
  return value;
}

function interactionPayloadUrl(value: unknown, maximum = 2048): string {
  const text = interactionPayloadString(value, 1, maximum);
  if (
    /\s/u.test(text) ||
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  )
    invalidInteractionMessagePayload();
  try {
    const url = new URL(text);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username !== '' ||
      url.password !== ''
    )
      invalidInteractionMessagePayload();
  } catch {
    invalidInteractionMessagePayload();
  }
  return text;
}

function interactionPayloadEmbeds(value: unknown): Record<string, unknown>[] {
  let textLength = 0;
  const text = (input: unknown, maximum: number): string => {
    const result = interactionPayloadString(input, 1, maximum);
    textLength += result.length;
    if (textLength > 6000) invalidInteractionMessagePayload();
    return result;
  };
  return interactionPayloadArray(value, 10).map((entry) => {
    const embed = interactionPayloadObject(entry);
    interactionPayloadKeys(embed, [
      'type',
      'title',
      'description',
      'url',
      'timestamp',
      'color',
      'footer',
      'image',
      'thumbnail',
      'author',
      'fields',
    ]);
    if (interactionPayloadHas(embed, 'type') && embed.type !== 'rich')
      invalidInteractionMessagePayload();
    const output: Record<string, unknown> = { type: 'rich' };
    let hasContent = false;
    if (interactionPayloadHas(embed, 'title')) {
      output.title = text(embed.title, 256);
      hasContent = true;
    }
    if (interactionPayloadHas(embed, 'description')) {
      output.description = text(embed.description, 4096);
      hasContent = true;
    }
    if (interactionPayloadHas(embed, 'url')) output.url = interactionPayloadUrl(embed.url);
    if (interactionPayloadHas(embed, 'timestamp')) {
      const timestamp = interactionPayloadString(embed.timestamp, 24, 24);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp))
        invalidInteractionMessagePayload();
      const parsed = new Date(timestamp);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp)
        invalidInteractionMessagePayload();
      output.timestamp = timestamp;
    }
    if (interactionPayloadHas(embed, 'color'))
      output.color = interactionPayloadInteger(embed.color, 0, 16_777_215);
    if (interactionPayloadHas(embed, 'footer')) {
      const footer = interactionPayloadObject(embed.footer);
      interactionPayloadKeys(footer, ['text', 'icon_url'], ['text']);
      const normalized: Record<string, unknown> = { text: text(footer.text, 2048) };
      if (interactionPayloadHas(footer, 'icon_url'))
        normalized.icon_url = interactionPayloadUrl(footer.icon_url);
      output.footer = normalized;
      hasContent = true;
    }
    for (const key of ['image', 'thumbnail']) {
      if (!interactionPayloadHas(embed, key)) continue;
      const media = interactionPayloadObject(embed[key]);
      interactionPayloadKeys(media, ['url'], ['url']);
      output[key] = { url: interactionPayloadUrl(media.url) };
      hasContent = true;
    }
    if (interactionPayloadHas(embed, 'author')) {
      const author = interactionPayloadObject(embed.author);
      interactionPayloadKeys(author, ['name', 'url', 'icon_url'], ['name']);
      const normalized: Record<string, unknown> = { name: text(author.name, 256) };
      if (interactionPayloadHas(author, 'url')) normalized.url = interactionPayloadUrl(author.url);
      if (interactionPayloadHas(author, 'icon_url'))
        normalized.icon_url = interactionPayloadUrl(author.icon_url);
      output.author = normalized;
      hasContent = true;
    }
    if (interactionPayloadHas(embed, 'fields')) {
      const fields = interactionPayloadArray(embed.fields, 25).map((entry) => {
        const field = interactionPayloadObject(entry);
        interactionPayloadKeys(field, ['name', 'value', 'inline'], ['name', 'value']);
        const normalized: Record<string, unknown> = {
          name: text(field.name, 256),
          value: text(field.value, 1024),
        };
        if (interactionPayloadHas(field, 'inline'))
          normalized.inline = interactionPayloadBoolean(field.inline);
        return normalized;
      });
      output.fields = fields;
      if (fields.length > 0) hasContent = true;
    }
    if (!hasContent) invalidInteractionMessagePayload();
    return output;
  });
}

function interactionPayloadComponents(value: unknown): Record<string, unknown>[] {
  const customIds = new Set<string>();
  return interactionPayloadArray(value, 5).map((entry) => {
    const row = interactionPayloadObject(entry);
    interactionPayloadKeys(row, ['type', 'components'], ['type', 'components']);
    if (row.type !== 1) invalidInteractionMessagePayload();
    const components = interactionPayloadArray(row.components, 5, 1).map((entry) => {
      const button = interactionPayloadObject(entry);
      interactionPayloadKeys(
        button,
        ['type', 'style', 'label', 'disabled', 'custom_id', 'url'],
        ['type', 'style', 'label'],
      );
      if (button.type !== 2) invalidInteractionMessagePayload();
      const style = interactionPayloadInteger(button.style, 1, 5);
      const output: Record<string, unknown> = {
        type: 2,
        style,
        label: interactionPayloadString(button.label, 1, 80),
      };
      if (interactionPayloadHas(button, 'disabled'))
        output.disabled = interactionPayloadBoolean(button.disabled);
      if (style === 5) {
        if (interactionPayloadHas(button, 'custom_id') || !interactionPayloadHas(button, 'url'))
          invalidInteractionMessagePayload();
        output.url = interactionPayloadUrl(button.url, 512);
      } else {
        if (interactionPayloadHas(button, 'url') || !interactionPayloadHas(button, 'custom_id'))
          invalidInteractionMessagePayload();
        const customId = interactionPayloadString(button.custom_id, 1, 100);
        if (customIds.has(customId)) invalidInteractionMessagePayload();
        customIds.add(customId);
        output.custom_id = customId;
      }
      return output;
    });
    return { type: 1, components };
  });
}

function interactionPayloadAllowedMentions(value: unknown): Record<string, unknown> {
  const mentions = interactionPayloadObject(value);
  interactionPayloadKeys(mentions, ['parse'], ['parse']);
  interactionPayloadArray(mentions.parse, 0);
  return { parse: [] };
}

function interactionPayloadFlags(value: unknown, permitted: number): number {
  const flags = interactionPayloadInteger(value, 0, Number.MAX_SAFE_INTEGER);
  // Check the range before bitwise operations, which otherwise discard high bits.
  if (flags > permitted || (flags & permitted) !== flags) invalidInteractionMessagePayload();
  return flags;
}

function interactionNormalizeCreatePayload(
  value: Record<string, unknown>,
  permittedFlags = 4 | 64 | 4096,
): Record<string, unknown> {
  interactionPayloadKeys(value, [
    'content',
    'embeds',
    'components',
    'attachments',
    'flags',
    'tts',
    'allowed_mentions',
  ]);
  const output: Record<string, unknown> = {
    content: interactionPayloadHas(value, 'content')
      ? interactionPayloadString(value.content, 0, 2000)
      : '',
    embeds: interactionPayloadHas(value, 'embeds') ? interactionPayloadEmbeds(value.embeds) : [],
    components: interactionPayloadHas(value, 'components')
      ? interactionPayloadComponents(value.components)
      : [],
    attachments: interactionPayloadHas(value, 'attachments')
      ? interactionPayloadArray(value.attachments, 0)
      : [],
    flags: interactionPayloadHas(value, 'flags')
      ? interactionPayloadFlags(value.flags, permittedFlags)
      : 0,
    tts: interactionPayloadHas(value, 'tts') ? interactionPayloadBoolean(value.tts) : false,
  };
  if (interactionPayloadHas(value, 'allowed_mentions'))
    output.allowed_mentions = interactionPayloadAllowedMentions(value.allowed_mentions);
  return output;
}

function interactionCurrentMutablePayload(
  current: ResourceRecord,
  maxBytes: number,
): Record<string, unknown> {
  // Do not spread a ResourceRecord: provenance, identity and arbitrary fixture
  // data must never become mutable payload fields or be read via accessors.
  if (current === null || typeof current !== 'object' || interactionUtilTypes.isProxy(current))
    invalidInteractionMessagePayload();
  const prototype: unknown = Object.getPrototypeOf(current);
  if (prototype !== Object.prototype && prototype !== null) invalidInteractionMessagePayload();
  const selected: Record<string, unknown> = {};
  for (const key of [
    'content',
    'embeds',
    'components',
    'attachments',
    'flags',
    'tts',
    'allowed_mentions',
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) invalidInteractionMessagePayload();
    selected[key] = descriptor.value;
  }
  return interactionNormalizeCreatePayload(
    interactionPayloadObject(cloneInteractionPayload(selected, maxBytes)),
    4 | 64 | 128 | 4096,
  );
}

/**
 * Return a detached, normalized FULL mutable message payload. current selects
 * PATCH semantics; materializing adds the nonempty-create condition without
 * admitting create-only fields. The lifecycle caller removes loading bit 128.
 */
export function validateInteractionMessagePayload(
  value: Readonly<Record<string, unknown>>,
  maxBytes: number,
  current?: ResourceRecord,
  materializing = false,
): Readonly<Record<string, unknown>> {
  const data = interactionPayloadObject(cloneInteractionPayload(value, maxBytes));
  let output: Record<string, unknown>;
  if (current === undefined) {
    output = interactionNormalizeCreatePayload(data);
  } else {
    interactionPayloadKeys(data, [
      'content',
      'embeds',
      'components',
      'attachments',
      'flags',
      'allowed_mentions',
    ]);
    output = interactionCurrentMutablePayload(current, maxBytes);
    if (interactionPayloadHas(data, 'content')) {
      output.content = data.content === null ? '' : interactionPayloadString(data.content, 0, 2000);
      // Content replacement clears the old policy unless this PATCH replaces it.
      delete output.allowed_mentions;
    }
    if (interactionPayloadHas(data, 'embeds'))
      output.embeds = data.embeds === null ? [] : interactionPayloadEmbeds(data.embeds);
    if (interactionPayloadHas(data, 'components'))
      output.components =
        data.components === null ? [] : interactionPayloadComponents(data.components);
    if (interactionPayloadHas(data, 'attachments'))
      output.attachments =
        data.attachments === null ? [] : interactionPayloadArray(data.attachments, 0);
    if (interactionPayloadHas(data, 'flags')) {
      const supplied = data.flags === null ? 0 : interactionPayloadFlags(data.flags, 4 | 64);
      const prior = interactionPayloadFlags(output.flags, 4 | 64 | 128 | 4096);
      output.flags = (prior & ~4) | (supplied & 4);
    }
    if (interactionPayloadHas(data, 'allowed_mentions')) {
      if (data.allowed_mentions === null) delete output.allowed_mentions;
      else output.allowed_mentions = interactionPayloadAllowedMentions(data.allowed_mentions);
    }
  }
  // Bound the normalized full candidate too: defaults, embed type normalization,
  // and omitted PATCH fields can make it larger than the supplied input.
  const normalized = interactionPayloadObject(cloneInteractionPayload(output, maxBytes));
  if (
    (current === undefined || materializing) &&
    normalized.content === '' &&
    interactionPayloadArray(normalized.embeds, 10).length === 0 &&
    interactionPayloadArray(normalized.components, 5).length === 0
  )
    invalidInteractionMessagePayload(50006);
  return normalized;
}
