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
export type InteractionMessageProfile = 'model' | 'chat-input-messages-v1' | 'interactions-v1';
export interface InteractionMessageSelection {
  readonly messageProfile?: InteractionMessageProfile;
}
export interface AuthoritativeInteractionFields {
  readonly messageProfile?: 'chat-input-messages-v1' | 'interactions-v1';
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
  readonly componentSource?: boolean;
  readonly interactionMetadata?: Readonly<Record<string, unknown>>;
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
          ...(input.interactionMetadata === undefined
            ? {}
            : { interaction_metadata: input.interactionMetadata }),
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
          payload: {
            type,
            message,
            visibility: 'channel',
            ...(input.componentSource ? { componentSource: true } : {}),
          },
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
  if (message === null || typeof message !== 'object' || interactionUtilTypes.isProxy(message))
    invalidInteractionMessagePayload();
  const prototype: unknown = Object.getPrototypeOf(message);
  if (prototype !== Object.prototype && prototype !== null) invalidInteractionMessagePayload();
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
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) invalidInteractionMessagePayload();
    result[key] = descriptor.value;
  }
  return interactionPayloadObject(cloneInteractionPayload(result, 16_777_216));
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

function interactionPayloadComponents(value: unknown, extended = false): Record<string, unknown>[] {
  if (extended) return interactionExtendedComponents(value);
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

function interactionComponentEmoji(value: unknown): Record<string, unknown> {
  const emoji = interactionPayloadObject(value);
  interactionPayloadKeys(emoji, ['id', 'name', 'animated']);
  const output: Record<string, unknown> = {};
  if (interactionPayloadHas(emoji, 'id')) {
    output.id = emoji.id === null ? null : interactionSnowflake(emoji.id);
  }
  if (interactionPayloadHas(emoji, 'name')) {
    output.name = emoji.name === null ? null : interactionPayloadString(emoji.name, 1, 32);
  }
  if (!output.id && !output.name) invalidInteractionMessagePayload();
  if (interactionPayloadHas(emoji, 'animated')) {
    output.animated = interactionPayloadBoolean(emoji.animated);
    if (output.animated && !output.id) invalidInteractionMessagePayload();
  }
  return output;
}

function interactionSnowflake(value: unknown): string {
  const id = interactionPayloadString(value, 1, 20);
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n)
    invalidInteractionMessagePayload();
  return id;
}

function interactionExtendedComponents(value: unknown): Record<string, unknown>[] {
  const customIds = new Set<string>();
  const componentIds = new Set<number>();
  const addId = (input: Record<string, unknown>, output: Record<string, unknown>): void => {
    if (!interactionPayloadHas(input, 'id')) return;
    const id = interactionPayloadInteger(input.id, 0, 4_294_967_295);
    // Zero asks Discord to assign an ID; positive IDs identify one component.
    if (id !== 0 && componentIds.has(id)) invalidInteractionMessagePayload();
    if (id !== 0) componentIds.add(id);
    output.id = id;
  };
  const addCustomId = (input: Record<string, unknown>, output: Record<string, unknown>): void => {
    const id = interactionPayloadString(input.custom_id, 1, 100);
    if (customIds.has(id)) invalidInteractionMessagePayload();
    customIds.add(id);
    output.custom_id = id;
  };
  return interactionPayloadArray(value, 5).map((entry) => {
    const row = interactionPayloadObject(entry);
    interactionPayloadKeys(row, ['type', 'components', 'id'], ['type', 'components']);
    if (row.type !== 1) invalidInteractionMessagePayload();
    const children = interactionPayloadArray(row.components, 5, 1);
    const components = children.map((entry) => {
      const component = interactionPayloadObject(entry);
      const output: Record<string, unknown> = { type: component.type };
      addId(component, output);
      if (component.type === 2) {
        interactionPayloadKeys(
          component,
          ['type', 'id', 'style', 'label', 'emoji', 'disabled', 'custom_id', 'url'],
          ['type', 'style'],
        );
        const style = interactionPayloadInteger(component.style, 1, 5);
        output.style = style;
        if (interactionPayloadHas(component, 'label'))
          output.label = interactionPayloadString(component.label, 1, 80);
        if (interactionPayloadHas(component, 'emoji'))
          output.emoji = interactionComponentEmoji(component.emoji);
        if (!interactionPayloadHas(output, 'label') && !interactionPayloadHas(output, 'emoji'))
          invalidInteractionMessagePayload();
        if (style === 5) {
          if (
            interactionPayloadHas(component, 'custom_id') ||
            !interactionPayloadHas(component, 'url')
          )
            invalidInteractionMessagePayload();
          output.url = interactionPayloadUrl(component.url, 512);
        } else {
          if (interactionPayloadHas(component, 'url')) invalidInteractionMessagePayload();
          addCustomId(component, output);
        }
      } else {
        if (children.length !== 1 || ![3, 5, 6, 7, 8].includes(component.type as number))
          invalidInteractionMessagePayload();
        interactionPayloadKeys(
          component,
          [
            'type',
            'id',
            'custom_id',
            'placeholder',
            'min_values',
            'max_values',
            'disabled',
            'required',
            'options',
            'channel_types',
            'default_values',
          ],
          ['type', 'custom_id'],
        );
        addCustomId(component, output);
        if (interactionPayloadHas(component, 'placeholder'))
          output.placeholder = interactionPayloadString(component.placeholder, 0, 150);
        const minimum = interactionPayloadHas(component, 'min_values')
          ? interactionPayloadInteger(component.min_values, 0, 25)
          : 1;
        const maximum = interactionPayloadHas(component, 'max_values')
          ? interactionPayloadInteger(component.max_values, 1, 25)
          : 1;
        if (minimum > maximum) invalidInteractionMessagePayload();
        if (interactionPayloadHas(component, 'min_values')) output.min_values = minimum;
        if (interactionPayloadHas(component, 'max_values')) output.max_values = maximum;
        if (interactionPayloadHas(component, 'required'))
          output.required = interactionPayloadBoolean(component.required);
        if (component.type === 3) {
          if (
            interactionPayloadHas(component, 'default_values') ||
            interactionPayloadHas(component, 'channel_types')
          )
            invalidInteractionMessagePayload();
          const values = new Set<string>();
          let defaults = 0;
          const options = interactionPayloadArray(component.options, 25, 1).map((entry) => {
            const option = interactionPayloadObject(entry);
            interactionPayloadKeys(
              option,
              ['label', 'value', 'description', 'emoji', 'default'],
              ['label', 'value'],
            );
            const value = interactionPayloadString(option.value, 1, 100);
            if (values.has(value)) invalidInteractionMessagePayload();
            values.add(value);
            const normalized: Record<string, unknown> = {
              label: interactionPayloadString(option.label, 1, 100),
              value,
            };
            if (interactionPayloadHas(option, 'description'))
              normalized.description = interactionPayloadString(option.description, 0, 100);
            if (interactionPayloadHas(option, 'emoji'))
              normalized.emoji = interactionComponentEmoji(option.emoji);
            if (interactionPayloadHas(option, 'default')) {
              normalized.default = interactionPayloadBoolean(option.default);
              if (normalized.default) defaults += 1;
            }
            return normalized;
          });
          if (
            maximum > options.length ||
            defaults > maximum ||
            (defaults > 0 && defaults < minimum)
          )
            invalidInteractionMessagePayload();
          output.options = options;
        } else {
          if (interactionPayloadHas(component, 'options')) invalidInteractionMessagePayload();
          if (interactionPayloadHas(component, 'channel_types')) {
            if (component.type !== 8) invalidInteractionMessagePayload();
            const channelTypes = interactionPayloadArray(component.channel_types, 11).map((type) =>
              interactionPayloadInteger(type, 0, 16),
            );
            if (
              new Set(channelTypes).size !== channelTypes.length ||
              channelTypes.some((type) => ![0, 2, 4, 5, 10, 11, 12, 13, 14, 15, 16].includes(type))
            )
              invalidInteractionMessagePayload();
            output.channel_types = channelTypes;
          }
          if (interactionPayloadHas(component, 'default_values')) {
            const defaults = interactionPayloadArray(component.default_values, maximum).map(
              (entry) => {
                const value = interactionPayloadObject(entry);
                interactionPayloadKeys(value, ['id', 'type'], ['id', 'type']);
                const type = interactionPayloadString(value.type, 1, 7);
                const permitted =
                  component.type === 5
                    ? ['user']
                    : component.type === 6
                      ? ['role']
                      : component.type === 7
                        ? ['user', 'role']
                        : ['channel'];
                if (!permitted.includes(type)) invalidInteractionMessagePayload();
                return { id: interactionSnowflake(value.id), type };
              },
            );
            if (
              (defaults.length > 0 && defaults.length < minimum) ||
              new Set(defaults.map((value) => value.type + ':' + value.id)).size !== defaults.length
            )
              invalidInteractionMessagePayload();
            output.default_values = defaults;
          }
        }
      }
      if (interactionPayloadHas(component, 'disabled'))
        output.disabled = interactionPayloadBoolean(component.disabled);
      return output;
    });
    const output: Record<string, unknown> = { type: 1, components };
    addId(row, output);
    return output;
  });
}

function interactionPayloadAttachments(
  value: unknown,
  extended: boolean,
): Record<string, unknown>[] {
  if (!extended) return interactionPayloadArray(value, 0) as Record<string, unknown>[];
  const ids = new Set<string>();
  let totalBytes = 0;
  return interactionPayloadArray(value, 10).map((entry) => {
    const attachment = interactionPayloadObject(entry);
    interactionPayloadKeys(
      attachment,
      ['id', 'filename', 'size', 'content_type', 'url', 'proxy_url', 'sha256', 'description'],
      ['id', 'filename', 'size', 'content_type', 'url', 'proxy_url', 'sha256'],
    );
    const id = interactionSnowflake(attachment.id);
    if (ids.has(id)) invalidInteractionMessagePayload();
    ids.add(id);
    const filename = interactionPayloadString(attachment.filename, 1, 255);
    if (filename === '.' || filename === '..' || /[\\/\p{Cc}]/u.test(filename))
      invalidInteractionMessagePayload();
    const size = interactionPayloadInteger(attachment.size, 0, 2_097_152);
    totalBytes += size;
    if (totalBytes > 8_388_608) invalidInteractionMessagePayload();
    const contentType = interactionPayloadString(attachment.content_type, 1, 255);
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7E]*)?$/.test(contentType))
      invalidInteractionMessagePayload();
    const sha256 = interactionPayloadString(attachment.sha256, 64, 64);
    if (!/^[0-9a-f]{64}$/.test(sha256)) invalidInteractionMessagePayload();
    const localUrl = (value: unknown): string => {
      const text = interactionPayloadUrl(value);
      const url = new URL(text);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.hash !== '' ||
        url.search !== ''
      )
        invalidInteractionMessagePayload();
      return text;
    };
    const url = localUrl(attachment.url);
    const proxyUrl = localUrl(attachment.proxy_url);
    if (new URL(url).origin !== new URL(proxyUrl).origin) invalidInteractionMessagePayload();
    return {
      id,
      filename,
      size,
      content_type: contentType,
      url,
      proxy_url: proxyUrl,
      sha256,
      ...(interactionPayloadHas(attachment, 'description')
        ? { description: interactionPayloadString(attachment.description, 0, 1024) }
        : {}),
    };
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
  extended = false,
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
      ? interactionPayloadComponents(value.components, extended)
      : [],
    attachments: interactionPayloadHas(value, 'attachments')
      ? interactionPayloadAttachments(value.attachments, extended)
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
  extended: boolean,
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
    extended,
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
  extended = false,
): Readonly<Record<string, unknown>> {
  const data = interactionPayloadObject(cloneInteractionPayload(value, maxBytes));
  let output: Record<string, unknown>;
  if (current === undefined) {
    output = interactionNormalizeCreatePayload(data, 4 | 64 | 4096, extended);
  } else {
    interactionPayloadKeys(data, [
      'content',
      'embeds',
      'components',
      'attachments',
      'flags',
      'allowed_mentions',
    ]);
    output = interactionCurrentMutablePayload(current, maxBytes, extended);
    if (interactionPayloadHas(data, 'content')) {
      output.content = data.content === null ? '' : interactionPayloadString(data.content, 0, 2000);
      // Content replacement clears the old policy unless this PATCH replaces it.
      delete output.allowed_mentions;
    }
    if (interactionPayloadHas(data, 'embeds'))
      output.embeds = data.embeds === null ? [] : interactionPayloadEmbeds(data.embeds);
    if (interactionPayloadHas(data, 'components'))
      output.components =
        data.components === null ? [] : interactionPayloadComponents(data.components, extended);
    if (interactionPayloadHas(data, 'attachments'))
      output.attachments =
        data.attachments === null ? [] : interactionPayloadAttachments(data.attachments, extended);
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
    interactionPayloadArray(normalized.components, 5).length === 0 &&
    (!extended || interactionPayloadArray(normalized.attachments, 10).length === 0)
  )
    invalidInteractionMessagePayload(50006);
  return normalized;
}
