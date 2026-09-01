import type { RiskFinding, SimulationProfile } from './contracts.js';
import type { VirtualClock } from './clock.js';
import type { SeededRandom, SnowflakeGenerator } from './random.js';
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

export interface SimulatedInteraction {
  readonly id: string;
  readonly token: string;
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
  id: string;
  token: string;
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
  }

  public create(
    input: {
      readonly id?: string;
      readonly token?: string;
      readonly type?: string;
      readonly data?: Readonly<Record<string, unknown>>;
    } = {},
  ): SimulatedInteraction {
    const data = cloneBoundedPayload(input.data ?? {}, this.#maxPayloadBytes, 'Interaction data');
    const type = boundedText(input.type ?? 'command', 'Interaction type', 64);
    const suppliedToken = input.token === undefined ? undefined : assertSyntheticToken(input.token);
    if (suppliedToken !== undefined && this.#tokenIndex.has(suppliedToken)) {
      throw new DiscordApiError(409, 40041, 'Interaction token already exists.');
    }
    this.#ensureInteractionCapacity();
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
    this.#ensureRetainedCapacity(retainedBytes);
    interaction.retainedBytes = retainedBytes;
    this.#interactions.set(id, interaction);
    this.#tokenIndex.set(token, id);
    this.#retainedBytes += retainedBytes;
    return cloneInteraction(interaction);
  }

  public get(id: string): SimulatedInteraction | undefined {
    const interaction = this.#interactions.get(id);
    if (interaction === undefined) return undefined;
    this.#refresh(interaction);
    return cloneInteraction(interaction);
  }

  public require(id: string): SimulatedInteraction {
    const interaction = this.#requireMutable(id);
    return cloneInteraction(interaction);
  }

  public list(): readonly SimulatedInteraction[] {
    this.sweepExpired();
    return [...this.#interactions.values()].map(cloneInteraction);
  }

  public getByToken(token: string): SimulatedInteraction | undefined {
    const id = this.#tokenIndex.get(token);
    const interaction = id === undefined ? undefined : this.#interactions.get(id);
    if (interaction === undefined) return undefined;
    this.#refresh(interaction);
    return cloneInteraction(interaction);
  }

  public retainedByteCount(): number {
    return this.#retainedBytes;
  }

  public respond(
    id: string,
    responseType: InteractionResponseType,
    data: Readonly<Record<string, unknown>> = {},
  ): SimulatedInteraction {
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
    return cloneInteraction(interaction);
  }

  public followup(id: string, data: Readonly<Record<string, unknown>> = {}): InteractionFollowup {
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
    const interaction = this.#requireUsableToken(id);
    if (interaction.status === 'pending') {
      throw new DiscordApiError(404, 10015, 'Unknown webhook.');
    }
    const clonedData = cloneBoundedPayload(data, this.#maxPayloadBytes, 'Interaction response');
    const response: InteractionResponse = {
      type: 'message',
      data: clonedData,
      atMs: this.#clock.now(),
      ephemeral: interaction.initialResponse?.ephemeral ?? isEphemeral(clonedData),
    };
    const retainedBytes = this.#prepareResize(interaction, {
      ...interaction,
      initialResponse: response,
      status: 'responded',
    });
    interaction.initialResponse = response;
    interaction.status = 'responded';
    this.#commitResize(interaction, retainedBytes);
    return cloneInteraction(interaction);
  }

  public deleteOriginal(id: string): SimulatedInteraction {
    const interaction = this.#requireUsableToken(id);
    if (interaction.status === 'pending') throw new DiscordApiError(404, 10015, 'Unknown webhook.');
    const retainedBytes = this.#prepareResize(interaction, { ...interaction, status: 'deleted' });
    interaction.status = 'deleted';
    this.#commitResize(interaction, retainedBytes);
    return cloneInteraction(interaction);
  }

  public editFollowup(
    interactionId: string,
    followupId: string,
    data: Readonly<Record<string, unknown>>,
  ): InteractionFollowup {
    const interaction = this.#requireUsableToken(interactionId);
    const index = interaction.followups.findIndex(
      (followup) => followup.id === followupId && !followup.deleted,
    );
    if (index < 0) throw new DiscordApiError(404, 10008, 'Unknown message.');
    const current = interaction.followups[index] as InteractionFollowup;
    const updated: InteractionFollowup = {
      ...current,
      data: cloneBoundedPayload(data, this.#maxPayloadBytes, 'Interaction follow-up'),
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
    const expired: SimulatedInteraction[] = [];
    for (const interaction of this.#interactions.values()) {
      const previous = interaction.status;
      this.#refresh(interaction);
      if (previous !== 'expired' && interaction.status === 'expired')
        expired.push(cloneInteraction(interaction));
    }
    return expired;
  }

  #ensureInteractionCapacity(): void {
    if (this.#interactions.size < this.#maxInteractions) return;
    for (const [id, interaction] of this.#interactions) {
      this.#refresh(interaction);
      if (interaction.status !== 'expired') continue;
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

  #refresh(interaction: MutableInteraction): void {
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
    if (additionalBytes > 0) this.#ensureRetainedCapacity(additionalBytes, interaction.id);
    return retainedBytes;
  }

  #commitResize(interaction: MutableInteraction, retainedBytes: number): void {
    this.#retainedBytes += retainedBytes - interaction.retainedBytes;
    interaction.retainedBytes = retainedBytes;
  }

  #synchronizeRetainedSize(interaction: MutableInteraction): void {
    const retainedBytes = retainedInteractionBytes(interaction);
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
      if (interaction.status !== 'expired') continue;
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
    id: interaction.id,
    token: interaction.token,
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
