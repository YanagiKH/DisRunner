import {
  validateLegacyModalResponse,
  validateAutocompleteResponse,
  findFocusedAutocompleteOptionType,
} from './interaction-controls.js';
import { isDeepStrictEqual } from 'node:util';
import type { ResourceRecord, RiskFinding, SimulationProfile } from './contracts.js';
import type { VirtualClock } from './clock.js';
import type { SeededRandom, SnowflakeGenerator } from './random.js';
import {
  assertMessageCommandIdle,
  messageCommandActive,
  withMessageCommand,
} from './message-command-guard.js';
import {
  InteractionMessageDomain,
  cloneInteractionPayload,
  validateInteractionMessagePayload,
  interactionMessagePayload,
  type InteractionMessageAuthorityOptions,
  type InteractionMessageCommand,
  type InteractionMessageProfile,
  type InteractionMessageResult,
} from './interaction-message-domain.js';
import { assertSyntheticToken } from './session-token.js';

export type InteractionResponseType =
  'message' | 'defer' | 'update' | 'defer-update' | 'autocomplete' | 'modal';
export type InteractionStatus = 'pending' | 'deferred' | 'responded' | 'deleted' | 'expired';

export interface InteractionResponse {
  readonly type: InteractionResponseType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly atMs: number;
  readonly ephemeral: boolean;
}

export interface InteractionFollowup {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly atMs: number;
  readonly ephemeral: boolean;
  readonly deleted: boolean;
}

/**
 * Fixed provenance of an interaction (who sent it, and where). It is recorded, copied, and
 * returned as-is; it is not a role or permission decision.
 */
export interface InteractionContext {
  readonly actorId: string;
  readonly channelId: string;
  readonly guildId?: string;
}

export interface SimulatedInteraction {
  readonly messageProfile?: 'chat-input-messages-v1' | 'interactions-v1';
  readonly sourceMessageId?: string;
  readonly originalMessageId?: string;
  readonly id: string;
  readonly token: string;
  readonly applicationId?: string;
  readonly context?: InteractionContext;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAtMs: number;
  readonly initialDeadlineAtMs: number;
  readonly tokenExpiresAtMs: number;
  readonly status: InteractionStatus;
  readonly acknowledgedAtMs?: number;
  readonly initialResponse?: InteractionResponse;
  readonly followups: readonly InteractionFollowup[];
}

interface MutableInteraction {
  messageProfile?: 'chat-input-messages-v1' | 'interactions-v1';
  sourceMessageId?: string;
  originalMessageId?: string;
  id: string;
  token: string;
  applicationId?: string;
  context?: InteractionContext;
  type: string;
  data: Readonly<Record<string, unknown>>;
  createdAtMs: number;
  initialDeadlineAtMs: number;
  tokenExpiresAtMs: number;
  status: InteractionStatus;
  acknowledgedAtMs?: number;
  initialResponse?: InteractionResponse;
  followups: InteractionFollowup[];
  timeoutReported: boolean;
  retainedBytes: number;
}

export interface InteractionEngineOptions {
  readonly messageAuthority?: InteractionMessageAuthorityOptions;
  readonly clock: VirtualClock;
  readonly random: SeededRandom;
  readonly snowflakes: SnowflakeGenerator;
  readonly profile: SimulationProfile;
  readonly onRisk?: (finding: RiskFinding) => void;
  readonly maxInteractions?: number;
  readonly maxFollowupsPerInteraction?: number;
  readonly maxPayloadBytes?: number;
  readonly maxRetainedBytesPerInteraction?: number;
  readonly maxRetainedBytes?: number;
  /** Application every created interaction is bound to; required by the token HTTP routes. */
  readonly applicationId?: string;
}

export class InteractionEngine {
  readonly #clock: VirtualClock;
  readonly #random: SeededRandom;
  readonly #snowflakes: SnowflakeGenerator;
  readonly #profile: SimulationProfile;
  readonly #onRisk: ((finding: RiskFinding) => void) | undefined;
  readonly #interactions = new Map<string, MutableInteraction>();
  readonly #tokenIndex = new Map<string, string>();
  readonly #maxInteractions: number;
  readonly #maxFollowupsPerInteraction: number;
  readonly #maxPayloadBytes: number;
  readonly #maxRetainedBytesPerInteraction: number;
  readonly #maxRetainedBytes: number;
  readonly #applicationId: string | undefined;
  readonly #messageAuthority: InteractionMessageAuthorityOptions | undefined;
  readonly #messageDomain: InteractionMessageDomain | undefined;
  #retainedBytes = 0;

  public constructor(options: InteractionEngineOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#snowflakes = options.snowflakes;
    this.#profile = options.profile;
    this.#onRisk = options.onRisk;
    this.#maxInteractions = boundedCount(options.maxInteractions ?? 10_000, 'maxInteractions');
    this.#maxFollowupsPerInteraction = boundedCount(
      options.maxFollowupsPerInteraction ?? 1_000,
      'maxFollowupsPerInteraction',
    );
    this.#maxPayloadBytes = boundedPayloadBytes(options.maxPayloadBytes ?? 1_048_576);
    this.#maxRetainedBytesPerInteraction = boundedRetainedBytes(
      options.maxRetainedBytesPerInteraction ?? 8_388_608,
      'maxRetainedBytesPerInteraction',
    );
    this.#maxRetainedBytes = boundedRetainedBytes(
      options.maxRetainedBytes ?? 67_108_864,
      'maxRetainedBytes',
    );
    this.#applicationId =
      options.applicationId === undefined
        ? undefined
        : requireCanonicalId(options.applicationId, 'applicationId');
    this.#messageAuthority =
      options.messageAuthority === undefined
        ? undefined
        : {
            state: options.messageAuthority.state,
            gateway: options.messageAuthority.gateway,
            author: structuredClone(options.messageAuthority.author),
            context: { ...options.messageAuthority.context },
          };
    if (
      this.#messageAuthority !== undefined &&
      this.#applicationId !== this.#messageAuthority.gateway.applicationId
    )
      throw new TypeError('Interaction application must match the Gateway application.');
    this.#messageDomain =
      this.#messageAuthority === undefined
        ? undefined
        : new InteractionMessageDomain(this.#messageAuthority);
  }

  public create(
    input: {
      readonly id?: string;
      readonly token?: string;
      readonly type?: string;
      readonly data?: Readonly<Record<string, unknown>>;
      readonly context?: InteractionContext;
      readonly messageProfile?: InteractionMessageProfile;
      readonly sourceMessageId?: string;
    } = {},
  ): SimulatedInteraction {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(input.messageProfile)) return this.#createAuthoritative(input);
    if (input.messageProfile !== undefined && input.messageProfile !== 'model')
      throw unsupportedMessageProfile();
    // The application ID always comes from the engine; same-name input or data fields are ignored.
    const context = input.context === undefined ? undefined : copyContext(input.context);
    const data = cloneBoundedPayload(input.data ?? {}, this.#maxPayloadBytes, 'Interaction data');
    const type = boundedText(input.type ?? 'command', 'Interaction type', 64);
    const suppliedToken = input.token === undefined ? undefined : assertSyntheticToken(input.token);
    if (suppliedToken !== undefined && this.#tokenIndex.has(suppliedToken)) {
      throw new DiscordApiError(409, 40041, 'Interaction token already exists.');
    }
    if (this.#messageAuthority === undefined) this.#ensureInteractionCapacity();
    const id = boundedText(input.id ?? this.#snowflakes.generate(), 'Interaction id', 64);
    if (this.#interactions.has(id))
      throw new DiscordApiError(409, 40041, 'Interaction already exists.');
    const token =
      suppliedToken ??
      assertSyntheticToken(`disrunner.offline.interaction_${this.#random.token(24)}`);
    const createdAtMs = this.#clock.now();
    const interaction: MutableInteraction = {
      id,
      token,
      ...(this.#applicationId === undefined ? {} : { applicationId: this.#applicationId }),
      ...(context === undefined ? {} : { context }),
      type,
      data,
      createdAtMs,
      initialDeadlineAtMs: createdAtMs + this.#profile.interactionDeadlineMs,
      tokenExpiresAtMs: createdAtMs + this.#profile.interactionTokenTtlMs,
      status: 'pending',
      followups: [],
      timeoutReported: false,
      retainedBytes: 0,
    };
    const retainedBytes = retainedInteractionBytes(interaction);
    this.#assertInteractionRetainedSize(retainedBytes);
    if (this.#messageAuthority === undefined) this.#ensureRetainedCapacity(retainedBytes);
    else
      for (const removed of this.#planCapacity(retainedBytes, true)) {
        this.#removeInteraction(removed, this.#interactions.get(removed)!);
      }
    interaction.retainedBytes = retainedBytes;
    this.#interactions.set(id, interaction);
    this.#tokenIndex.set(token, id);
    this.#retainedBytes += retainedBytes;
    return this.#snapshot(interaction);
  }

  public get(id: string): SimulatedInteraction | undefined {
    const interaction = this.#interactions.get(id);
    if (interaction === undefined) return undefined;
    this.#refresh(interaction);
    return this.#snapshot(interaction);
  }

  public require(id: string): SimulatedInteraction {
    const interaction = this.#requireMutable(id);
    return this.#snapshot(interaction);
  }

  public list(): readonly SimulatedInteraction[] {
    if (!this.#commandActive())
      for (const interaction of this.#interactions.values()) {
        if (interaction.messageProfile === undefined) this.#refresh(interaction);
      }
    return [...this.#interactions.values()].map((interaction) => this.#snapshot(interaction));
  }

  public getByToken(token: string): SimulatedInteraction | undefined {
    const id = this.#tokenIndex.get(token);
    const interaction = id === undefined ? undefined : this.#interactions.get(id);
    if (interaction === undefined) return undefined;
    this.#refresh(interaction);
    return this.#snapshot(interaction);
  }

  public retainedByteCount(): number {
    return this.#retainedBytes;
  }

  public respond(
    id: string,
    responseType: InteractionResponseType,
    data: Readonly<Record<string, unknown>> = {},
  ): SimulatedInteraction {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(id)?.messageProfile))
      return this.executeMessage({ operation: 'respond', interactionId: id, responseType, data })
        .interaction;
    const interaction = this.#interactions.get(id);
    if (interaction === undefined) throw new DiscordApiError(404, 10062, 'Unknown interaction.');
    this.#refresh(interaction);
    if (interaction.status === 'expired') {
      throw new DiscordApiError(404, 10062, 'Unknown interaction.');
    }
    if (interaction.status !== 'pending') {
      this.#emitRisk(
        interaction,
        'DOUBLE_INTERACTION_RESPONSE',
        'high',
        'The interaction received more than one initial response.',
      );
      throw new DiscordApiError(400, 40060, 'Interaction has already been acknowledged.');
    }
    validateResponseType(interaction.type, responseType);
    const clonedData = cloneBoundedPayload(data, this.#maxPayloadBytes, 'Interaction response');
    const acknowledgedAtMs = this.#clock.now();
    const status =
      responseType === 'defer' || responseType === 'defer-update' ? 'deferred' : 'responded';
    const response: InteractionResponse = {
      type: responseType,
      data: clonedData,
      atMs: acknowledgedAtMs,
      ephemeral: isEphemeral(clonedData),
    };
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      initialResponse: response,
      acknowledgedAtMs,
      status,
    });
    interaction.initialResponse = response;
    interaction.acknowledgedAtMs = acknowledgedAtMs;
    interaction.status = status;
    this.#commitResize(interaction, retainedBytes);
    return this.#snapshot(interaction);
  }

  public followup(id: string, data: Readonly<Record<string, unknown>> = {}): InteractionFollowup {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(id)?.messageProfile)) {
      const result = this.executeMessage({ operation: 'create-followup', interactionId: id, data });
      const message = result.message!;
      return {
        id: message.id,
        data: interactionMessagePayload(message),
        atMs:
          result.interaction.followups.find((entry) => entry.id === message.id)?.atMs ??
          result.interaction.initialResponse!.atMs,
        ephemeral: ((message['flags'] as number) & 64) !== 0,
        deleted: false,
      };
    }
    const interaction = this.#requireUsableToken(id);
    if (interaction.status === 'pending') {
      this.#emitRisk(
        interaction,
        'FOLLOWUP_BEFORE_ACK',
        'high',
        'A follow-up was attempted before the initial response.',
      );
      throw new DiscordApiError(
        400,
        40061,
        'Interaction must be acknowledged before creating a follow-up.',
      );
    }
    if (interaction.followups.length >= this.#maxFollowupsPerInteraction) {
      throw new InteractionCapacityError(
        `An interaction cannot retain more than ${this.#maxFollowupsPerInteraction} follow-ups.`,
      );
    }
    const clonedData = cloneBoundedPayload(data, this.#maxPayloadBytes, 'Interaction follow-up');
    const followup: InteractionFollowup = {
      id: this.#snowflakes.generate(),
      data: clonedData,
      atMs: this.#clock.now(),
      ephemeral: isEphemeral(clonedData),
      deleted: false,
    };
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      followups: [...interaction.followups, followup],
    });
    interaction.followups.push(followup);
    this.#commitResize(interaction, retainedBytes);
    return structuredClone(followup);
  }

  public editOriginal(id: string, data: Readonly<Record<string, unknown>>): SimulatedInteraction {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(id)?.messageProfile))
      return this.executeMessage({ operation: 'edit-original', interactionId: id, data })
        .interaction;
    const interaction = this.#requireUsableToken(id);
    if (interaction.status === 'pending') {
      throw new DiscordApiError(404, 10015, 'Unknown webhook.');
    }
    if (interaction.status === 'deleted') throw new DiscordApiError(404, 10008, 'Unknown message.');
    const ephemeral = interaction.initialResponse?.ephemeral ?? false;
    const mergedData = this.#mergePatch(
      interaction.initialResponse?.data ?? {},
      data,
      ephemeral,
      'Interaction response',
    );
    const response: InteractionResponse = {
      type: 'message',
      data: mergedData,
      atMs: this.#clock.now(),
      ephemeral,
    };
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      initialResponse: response,
      status: 'responded',
    });
    interaction.initialResponse = response;
    interaction.status = 'responded';
    this.#commitResize(interaction, retainedBytes);
    return this.#snapshot(interaction);
  }

  public deleteOriginal(id: string): SimulatedInteraction {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(id)?.messageProfile))
      return this.executeMessage({ operation: 'delete-original', interactionId: id }).interaction;
    const interaction = this.#requireUsableToken(id);
    if (interaction.status === 'pending') throw new DiscordApiError(404, 10015, 'Unknown webhook.');
    if (interaction.status === 'deleted') throw new DiscordApiError(404, 10008, 'Unknown message.');
    const retainedBytes = this.#prepareResize(interaction, { ...interaction, status: 'deleted' });
    interaction.status = 'deleted';
    this.#commitResize(interaction, retainedBytes);
    return this.#snapshot(interaction);
  }

  public editFollowup(
    interactionId: string,
    followupId: string,
    data: Readonly<Record<string, unknown>>,
  ): InteractionFollowup {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(interactionId)?.messageProfile)) {
      const result = this.executeMessage({
        operation: 'edit-followup',
        interactionId,
        messageId: followupId,
        data,
      });
      return result.interaction.followups.find((entry) => entry.id === followupId)!;
    }
    const interaction = this.#requireUsableToken(interactionId);
    const index = interaction.followups.findIndex(
      (followup) => followup.id === followupId && !followup.deleted,
    );
    if (index < 0) throw new DiscordApiError(404, 10008, 'Unknown message.');
    const current = interaction.followups[index] as InteractionFollowup;
    const updated: InteractionFollowup = {
      ...current,
      data: this.#mergePatch(current.data, data, current.ephemeral, 'Interaction follow-up'),
      ephemeral: current.ephemeral,
    };
    const nextFollowups = [...interaction.followups];
    nextFollowups[index] = updated;
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      followups: nextFollowups,
    });
    interaction.followups[index] = updated;
    this.#commitResize(interaction, retainedBytes);
    return structuredClone(updated);
  }

  public deleteFollowup(interactionId: string, followupId: string): void {
    this.#assertLifecycleIdle();
    if (authoritativeProfile(this.#interactions.get(interactionId)?.messageProfile)) {
      this.executeMessage({ operation: 'delete-followup', interactionId, messageId: followupId });
      return;
    }
    const interaction = this.#requireUsableToken(interactionId);
    const index = interaction.followups.findIndex(
      (followup) => followup.id === followupId && !followup.deleted,
    );
    if (index < 0) throw new DiscordApiError(404, 10008, 'Unknown message.');
    const current = interaction.followups[index] as InteractionFollowup;
    const deleted = { ...current, deleted: true };
    const nextFollowups = [...interaction.followups];
    nextFollowups[index] = deleted;
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      followups: nextFollowups,
    });
    interaction.followups[index] = deleted;
    this.#commitResize(interaction, retainedBytes);
  }

  public sweepExpired(): readonly SimulatedInteraction[] {
    this.#assertLifecycleIdle();
    const expired: SimulatedInteraction[] = [];
    for (const interaction of this.#interactions.values()) {
      const previous = interaction.status;
      this.#refresh(interaction, true);
      if (previous !== 'expired' && interaction.status === 'expired')
        expired.push(this.#snapshot(interaction));
    }
    return expired;
  }

  public executeMessage(command: InteractionMessageCommand): InteractionMessageResult {
    const authority = this.#messageAuthority;
    if (authority === undefined) throw unsupportedMessageProfile();
    return withMessageCommand(authority.state, () => {
      const interaction = this.#requireAuthoritative(
        command.interactionId,
        command.operation === 'respond',
      );
      const domain = this.#messageDomain as InteractionMessageDomain;
      const context = interaction.context as InteractionContext;
      const applicationId = interaction.applicationId as string;
      domain.assertContext(context);
      const candidate: MutableInteraction = {
        ...interaction,
        followups: [...interaction.followups],
      };
      let operation: 'create' | 'update' | 'delete' | 'none' = 'none';
      let kind: 'original' | 'followup' | undefined;
      let current: ResourceRecord | undefined;
      let payload: Readonly<Record<string, unknown>> | undefined;
      let messageId: string | undefined;
      let loading = false;
      const now = this.#clock.now();
      const normalized = (
        data: Readonly<Record<string, unknown>>,
        existing?: ResourceRecord,
        materializing = false,
      ) =>
        validateInteractionMessagePayload(
          interaction.messageProfile === 'interactions-v1'
            ? Object.fromEntries(
                Object.entries(data).filter(
                  ([key, value]) =>
                    !(key === 'enforce_nonce' && value === false) &&
                    !(existing !== undefined && key === 'tts' && value === false),
                ),
              )
            : data,
          this.#maxPayloadBytes,
          existing,
          materializing,
          interaction.messageProfile === 'interactions-v1',
        );
      if (command.operation === 'respond') {
        if (interaction.status !== 'pending')
          throw new DiscordApiError(400, 40060, 'Interaction has already been acknowledged.');
        try {
          validateResponseType(interaction.type, command.responseType);
        } catch {
          throw invalidInteractionPayload();
        }
        const data = cloneAuthorityPayload(
          command.data === undefined ? {} : command.data,
          this.#maxPayloadBytes,
        );
        if (command.responseType === 'message') {
          payload = normalized(data);
          operation = 'create';
          kind = 'original';
        } else if (command.responseType === 'defer') {
          if (
            Object.keys(data).some((key) => key !== 'flags') ||
            (Object.hasOwn(data, 'flags') && data['flags'] !== 0 && data['flags'] !== 64)
          )
            throw invalidInteractionPayload();
          payload = {
            content: '',
            embeds: [],
            components: [],
            attachments: [],
            tts: false,
            flags: data['flags'] ?? 0,
          };
          operation = 'create';
          kind = 'original';
          loading = true;
        } else if (command.responseType === 'update' || command.responseType === 'defer-update') {
          const source =
            interaction.sourceMessageId === undefined
              ? undefined
              : authority.state.get('message', interaction.sourceMessageId);
          if (
            source === undefined ||
            source['channel_id'] !== context.channelId ||
            source['guild_id'] !== context.guildId ||
            (source['application_id'] !== undefined &&
              source['application_id'] !== applicationId) ||
            !isPlainObject(source['author']) ||
            source['author']['id'] !== authority.author.id ||
            source['author']['bot'] !== true ||
            (source['visibility'] === 'ephemeral' && source['recipient_id'] !== context.actorId)
          )
            throw unknownInteractionMessage();
          if (command.responseType === 'defer-update' && Object.keys(data).length !== 0)
            throw invalidInteractionPayload();
          current = source;
          messageId = source.id;
          kind = 'original';
          candidate.originalMessageId = source.id;
          if (command.responseType === 'update') {
            payload = normalized(data, source);
            operation = 'update';
          }
        } else if (command.responseType === 'autocomplete') {
          if (interaction.messageProfile === 'interactions-v1')
            validateAutocompleteResponse(
              data,
              this.#maxPayloadBytes,
              findFocusedAutocompleteOptionType(interaction.data, this.#maxPayloadBytes),
            );
          const choices = data['choices'];
          if (
            Object.keys(data).some((key) => key !== 'choices') ||
            !Array.isArray(choices) ||
            choices.length > 25 ||
            choices.some(
              (choice) =>
                !isPlainObject(choice) ||
                typeof choice['name'] !== 'string' ||
                choice['name'].length < 1 ||
                choice['name'].length > 100 ||
                !['string', 'number'].includes(typeof choice['value']),
            )
          )
            throw invalidInteractionPayload();
        } else if (command.responseType === 'modal') {
          if (interaction.messageProfile === 'interactions-v1')
            validateLegacyModalResponse(data, this.#maxPayloadBytes);
          if (
            interaction.messageProfile === 'interactions-v1' &&
            (typeof data['custom_id'] !== 'string' ||
              data['custom_id'].length < 1 ||
              data['custom_id'].length > 100 ||
              typeof data['title'] !== 'string' ||
              data['title'].length < 1 ||
              data['title'].length > 45 ||
              !Array.isArray(data['components']) ||
              data['components'].length < 1 ||
              data['components'].length > 5)
          )
            throw invalidInteractionPayload();
        } else throw invalidInteractionPayload();
        candidate.acknowledgedAtMs = now;
        candidate.status =
          command.responseType === 'defer' || command.responseType === 'defer-update'
            ? 'deferred'
            : 'responded';
        candidate.initialResponse = {
          type: command.responseType,
          data: operation === 'none' ? data : {},
          atMs: now,
          ephemeral: payload === undefined ? isEphemeral(data) : isEphemeral(payload),
        };
      } else {
        if (interaction.status === 'pending')
          throw new DiscordApiError(
            400,
            40061,
            'Interaction must be acknowledged before creating a follow-up.',
          );
        if (command.operation === 'create-followup') {
          const original =
            interaction.originalMessageId === undefined
              ? undefined
              : authority.state.get('message', interaction.originalMessageId);
          if (
            original !== undefined &&
            interaction.status === 'deferred' &&
            ((original['flags'] as number) & 128) !== 0
          ) {
            current = this.#ownedMessage(interaction, original.id, 'original');
            const created = normalized(command.data);
            payload = {
              ...created,
              flags: ((created['flags'] as number) & ~64) | ((current['flags'] as number) & 64),
            };
            operation = 'update';
            kind = 'original';
            messageId = current.id;
            candidate.status = 'responded';
            candidate.initialResponse = {
              type: 'message',
              data: {},
              atMs: now,
              ephemeral: isEphemeral(payload),
            };
          } else {
            if (interaction.followups.length >= this.#maxFollowupsPerInteraction)
              throw new InteractionCapacityError('Interaction follow-up capacity exceeded.');
            payload = normalized(command.data);
            operation = 'create';
            kind = 'followup';
          }
        } else if (
          command.operation === 'edit-original' ||
          command.operation === 'delete-original'
        ) {
          if (interaction.originalMessageId === undefined || interaction.status === 'deleted')
            throw unknownInteractionMessage();
          current = this.#ownedMessage(interaction, interaction.originalMessageId, 'original');
          kind = 'original';
          messageId = current.id;
          if (command.operation === 'delete-original') {
            operation = 'delete';
            candidate.status = 'deleted';
          } else {
            const materializing = ((current['flags'] as number) & 128) !== 0;
            const updated = normalized(command.data, current, materializing);
            payload = { ...updated, flags: (updated['flags'] as number) & ~128 };
            operation = 'update';
            candidate.status = 'responded';
            candidate.initialResponse = {
              type: 'message',
              data: {},
              atMs: now,
              ephemeral: isEphemeral(payload),
            };
          }
        } else if (
          command.operation === 'edit-followup' ||
          command.operation === 'delete-followup'
        ) {
          const index = interaction.followups.findIndex(
            (entry) => entry.id === command.messageId && !entry.deleted,
          );
          if (index < 0) throw unknownInteractionMessage();
          current = this.#ownedMessage(interaction, command.messageId, 'followup');
          kind = 'followup';
          messageId = current.id;
          if (command.operation === 'delete-followup') {
            operation = 'delete';
            candidate.followups[index] = {
              ...candidate.followups[index]!,
              data: {},
              deleted: true,
            };
          } else {
            payload = normalized(command.data, current);
            operation = 'update';
          }
        }
      }
      if (
        command.operation !== 'respond' &&
        operation === 'update' &&
        current !== undefined &&
        isDeepStrictEqual(interactionMessagePayload(current), payload)
      ) {
        return {
          interaction: this.#snapshot(interaction),
          message: current,
          stateRevision: authority.state.revision,
          eventId: null,
          delivery: null,
        };
      }
      if (operation === 'create') {
        do {
          messageId = this.#snowflakes.generate();
        } while (messageId === interaction.id);
        if (kind === 'original') candidate.originalMessageId = messageId;
        else
          candidate.followups.push({
            id: messageId,
            data: {},
            atMs: now,
            ephemeral: isEphemeral(payload!),
            deleted: false,
          });
      }
      const beforeInteractions = new Map(this.#interactions);
      const beforeTokens = new Map(this.#tokenIndex);
      const beforeBytes = this.#retainedBytes;
      let committedInteraction: SimulatedInteraction | undefined;
      try {
        const result = domain.commit(
          {
            operation,
            componentSource:
              current?.id === interaction.sourceMessageId &&
              current?.['message_origin'] !== 'interaction',
            interactionId: interaction.id,
            ...(interaction.messageProfile === 'interactions-v1'
              ? {
                  interactionMetadata: {
                    id: interaction.id,
                    type:
                      interaction.type === 'component'
                        ? 3
                        : interaction.type === 'modal-submit'
                          ? 5
                          : 2,
                    user: {
                      id: context.actorId,
                      username:
                        authority.state.get('user', context.actorId)?.['username'] ?? 'User',
                      discriminator: '0',
                      avatar: null,
                      bot: false,
                    },
                    authorizing_integration_owners: context.guildId ? { '0': context.guildId } : {},
                  },
                }
              : {}),
            applicationId,
            context,
            ...(kind === undefined ? {} : { kind }),
            ...(current === undefined ? {} : { current }),
            ...(messageId === undefined ? {} : { messageId }),
            ...(payload === undefined ? {} : { payload }),
            loading,
          },
          () => {
            committedInteraction = this.#snapshot(candidate);
            const retainedBytes = Buffer.byteLength(
              JSON.stringify(this.#snapshot(candidate, false)),
            );
            const evictions = this.#planCapacity(
              retainedBytes - interaction.retainedBytes,
              false,
              interaction.id,
            );
            this.#assertInteractionRetainedSize(retainedBytes);
            for (const id of evictions) this.#removeInteraction(id, this.#interactions.get(id)!);
            candidate.retainedBytes = retainedBytes;
            this.#interactions.set(candidate.id, candidate);
            this.#retainedBytes += retainedBytes - interaction.retainedBytes;
          },
        );
        return { ...result, interaction: committedInteraction! };
      } catch (error) {
        this.#interactions.clear();
        for (const [id, value] of beforeInteractions) this.#interactions.set(id, value);
        this.#tokenIndex.clear();
        for (const [token, id] of beforeTokens) this.#tokenIndex.set(token, id);
        this.#retainedBytes = beforeBytes;
        throw error;
      }
    });
  }

  public getOriginalMessage(interactionId: string): ResourceRecord {
    const interaction = this.#requireAuthoritative(interactionId);
    if (interaction.originalMessageId === undefined || interaction.status === 'deleted')
      throw unknownInteractionMessage();
    return this.#ownedMessage(interaction, interaction.originalMessageId, 'original');
  }
  public getFollowupMessage(interactionId: string, messageId: string): ResourceRecord {
    const interaction = this.#requireAuthoritative(interactionId);
    if (!interaction.followups.some((entry) => entry.id === messageId && !entry.deleted))
      throw unknownInteractionMessage();
    return this.#ownedMessage(interaction, messageId, 'followup');
  }

  #assertLifecycleIdle(): void {
    if (this.#messageAuthority !== undefined)
      assertMessageCommandIdle(this.#messageAuthority.state);
  }
  #commandActive(): boolean {
    return (
      this.#messageAuthority !== undefined && messageCommandActive(this.#messageAuthority.state)
    );
  }
  #effectiveStatus(interaction: MutableInteraction): InteractionStatus {
    return this.#clock.now() >= interaction.tokenExpiresAtMs ||
      (interaction.status === 'pending' && this.#clock.now() >= interaction.initialDeadlineAtMs)
      ? 'expired'
      : interaction.status;
  }
  #requireAuthoritative(id: string, initial = false): MutableInteraction {
    const interaction = this.#interactions.get(id);
    if (interaction === undefined)
      throw new DiscordApiError(
        404,
        initial ? 10062 : 10015,
        initial ? 'Unknown interaction.' : 'Unknown webhook.',
      );
    if (!authoritativeProfile(interaction.messageProfile) || this.#messageAuthority === undefined)
      throw unsupportedMessageProfile();
    if (this.#effectiveStatus(interaction) === 'expired')
      throw new DiscordApiError(
        404,
        initial ? 10062 : 10015,
        initial ? 'Unknown interaction.' : 'Unknown webhook.',
      );
    return interaction;
  }
  #ownedMessage(
    interaction: MutableInteraction,
    id: string,
    kind: 'original' | 'followup',
  ): ResourceRecord {
    const message = this.#messageAuthority?.state.get('message', id);
    if (
      message === undefined ||
      message['channel_id'] !== interaction.context?.channelId ||
      message['guild_id'] !== interaction.context?.guildId
    )
      throw unknownInteractionMessage();
    const source = kind === 'original' && id === interaction.sourceMessageId;
    if (source) {
      const author = message['author'];
      if (
        !isPlainObject(author) ||
        author['id'] !== this.#messageAuthority?.author.id ||
        author['bot'] !== true ||
        (message['application_id'] !== undefined &&
          message['application_id'] !== interaction.applicationId) ||
        (message['visibility'] === 'ephemeral' &&
          message['recipient_id'] !== interaction.context?.actorId)
      )
        throw unknownInteractionMessage();
    } else if (
      message['message_origin'] !== 'interaction' ||
      message['interaction_id'] !== interaction.id ||
      message['interaction_message_kind'] !== kind ||
      message['application_id'] !== interaction.applicationId ||
      message['webhook_id'] !== interaction.applicationId
    )
      throw unknownInteractionMessage();
    return message;
  }
  #snapshot(interaction: MutableInteraction, deriveStatus = true): SimulatedInteraction {
    const snapshot = cloneInteraction(interaction);
    if (!authoritativeProfile(interaction.messageProfile)) return snapshot;
    let initialResponse = snapshot.initialResponse;
    if (initialResponse !== undefined && interaction.originalMessageId !== undefined) {
      const original = this.#messageAuthority?.state.get('message', interaction.originalMessageId);
      initialResponse = {
        ...initialResponse,
        data:
          original === undefined || interaction.status === 'deleted'
            ? {}
            : interactionMessagePayload(original),
      };
    }
    const followups = snapshot.followups.map((entry) => {
      const message = entry.deleted
        ? undefined
        : this.#messageAuthority?.state.get('message', entry.id);
      return { ...entry, data: message === undefined ? {} : interactionMessagePayload(message) };
    });
    return {
      ...snapshot,
      status: deriveStatus ? this.#effectiveStatus(interaction) : interaction.status,
      ...(initialResponse === undefined ? {} : { initialResponse }),
      followups,
    };
  }
  #authorityRetainedBytes(interaction: MutableInteraction): number {
    return Buffer.byteLength(JSON.stringify(this.#snapshot(interaction, false)));
  }
  #planCapacity(additionalBytes: number, adding: boolean, protectedId?: string): string[] {
    let bytes = this.#retainedBytes + additionalBytes;
    let count = this.#interactions.size + (adding ? 1 : 0);
    const evictions: string[] = [];
    for (const [id, entry] of this.#interactions) {
      if (bytes <= this.#maxRetainedBytes && count <= this.#maxInteractions) break;
      if (id !== protectedId && this.#effectiveStatus(entry) === 'expired') {
        evictions.push(id);
        bytes -= entry.retainedBytes;
        count -= 1;
      }
    }
    if (bytes > this.#maxRetainedBytes || count > this.#maxInteractions)
      throw new InteractionCapacityError('Interaction registry capacity exceeded.');
    return evictions;
  }
  #createAuthoritative(input: {
    readonly id?: string;
    readonly token?: string;
    readonly type?: string;
    readonly messageProfile?: InteractionMessageProfile;
    readonly sourceMessageId?: string;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly context?: InteractionContext;
  }): SimulatedInteraction {
    const authority = this.#messageAuthority;
    if (authority === undefined) throw unsupportedMessageProfile();
    return withMessageCommand(authority.state, () => {
      const data = cloneAuthorityPayload(input.data ?? {}, this.#maxPayloadBytes);
      const context = input.context === undefined ? undefined : copyContext(input.context);
      if (
        (input.messageProfile === 'chat-input-messages-v1'
          ? (input.type ?? 'command') !== 'command' || data['type'] !== 1
          : !MODELED_INTERACTION_KINDS.has(input.type ?? 'command')) ||
        context === undefined ||
        this.#applicationId === undefined
      )
        throw new DiscordApiError(400, 50035, 'Invalid authoritative interaction context.');
      this.#messageDomain!.assertContext(context);
      const id = boundedText(input.id ?? this.#snowflakes.generate(), 'Interaction id', 64);
      const token =
        input.token === undefined
          ? assertSyntheticToken(`disrunner.offline.interaction_${this.#random.token(24)}`)
          : assertSyntheticToken(input.token);
      if (this.#interactions.has(id) || this.#tokenIndex.has(token))
        throw new DiscordApiError(409, 40041, 'Interaction already exists.');
      const createdAtMs = this.#clock.now();
      const interaction: MutableInteraction = {
        id,
        token,
        applicationId: this.#applicationId,
        context,
        type: input.type ?? 'command',
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
        data,
        createdAtMs,
        initialDeadlineAtMs: createdAtMs + this.#profile.interactionDeadlineMs,
        tokenExpiresAtMs: createdAtMs + this.#profile.interactionTokenTtlMs,
        status: 'pending',
        followups: [],
        timeoutReported: false,
        retainedBytes: 0,
        messageProfile: input.messageProfile as 'chat-input-messages-v1' | 'interactions-v1',
      };
      const retainedBytes = this.#authorityRetainedBytes(interaction);
      this.#assertInteractionRetainedSize(retainedBytes);
      const evictions = this.#planCapacity(retainedBytes, true);
      for (const removed of evictions)
        this.#removeInteraction(removed, this.#interactions.get(removed)!);
      interaction.retainedBytes = retainedBytes;
      this.#interactions.set(id, interaction);
      this.#tokenIndex.set(token, id);
      this.#retainedBytes += retainedBytes;
      return this.#snapshot(interaction);
    });
  }

  // PATCH contract: omitted fields stay, explicit null clears (removes) a field, any other value
  // (including an empty array) replaces that top-level field. A content edit without
  // allowed_mentions drops the stored allowed_mentions (default allowances for this edit). An
  // EPHEMERAL bit flip is ignored so flags stay consistent with the fixed ephemeral identity. The
  // patch and the merged result are both bounded by the payload limit. Nothing is mutated here.
  #mergePatch(
    current: Readonly<Record<string, unknown>>,
    patch: Readonly<Record<string, unknown>>,
    ephemeral: boolean,
    label: string,
  ): Readonly<Record<string, unknown>> {
    const clonedPatch = cloneBoundedPayload(patch, this.#maxPayloadBytes, label);
    const patchesFlags = Object.hasOwn(clonedPatch, 'flags');
    const patchFlags = clonedPatch['flags'];
    const merged: Record<string, unknown> = {};
    const assign = (name: string, value: unknown): void => {
      Object.defineProperty(merged, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    };
    for (const name of Object.keys(current)) assign(name, current[name]);
    for (const name of Object.keys(clonedPatch)) {
      const value = clonedPatch[name];
      if (value === null) delete merged[name];
      else assign(name, value);
    }
    if (Object.hasOwn(clonedPatch, 'content') && !Object.hasOwn(clonedPatch, 'allowed_mentions')) {
      delete merged['allowed_mentions'];
    }
    // Only null and non-negative safe integer flags are normalized; other flag values are stored as
    // sent (flag value validation is out of scope).
    if (patchesFlags && patchFlags === null && ephemeral) assign('flags', EPHEMERAL_FLAG);
    if (
      patchesFlags &&
      typeof patchFlags === 'number' &&
      Number.isSafeInteger(patchFlags) &&
      patchFlags >= 0
    ) {
      const hasEphemeralBit = Math.floor(patchFlags / EPHEMERAL_FLAG) % 2 === 1;
      const withoutEphemeral = hasEphemeralBit ? patchFlags - EPHEMERAL_FLAG : patchFlags;
      assign('flags', ephemeral ? withoutEphemeral + EPHEMERAL_FLAG : withoutEphemeral);
    }
    return cloneBoundedPayload(merged, this.#maxPayloadBytes, label);
  }

  #ensureInteractionCapacity(): void {
    if (this.#interactions.size < this.#maxInteractions) return;
    for (const [id, interaction] of this.#interactions) {
      this.#refresh(interaction);
      if (this.#effectiveStatus(interaction) !== 'expired') continue;
      this.#removeInteraction(id, interaction);
      if (this.#interactions.size < this.#maxInteractions) return;
    }
    throw new InteractionCapacityError(
      `The simulator cannot retain more than ${this.#maxInteractions} interactions.`,
    );
  }

  #requireMutable(id: string): MutableInteraction {
    const interaction = this.#interactions.get(id);
    if (interaction === undefined) throw new DiscordApiError(404, 10062, 'Unknown interaction.');
    this.#refresh(interaction);
    return interaction;
  }

  #requireUsableToken(id: string): MutableInteraction {
    const interaction = this.#requireMutable(id);
    if (this.#clock.now() >= interaction.tokenExpiresAtMs || interaction.status === 'expired') {
      const previousStatus = interaction.status;
      interaction.status = 'expired';
      if (previousStatus !== interaction.status) this.#synchronizeRetainedSize(interaction);
      this.#emitRisk(
        interaction,
        'EXPIRED_INTERACTION_TOKEN',
        'high',
        'An expired interaction token was used.',
      );
      throw new DiscordApiError(404, 10015, 'Unknown webhook.');
    }
    return interaction;
  }

  #refresh(interaction: MutableInteraction, explicit = false): void {
    if (this.#commandActive() || (!explicit && interaction.messageProfile !== undefined)) return;
    const previousStatus = interaction.status;
    if (interaction.status === 'pending' && this.#clock.now() >= interaction.initialDeadlineAtMs) {
      this.#markTimedOut(interaction);
    } else if (
      this.#clock.now() >= interaction.tokenExpiresAtMs &&
      interaction.status !== 'pending'
    ) {
      interaction.status = 'expired';
    }
    if (previousStatus !== interaction.status) this.#synchronizeRetainedSize(interaction);
  }

  #markTimedOut(interaction: MutableInteraction): void {
    interaction.status = 'expired';
    if (!interaction.timeoutReported) {
      interaction.timeoutReported = true;
      this.#emitRisk(
        interaction,
        'INTERACTION_TIMEOUT',
        'critical',
        'No initial response was sent before 3,000 ms.',
      );
    }
  }

  #prepareResize(interaction: MutableInteraction, candidate: MutableInteraction): number {
    const retainedBytes = retainedInteractionBytes(candidate);
    this.#assertInteractionRetainedSize(retainedBytes);
    const additionalBytes = retainedBytes - interaction.retainedBytes;
    if (additionalBytes > 0) {
      if (this.#messageAuthority === undefined)
        this.#ensureRetainedCapacity(additionalBytes, interaction.id);
      else
        for (const removed of this.#planCapacity(additionalBytes, false, interaction.id)) {
          this.#removeInteraction(removed, this.#interactions.get(removed)!);
        }
    }
    return retainedBytes;
  }

  #commitResize(interaction: MutableInteraction, retainedBytes: number): void {
    this.#retainedBytes += retainedBytes - interaction.retainedBytes;
    interaction.retainedBytes = retainedBytes;
  }

  #synchronizeRetainedSize(interaction: MutableInteraction): void {
    const retainedBytes =
      interaction.messageProfile === undefined
        ? retainedInteractionBytes(interaction)
        : this.#authorityRetainedBytes(interaction);
    this.#retainedBytes += retainedBytes - interaction.retainedBytes;
    interaction.retainedBytes = retainedBytes;
  }

  #assertInteractionRetainedSize(retainedBytes: number): void {
    if (retainedBytes > this.#maxRetainedBytesPerInteraction) {
      throw new InteractionCapacityError(
        `An interaction cannot retain more than ${this.#maxRetainedBytesPerInteraction} bytes.`,
      );
    }
  }

  #ensureRetainedCapacity(additionalBytes: number, protectedId?: string): void {
    if (this.#retainedBytes + additionalBytes <= this.#maxRetainedBytes) return;
    for (const [id, interaction] of this.#interactions) {
      if (id === protectedId) continue;
      this.#refresh(interaction);
      if (this.#effectiveStatus(interaction) !== 'expired') continue;
      this.#removeInteraction(id, interaction);
      if (this.#retainedBytes + additionalBytes <= this.#maxRetainedBytes) return;
    }
    throw new InteractionCapacityError(
      `The simulator cannot retain more than ${this.#maxRetainedBytes} interaction bytes.`,
    );
  }

  #removeInteraction(id: string, interaction: MutableInteraction): void {
    this.#interactions.delete(id);
    this.#tokenIndex.delete(interaction.token);
    this.#retainedBytes -= interaction.retainedBytes;
  }

  #emitRisk(
    interaction: MutableInteraction,
    ruleId: string,
    severity: RiskFinding['severity'],
    evidence: string,
  ): void {
    this.#onRisk?.({
      ruleId,
      severity,
      confidence: 1,
      title: ruleId.replaceAll('_', ' '),
      evidence,
      impact: 'The interaction will fail or produce behavior different from Discord.',
      recommendation:
        'Acknowledge once before the deadline and use the token only during its valid lifetime.',
      eventId: interaction.id,
      firstSeenAtMs: this.#clock.now(),
      lastSeenAtMs: this.#clock.now(),
    });
  }
}

const MODELED_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  'command',
  'component',
  'autocomplete',
  'modal-submit',
]);

const EPHEMERAL_FLAG = 64;

export class InteractionCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InteractionCapacityError';
  }
}

export class DiscordApiError extends Error {
  public readonly status: number;
  public readonly code: number;
  public constructor(status: number, code: number, message: string) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.code = code;
  }

  public toJSON(): { readonly code: number; readonly message: string } {
    return { code: this.code, message: this.message };
  }
}

function validateResponseType(
  interactionType: string,
  responseType: InteractionResponseType,
): void {
  if (!MODELED_INTERACTION_KINDS.has(interactionType)) {
    // Simulator input validation: only the modeled kind labels can be answered (not a Discord rule).
    throw new DiscordApiError(400, 50035, 'Unknown or unmodeled interaction kind label.');
  }
  if (interactionType === 'autocomplete' && responseType !== 'autocomplete') {
    throw new DiscordApiError(
      400,
      50035,
      'Autocomplete interactions require an autocomplete result response.',
    );
  }
  if (interactionType !== 'autocomplete' && responseType === 'autocomplete') {
    throw new DiscordApiError(
      400,
      50035,
      'Autocomplete response is invalid for this interaction type.',
    );
  }
  if (
    interactionType === 'command' &&
    (responseType === 'update' || responseType === 'defer-update')
  ) {
    throw new DiscordApiError(
      400,
      50035,
      'Application command interactions cannot update or defer-update a message.',
    );
  }
  if (interactionType === 'modal-submit' && responseType === 'modal') {
    throw new DiscordApiError(
      400,
      50035,
      'A modal cannot be opened in response to a modal submission.',
    );
  }
}

function isEphemeral(data: Readonly<Record<string, unknown>>): boolean {
  const flags = data['flags'];
  if (typeof flags === 'bigint') return (flags & 64n) !== 0n;
  return typeof flags === 'number' && (flags & 64) !== 0;
}

function cloneBoundedPayload(
  value: Readonly<Record<string, unknown>>,
  maxBytes: number,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain JSON object.`);
  const seen = new WeakSet<object>();
  let nodes = 0;
  let estimatedBytes = 0;
  const charge = (bytes: number): void => {
    estimatedBytes += bytes;
    if (estimatedBytes > maxBytes) {
      throw new InteractionCapacityError(`${label} exceeds the configured ${maxBytes} byte limit.`);
    }
  };
  const cloneValue = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) {
      throw new InteractionCapacityError(`${label} exceeds the nesting or node limit.`);
    }
    if (candidate === null) {
      charge(4);
      return candidate;
    }
    if (typeof candidate === 'string') {
      charge(Buffer.byteLength(candidate));
      return candidate;
    }
    if (typeof candidate === 'boolean') {
      charge(candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError(`${label} numbers must be finite.`);
      charge(Buffer.byteLength(String(candidate)));
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError(`${label} must contain only JSON values.`);
    }
    if (seen.has(candidate)) {
      throw new TypeError(`${label} must not contain cycles or shared references.`);
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      assertDenseDataArray(candidate, label, 10_000);
      const cloned: unknown[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        cloned.push(cloneValue(candidate[index], depth + 1));
      }
      return cloned;
    }
    if (!isPlainObject(candidate) || Object.getOwnPropertySymbols(candidate).length > 0) {
      throw new TypeError(`${label} must contain only plain JSON objects and arrays.`);
    }
    const names = Object.getOwnPropertyNames(candidate);
    if (names.length > 10_000) {
      throw new InteractionCapacityError(`${label} exceeds the nesting or node limit.`);
    }
    const cloned: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label} must contain only enumerable data properties.`);
      }
      charge(Buffer.byteLength(name));
      Object.defineProperty(cloned, name, {
        value: cloneValue(descriptor.value as unknown, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  };
  const cloned = cloneValue(value, 0) as Readonly<Record<string, unknown>>;
  const serialized = JSON.stringify(cloned);
  if (serialized === undefined) throw new TypeError(`${label} is not JSON serializable.`);
  const size = Buffer.byteLength(serialized);
  if (size > maxBytes) {
    throw new InteractionCapacityError(`${label} exceeds the configured ${maxBytes} byte limit.`);
  }
  return cloned;
}

function assertDenseDataArray(value: readonly unknown[], label: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new InteractionCapacityError(`${label} exceeds the nesting or node limit.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} arrays must not contain symbol properties.`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[value.length] !== 'length') {
    throw new TypeError(`${label} arrays must be dense and must not contain custom properties.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (names[index] !== String(index)) {
      throw new TypeError(`${label} arrays must be dense and must not contain custom properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${label} arrays must contain only data properties.`);
    }
  }
}

// Same rule and bound as the bootstrap profile ID validation (bootstrap-profile.ts).
const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n;
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,19}$/;

function requireCanonicalId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !SNOWFLAKE_PATTERN.test(value) ||
    BigInt(value) > MAX_SNOWFLAKE
  ) {
    throw new TypeError(`${path} must be a canonical positive decimal unsigned 64-bit ID string.`);
  }
  return value;
}

function copyContext(value: unknown): InteractionContext {
  if (!isPlainObject(value)) throw new TypeError('Interaction context must be a plain object.');
  const field = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) return undefined;
    if (!('value' in descriptor)) {
      throw new TypeError(`context.${name} must be a data property.`);
    }
    return descriptor.value as unknown;
  };
  const actorId = requireCanonicalId(field('actorId'), 'context.actorId');
  const channelId = requireCanonicalId(field('channelId'), 'context.channelId');
  const rawGuildId = field('guildId');
  const guildId =
    rawGuildId === undefined ? undefined : requireCanonicalId(rawGuildId, 'context.guildId');
  return guildId === undefined ? { actorId, channelId } : { actorId, channelId, guildId };
}

function boundedText(value: string, label: string, maxBytes: number): string {
  if (value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${label} must contain 1 to ${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function boundedCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new RangeError(`${name} must be a safe integer from 1 through 1,000,000.`);
  }
  return value;
}

function boundedPayloadBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 128 || value > 16_777_216) {
    throw new RangeError('maxPayloadBytes must be a safe integer from 128 bytes through 16 MiB.');
  }
  return value;
}

function boundedRetainedBytes(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new RangeError(`${name} must be a safe integer from 1 byte through 1 GiB.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function cloneInteraction(interaction: MutableInteraction): SimulatedInteraction {
  return structuredClone(serializableInteraction(interaction));
}

function retainedInteractionBytes(interaction: MutableInteraction): number {
  return Buffer.byteLength(JSON.stringify(serializableInteraction(interaction)));
}

function serializableInteraction(interaction: MutableInteraction): SimulatedInteraction {
  return {
    ...(interaction.messageProfile === undefined
      ? {}
      : { messageProfile: interaction.messageProfile }),
    ...(interaction.originalMessageId === undefined
      ? {}
      : { originalMessageId: interaction.originalMessageId }),
    id: interaction.id,
    token: interaction.token,
    ...(interaction.applicationId === undefined
      ? {}
      : { applicationId: interaction.applicationId }),
    ...(interaction.context === undefined ? {} : { context: interaction.context }),
    type: interaction.type,
    data: interaction.data,
    createdAtMs: interaction.createdAtMs,
    initialDeadlineAtMs: interaction.initialDeadlineAtMs,
    tokenExpiresAtMs: interaction.tokenExpiresAtMs,
    status: interaction.status,
    ...(interaction.acknowledgedAtMs === undefined
      ? {}
      : { acknowledgedAtMs: interaction.acknowledgedAtMs }),
    ...(interaction.initialResponse === undefined
      ? {}
      : { initialResponse: interaction.initialResponse }),
    followups: interaction.followups,
  };
}

function unsupportedMessageProfile(): DiscordApiError {
  return new DiscordApiError(
    501,
    0,
    'Authoritative interaction messages are unavailable for this profile.',
  );
}
function unknownInteractionMessage(): DiscordApiError {
  return new DiscordApiError(404, 10008, 'Unknown message.');
}
function invalidInteractionPayload(): DiscordApiError {
  return new DiscordApiError(400, 50035, 'Invalid interaction message payload.');
}

function cloneAuthorityPayload(
  value: unknown,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const data = cloneInteractionPayload(value, maxBytes);
  if (!isPlainObject(data)) throw invalidInteractionPayload();
  return data;
}

function authoritativeProfile(profile: InteractionMessageProfile | undefined): boolean {
  return profile === 'chat-input-messages-v1' || profile === 'interactions-v1';
}
