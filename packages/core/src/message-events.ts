import type { ResourceRecord } from './contracts.js';

export type MessageEventName = 'MESSAGE_CREATE' | 'MESSAGE_UPDATE' | 'MESSAGE_DELETE';
export interface MessageDomainEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly stateRevision: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly origin: 'rest';
  readonly clockDomain: 'virtual' | 'realtime';
  readonly timestamp: number;
  readonly payload: {
    readonly type: MessageEventName;
    readonly message: ResourceRecord;
    readonly visibility: 'channel';
  };
}

/** Explicit deep projection. Fixture metadata is never a Discord wire field. */
export function projectMessageWire(
  message: Readonly<Record<string, unknown>>,
  deleted = false,
): Readonly<Record<string, unknown>> {
  const wire = pick(
    message,
    deleted
      ? ['id', 'channel_id', 'guild_id']
      : [
          'id',
          'channel_id',
          'guild_id',
          'content',
          'flags',
          'timestamp',
          'edited_timestamp',
          'tts',
          'mention_everyone',
          'pinned',
          'type',
        ],
  );
  if (deleted) return wire;
  if (isRecord(message['author'])) wire['author'] = projectUser(message['author']);
  for (const key of ['embeds', 'attachments', 'components', 'mentions', 'mention_roles']) {
    const value = message[key];
    if (!Array.isArray(value)) continue;
    wire[key] =
      key === 'mention_roles'
        ? value.filter((entry) => typeof entry === 'string')
        : value
            .filter(isRecord)
            .map(
              key === 'embeds'
                ? projectEmbed
                : key === 'attachments'
                  ? projectAttachment
                  : key === 'components'
                    ? (entry) => projectComponent(entry, 0)
                    : projectUser,
            );
  }
  return wire;
}

/** Unknown/ephemeral visibility never reaches Gateway. */
export function mapMessageEvent(event: MessageDomainEvent):
  | {
      readonly eventName: MessageEventName;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | undefined {
  if (
    !['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE'].includes(event.payload.type) ||
    event.payload.visibility !== 'channel' ||
    !isOrdinaryMessage(event.payload.message)
  )
    return undefined;
  return {
    eventName: event.payload.type,
    data: projectMessageWire(event.payload.message, event.payload.type === 'MESSAGE_DELETE'),
  };
}
export function isOrdinaryMessage(message: Readonly<Record<string, unknown>>): boolean {
  const flags = message['flags'];
  return (
    typeof flags === 'number' &&
    [0, 4, 4096, 4100].includes(flags) &&
    message['visibility'] === 'channel' &&
    typeof message['channel_id'] === 'string' &&
    (message['guild_id'] === undefined || typeof message['guild_id'] === 'string')
  );
}
function projectUser(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return pick(value, [
    'id',
    'username',
    'global_name',
    'discriminator',
    'avatar',
    'bot',
    'system',
    'public_flags',
  ]);
}
function projectEmbed(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = pick(value, ['title', 'type', 'description', 'url', 'timestamp', 'color']);
  for (const [key, fields] of Object.entries({
    footer: ['text', 'icon_url'],
    image: ['url'],
    thumbnail: ['url'],
    author: ['name', 'url', 'icon_url'],
    provider: ['name', 'url'],
  })) {
    if (isRecord(value[key])) result[key] = pick(value[key], fields);
  }
  if (Array.isArray(value['fields']))
    result['fields'] = value['fields']
      .filter(isRecord)
      .map((field) => pick(field, ['name', 'value', 'inline']));
  return result;
}
function projectAttachment(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return pick(value, [
    'id',
    'filename',
    'description',
    'content_type',
    'size',
    'url',
    'proxy_url',
    'height',
    'width',
    'ephemeral',
  ]);
}
function projectComponent(
  value: Readonly<Record<string, unknown>>,
  depth: number,
): Record<string, unknown> {
  const result = pick(value, [
    'type',
    'style',
    'label',
    'custom_id',
    'url',
    'disabled',
    'placeholder',
    'min_values',
    'max_values',
  ]);
  if (isRecord(value['emoji'])) result['emoji'] = pick(value['emoji'], ['id', 'name', 'animated']);
  if (depth < 16 && Array.isArray(value['components']))
    result['components'] = value['components']
      .filter(isRecord)
      .map((child) => projectComponent(child, depth + 1));
  if (Array.isArray(value['channel_types']))
    result['channel_types'] = value['channel_types'].filter((entry) => typeof entry === 'number');
  if (Array.isArray(value['options']))
    result['options'] = value['options'].filter(isRecord).map((option) => {
      const projected = pick(option, ['label', 'value', 'description', 'default']);
      if (isRecord(option['emoji']))
        projected['emoji'] = pick(option['emoji'], ['id', 'name', 'animated']);
      return projected;
    });
  return result;
}
function pick(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = value[key];
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    )
      result[key] = entry;
  }
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
