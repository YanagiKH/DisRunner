export const GatewayIntents = {
  GUILDS: 1n << 0n,
  GUILD_MEMBERS: 1n << 1n,
  GUILD_MODERATION: 1n << 2n,
  GUILD_EXPRESSIONS: 1n << 3n,
  GUILD_INTEGRATIONS: 1n << 4n,
  GUILD_WEBHOOKS: 1n << 5n,
  GUILD_INVITES: 1n << 6n,
  GUILD_VOICE_STATES: 1n << 7n,
  GUILD_PRESENCES: 1n << 8n,
  GUILD_MESSAGES: 1n << 9n,
  GUILD_MESSAGE_REACTIONS: 1n << 10n,
  GUILD_MESSAGE_TYPING: 1n << 11n,
  DIRECT_MESSAGES: 1n << 12n,
  DIRECT_MESSAGE_REACTIONS: 1n << 13n,
  DIRECT_MESSAGE_TYPING: 1n << 14n,
  MESSAGE_CONTENT: 1n << 15n,
  GUILD_SCHEDULED_EVENTS: 1n << 16n,
  AUTO_MODERATION_CONFIGURATION: 1n << 20n,
  AUTO_MODERATION_EXECUTION: 1n << 21n,
  GUILD_MESSAGE_POLLS: 1n << 24n,
  DIRECT_MESSAGE_POLLS: 1n << 25n,
} as const;

export const PRIVILEGED_INTENTS =
  GatewayIntents.GUILD_MEMBERS | GatewayIntents.GUILD_PRESENCES | GatewayIntents.MESSAGE_CONTENT;

export const KNOWN_INTENTS = Object.values(GatewayIntents).reduce(
  (value, intent) => value | intent,
  0n,
);

export interface IntentFilterOptions {
  readonly botUserId?: string;
}

export interface IntentFilterResult<T = unknown> {
  readonly delivered: boolean;
  readonly data?: T;
  readonly requiredIntent?: bigint;
  readonly strippedMessageContent: boolean;
  readonly reason: string;
}

export function filterGatewayEvent<T>(
  eventName: string,
  data: T,
  requestedIntents: bigint | string,
  options: IntentFilterOptions = {},
): IntentFilterResult<T> {
  const intents = parseIntentBits(requestedIntents);
  const requiredIntent = requiredIntentForEvent(eventName, data);
  if (requiredIntent !== undefined && (intents & requiredIntent) === 0n) {
    return {
      delivered: false,
      requiredIntent,
      strippedMessageContent: false,
      reason: `Event ${eventName} requires intent ${requiredIntent.toString()}.`,
    };
  }

  if (
    (eventName === 'MESSAGE_CREATE' || eventName === 'MESSAGE_UPDATE') &&
    (intents & GatewayIntents.MESSAGE_CONTENT) === 0n &&
    !messageContentIsExempt(data, options.botUserId)
  ) {
    return {
      delivered: true,
      data: stripMessageContent(data),
      ...(requiredIntent === undefined ? {} : { requiredIntent }),
      strippedMessageContent: true,
      reason:
        'Event delivered with content-bearing fields stripped because MESSAGE_CONTENT is unavailable.',
    };
  }

  return {
    delivered: true,
    data: structuredClone(data),
    ...(requiredIntent === undefined ? {} : { requiredIntent }),
    strippedMessageContent: false,
    reason: 'Event is allowed by the requested intents.',
  };
}

export function validateIdentifyIntents(
  requested: bigint | string | number,
  portalEnabledPrivileged: bigint | string | number = 0n,
): bigint {
  const requestedBits = parseIntentBits(requested);
  if ((requestedBits & ~KNOWN_INTENTS) !== 0n) {
    throw new GatewayIntentError(4013, 'Invalid intent bit(s) were requested.');
  }
  const enabledPrivileged = parseIntentBits(portalEnabledPrivileged) & PRIVILEGED_INTENTS;
  const disallowed = requestedBits & PRIVILEGED_INTENTS & ~enabledPrivileged;
  if (disallowed !== 0n) {
    throw new GatewayIntentError(
      4014,
      `Disallowed privileged intent bits: ${disallowed.toString()}.`,
    );
  }
  return requestedBits;
}

export class GatewayIntentError extends Error {
  public readonly closeCode: 4013 | 4014;
  public constructor(closeCode: 4013 | 4014, message: string) {
    super(message);
    this.name = 'GatewayIntentError';
    this.closeCode = closeCode;
  }
}

export function parseIntentBits(value: bigint | string | number): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('Numeric intent bitfields must be non-negative safe integers.');
  }
  const result = BigInt(value);
  if (result < 0n) throw new RangeError('Intent bitfields cannot be negative.');
  return result;
}

export function requiredIntentForEvent(eventName: string, data: unknown): bigint | undefined {
  const guildEvent = hasGuildId(data);
  if (
    eventName === 'MESSAGE_CREATE' ||
    eventName === 'MESSAGE_UPDATE' ||
    eventName === 'MESSAGE_DELETE'
  ) {
    return guildEvent ? GatewayIntents.GUILD_MESSAGES : GatewayIntents.DIRECT_MESSAGES;
  }
  if (eventName.startsWith('MESSAGE_REACTION_')) {
    return guildEvent
      ? GatewayIntents.GUILD_MESSAGE_REACTIONS
      : GatewayIntents.DIRECT_MESSAGE_REACTIONS;
  }
  if (eventName === 'TYPING_START') {
    return guildEvent ? GatewayIntents.GUILD_MESSAGE_TYPING : GatewayIntents.DIRECT_MESSAGE_TYPING;
  }
  if (eventName.startsWith('MESSAGE_POLL_VOTE_')) {
    return guildEvent ? GatewayIntents.GUILD_MESSAGE_POLLS : GatewayIntents.DIRECT_MESSAGE_POLLS;
  }
  if (eventName.startsWith('GUILD_MEMBER_')) return GatewayIntents.GUILD_MEMBERS;
  if (eventName.startsWith('GUILD_BAN_') || eventName === 'GUILD_AUDIT_LOG_ENTRY_CREATE') {
    return GatewayIntents.GUILD_MODERATION;
  }
  if (eventName === 'GUILD_EMOJIS_UPDATE' || eventName === 'GUILD_STICKERS_UPDATE') {
    return GatewayIntents.GUILD_EXPRESSIONS;
  }
  if (eventName.startsWith('GUILD_INTEGRATIONS_') || eventName.startsWith('INTEGRATION_')) {
    return GatewayIntents.GUILD_INTEGRATIONS;
  }
  if (eventName === 'WEBHOOKS_UPDATE') return GatewayIntents.GUILD_WEBHOOKS;
  if (eventName.startsWith('INVITE_')) return GatewayIntents.GUILD_INVITES;
  if (eventName === 'VOICE_STATE_UPDATE' || eventName === 'VOICE_SERVER_UPDATE') {
    return GatewayIntents.GUILD_VOICE_STATES;
  }
  if (eventName === 'PRESENCE_UPDATE') return GatewayIntents.GUILD_PRESENCES;
  if (eventName.startsWith('GUILD_SCHEDULED_EVENT_')) return GatewayIntents.GUILD_SCHEDULED_EVENTS;
  if (eventName.startsWith('AUTO_MODERATION_RULE_'))
    return GatewayIntents.AUTO_MODERATION_CONFIGURATION;
  if (eventName === 'AUTO_MODERATION_ACTION_EXECUTION')
    return GatewayIntents.AUTO_MODERATION_EXECUTION;
  if (
    eventName.startsWith('GUILD_') ||
    eventName.startsWith('CHANNEL_') ||
    eventName.startsWith('THREAD_') ||
    eventName === 'READY'
  ) {
    return GatewayIntents.GUILDS;
  }
  return undefined;
}

function messageContentIsExempt(data: unknown, botUserId: string | undefined): boolean {
  if (!isRecord(data)) return false;
  if (!hasGuildId(data)) return true;
  if (botUserId === undefined) return false;
  const author = data['author'];
  if (isRecord(author) && author['id'] === botUserId) return true;
  const mentions = data['mentions'];
  return (
    Array.isArray(mentions) &&
    mentions.some((mention) => isRecord(mention) && mention['id'] === botUserId)
  );
}

function stripMessageContent<T>(data: T): T {
  if (!isRecord(data)) return structuredClone(data);
  return {
    ...structuredClone(data),
    content: '',
    embeds: [],
    attachments: [],
    components: [],
    poll: null,
  };
}

function hasGuildId(data: unknown): boolean {
  return isRecord(data) && typeof data['guild_id'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
