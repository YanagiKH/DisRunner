import type { ResourceRecord } from './contracts.js';
import type { MessageDelivery } from './message-domain.js';
import type { VirtualState } from './state.js';
import { sanitizeForExport } from './export-sanitizer.js';

export type MessageEventName = 'MESSAGE_CREATE' | 'MESSAGE_UPDATE' | 'MESSAGE_DELETE';
export interface MessageDomainEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly stateRevision: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly origin: 'rest' | 'interaction';
  readonly clockDomain: 'virtual' | 'realtime';
  readonly timestamp: number;
  readonly payload: {
    readonly type: MessageEventName;
    readonly message: ResourceRecord;
    readonly visibility: 'channel';
    readonly componentSource?: boolean;
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
          'application_id',
          'webhook_id',
          'channel_id',
          'guild_id',
          'content',
          'nonce',
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
  if (isRecord(message['interaction_metadata'])) {
    const metadata = message['interaction_metadata'];
    wire['interaction_metadata'] = {
      ...pick(metadata, ['id', 'type', 'original_response_message_id', 'interacted_message_id']),
      ...(isRecord(metadata['user']) ? { user: projectUser(metadata['user']) } : {}),
      ...(isRecord(metadata['authorizing_integration_owners'])
        ? {
            authorizing_integration_owners: pick(metadata['authorizing_integration_owners'], [
              '0',
              '1',
            ]),
          }
        : {}),
    };
  }
  if (isRecord(message['message_reference']))
    wire['message_reference'] = pick(message['message_reference'], [
      'message_id',
      'channel_id',
      'guild_id',
      'type',
    ]);
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
    !isOrdinaryMessage(event.payload.message) ||
    (event.origin === 'interaction'
      ? !isPublicInteractionMessage(event.payload.message) && event.payload.componentSource !== true
      : event.payload.message['message_origin'] === 'interaction')
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
    (message['type'] === 0 || message['type'] === 20 || message['type'] === undefined) &&
    typeof message['channel_id'] === 'string' &&
    (message['guild_id'] === undefined || typeof message['guild_id'] === 'string')
  );
}
function isPublicInteractionMessage(message: Readonly<Record<string, unknown>>): boolean {
  return (
    message['message_origin'] === 'interaction' &&
    typeof message['interaction_id'] === 'string' &&
    typeof message['application_id'] === 'string' &&
    message['webhook_id'] === message['application_id'] &&
    ((message['interaction_message_kind'] === 'original' && message['type'] === 20) ||
      (message['interaction_message_kind'] === 'followup' && message['type'] === 0))
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

interface MessageEvidenceLedger {
  records: { event: MessageDomainEvent; delivery: MessageDelivery; bytes: number }[];
  bytes: number;
  dropped: number;
}
const messageEvidence = new WeakMap<VirtualState, Map<string, MessageEvidenceLedger>>();
const MAX_MESSAGE_EVIDENCE_BYTES = 1_048_576;

/** Internal postcommit collector. Run registration is bounded separately by the sequence owner. */
export function recordMessageEvidence(
  state: VirtualState,
  event: MessageDomainEvent,
  delivery: MessageDelivery,
  sensitiveValues: readonly string[],
): void {
  let perRun = messageEvidence.get(state);
  if (perRun === undefined) {
    perRun = new Map();
    messageEvidence.set(state, perRun);
  }
  let ledger = perRun.get(event.runId);
  if (ledger === undefined) {
    ledger = { records: [], bytes: 0, dropped: 0 };
    perRun.set(event.runId, ledger);
  }
  try {
    const projected: MessageDomainEvent = {
      ...event,
      payload: {
        type: event.payload.type,
        visibility: 'channel',
        message: {
          ...projectMessageWire(event.payload.message),
          id: event.payload.message.id,
          resourceType: 'message',
          visibility: 'channel',
        },
      },
    };
    const safe = sanitizeForExport({ event: projected, delivery }, { sensitiveValues });
    const bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > MAX_MESSAGE_EVIDENCE_BYTES) {
      ledger.dropped += 1;
      return;
    }
    while (ledger.records.length >= 100 || ledger.bytes + bytes > MAX_MESSAGE_EVIDENCE_BYTES) {
      const removed = ledger.records.shift();
      if (removed === undefined) break;
      ledger.bytes -= removed.bytes;
      ledger.dropped += 1;
    }
    ledger.records.push({ ...safe, bytes });
    ledger.bytes += bytes;
  } catch {
    ledger.dropped += 1;
  }
}
export function readMessageEvidence(
  state: VirtualState,
  runId: string,
): {
  readonly records: readonly { event: MessageDomainEvent; delivery: MessageDelivery }[];
  readonly dropped: number;
} {
  const ledger = messageEvidence.get(state)?.get(runId);
  return {
    records:
      ledger?.records.map(({ event, delivery }) => structuredClone({ event, delivery })) ?? [],
    dropped: ledger?.dropped ?? 0,
  };
}
