import type { GatewayDispatch } from './contracts.js';
import type { VirtualClock } from './clock.js';
import { filterGatewayEvent, validateIdentifyIntents } from './intents.js';
import type { SeededRandom, SnowflakeGenerator } from './random.js';
import { assertOfflineGatewayUrl } from './network-policy.js';
import {
  assertSyntheticToken,
  createOfflineSessionToken,
  timingSafeTokenEqual,
} from './session-token.js';

export const GatewayOpcodes = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export interface GatewayPacket<T = unknown> {
  readonly op: number;
  readonly d: T;
  readonly s?: number | null;
  readonly t?: string | null;
}

export interface IdentifyPayload {
  readonly token: string;
  readonly intents: bigint | string | number;
  readonly properties?: Readonly<Record<string, string>>;
  readonly shard?: readonly [number, number];
}

export interface GatewayIdentifyResult {
  readonly sessionId: string;
  readonly ready: GatewayDispatch;
  readonly resumeGatewayUrl: string;
}

export interface GatewayResumeResult {
  readonly accepted: boolean;
  readonly replayed: readonly GatewayDispatch[];
  readonly resumed?: GatewayDispatch;
  readonly invalidSession?: GatewayPacket<boolean>;
}

export interface GatewaySessionView {
  readonly id: string;
  readonly state: 'ready' | 'disconnected' | 'invalid';
  readonly sequence: number;
  readonly intents: bigint;
  readonly connectedAtMs: number;
  readonly disconnectedAtMs?: number;
  readonly lastHeartbeatAtMs?: number;
  readonly lastHeartbeatSequence?: number | null;
}

interface MutableSession {
  id: string;
  token: string;
  state: 'ready' | 'disconnected' | 'invalid';
  sequence: number;
  intents: bigint;
  connectedAtMs: number;
  disconnectedAtMs?: number;
  lastHeartbeatAtMs?: number;
  lastHeartbeatSequence?: number | null;
  awaitingHeartbeatAck: boolean;
  history: StoredDispatch[];
  historyBytes: number;
}

interface StoredDispatch {
  readonly packet: GatewayDispatch;
  readonly bytes: number;
}

const MAX_DISPATCH_JSON_DEPTH = 32;
const MAX_DISPATCH_JSON_NODES = 100_000;
const MAX_DISPATCH_EVENT_NAME_BYTES = 256;
const DISPATCH_PACKET_PREFIX_BYTES = Buffer.byteLength('{"op":0,"t":');

export interface GatewayEmulatorOptions {
  readonly clock: VirtualClock;
  readonly random: SeededRandom;
  readonly snowflakes: SnowflakeGenerator;
  readonly fakeToken?: string;
  readonly botUserId?: string;
  readonly applicationId?: string;
  readonly portalEnabledPrivilegedIntents?: bigint | string;
  readonly heartbeatIntervalMs?: number;
  readonly sessionTtlMs?: number;
  readonly replayLimit?: number;
  readonly resumeGatewayUrl?: string;
  readonly maxIdentifiesPerWindow?: number;
  readonly identifyWindowMs?: number;
  readonly maxSessions?: number;
  /** Maximum UTF-8 JSON size of one retained dispatch packet. */
  readonly maxDispatchBytes?: number;
  /** Maximum retained replay-history bytes for one session. */
  readonly maxReplayBytesPerSession?: number;
  /** Maximum retained replay-history bytes across all sessions. */
  readonly maxTotalReplayBytes?: number;
}

export class GatewayEmulator {
  readonly #clock: VirtualClock;
  readonly #random: SeededRandom;
  readonly #snowflakes: SnowflakeGenerator;
  readonly #fakeToken: string;
  readonly #botUserId: string;
  readonly #applicationId: string;
  readonly #portalEnabledPrivilegedIntents: bigint | string;
  readonly #heartbeatIntervalMs: number;
  readonly #sessionTtlMs: number;
  readonly #replayLimit: number;
  readonly #resumeGatewayUrl: string;
  readonly #maxIdentifiesPerWindow: number;
  readonly #identifyWindowMs: number;
  readonly #maxSessions: number;
  readonly #maxDispatchBytes: number;
  readonly #maxReplayBytesPerSession: number;
  readonly #maxTotalReplayBytes: number;
  readonly #sessions = new Map<string, MutableSession>();
  #totalReplayBytes = 0;
  #identifyWindowStartedAtMs: number;
  #identifyCount = 0;
  #heartbeatAckEnabled = true;

  public constructor(options: GatewayEmulatorOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#snowflakes = options.snowflakes;
    this.#fakeToken = assertSyntheticToken(options.fakeToken ?? createOfflineSessionToken());
    this.#botUserId = options.botUserId ?? this.#snowflakes.generate();
    this.#applicationId = options.applicationId ?? this.#botUserId;
    this.#portalEnabledPrivilegedIntents = options.portalEnabledPrivilegedIntents ?? 0n;
    this.#heartbeatIntervalMs = boundedPositiveInteger(
      options.heartbeatIntervalMs ?? 41_250,
      'heartbeatIntervalMs',
    );
    this.#sessionTtlMs = boundedPositiveInteger(options.sessionTtlMs ?? 300_000, 'sessionTtlMs');
    this.#replayLimit = boundedPositiveInteger(options.replayLimit ?? 1_000, 'replayLimit');
    this.#resumeGatewayUrl = assertOfflineGatewayUrl(
      options.resumeGatewayUrl ?? 'ws://127.0.0.1/gateway',
    ).href;
    this.#maxIdentifiesPerWindow = boundedPositiveInteger(
      options.maxIdentifiesPerWindow ?? 1_000,
      'maxIdentifiesPerWindow',
    );
    this.#identifyWindowMs = boundedPositiveInteger(
      options.identifyWindowMs ?? 86_400_000,
      'identifyWindowMs',
    );
    this.#maxSessions = boundedPositiveInteger(options.maxSessions ?? 1_000, 'maxSessions');
    this.#maxDispatchBytes = boundedPositiveInteger(
      options.maxDispatchBytes ?? 1_048_576,
      'maxDispatchBytes',
    );
    this.#maxReplayBytesPerSession = boundedPositiveInteger(
      options.maxReplayBytesPerSession ?? 16 * 1_048_576,
      'maxReplayBytesPerSession',
    );
    this.#maxTotalReplayBytes = boundedPositiveInteger(
      options.maxTotalReplayBytes ?? 64 * 1_048_576,
      'maxTotalReplayBytes',
    );
    if (this.#maxDispatchBytes > this.#maxReplayBytesPerSession) {
      throw new RangeError('maxDispatchBytes cannot exceed maxReplayBytesPerSession.');
    }
    if (this.#maxDispatchBytes > this.#maxTotalReplayBytes) {
      throw new RangeError('maxDispatchBytes cannot exceed maxTotalReplayBytes.');
    }
    this.#identifyWindowStartedAtMs = this.#clock.now();
  }

  /** The per-instance synthetic credential to inject into a contained bot process. */
  public get sessionToken(): string {
    return this.#fakeToken;
  }

  public hello(): GatewayPacket<{ readonly heartbeat_interval: number }> {
    return { op: GatewayOpcodes.HELLO, d: { heartbeat_interval: this.#heartbeatIntervalMs } };
  }

  public identify(payload: IdentifyPayload): GatewayIdentifyResult {
    if (!tokenMatches(payload.token, this.#fakeToken)) {
      throw new GatewayProtocolError(4004, 'Authentication failed.');
    }
    const intents = validateIdentifyIntents(payload.intents, this.#portalEnabledPrivilegedIntents);
    validateShard(payload.shard);
    this.#sweepSessions();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new GatewayProtocolError(4008, 'Gateway session capacity exceeded.');
    }
    this.#consumeIdentify();
    const sessionId = `session_${this.#random.token(18)}`;
    const session: MutableSession = {
      id: sessionId,
      token: payload.token,
      state: 'ready',
      sequence: 0,
      intents,
      connectedAtMs: this.#clock.now(),
      awaitingHeartbeatAck: false,
      history: [],
      historyBytes: 0,
    };
    const ready = this.#appendDispatch(session, 'READY', {
      v: 10,
      user: { id: this.#botUserId, username: 'DisRunner Bot', bot: true },
      application: { id: this.#applicationId },
      guilds: [],
      session_id: sessionId,
      resume_gateway_url: this.#resumeGatewayUrl,
      shard: payload.shard ?? [0, 1],
    });
    this.#sessions.set(sessionId, session);
    return { sessionId, ready, resumeGatewayUrl: this.#resumeGatewayUrl };
  }

  public dispatch(
    sessionId: string,
    eventName: string,
    data: unknown,
  ): GatewayDispatch | undefined {
    const session = this.#requireReadySession(sessionId);
    const sequence = session.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new GatewayProtocolError(4002, 'Gateway sequence exceeds the safe integer range.');
    }
    const boundedData = normalizeDispatchData(
      eventName,
      sequence,
      data,
      this.#maxDispatchBytes,
    ).data;
    const filtered = filterGatewayEvent(eventName, boundedData, session.intents, {
      botUserId: this.#botUserId,
    });
    if (!filtered.delivered) return undefined;
    return this.#appendDispatch(session, eventName, filtered.data);
  }

  public heartbeat(sessionId: string, sequence: number | null): GatewayPacket<null> | undefined {
    const session = this.#requireReadySession(sessionId);
    if (sequence !== null && sequence !== session.sequence) {
      throw new GatewayProtocolError(4007, 'Invalid sequence.');
    }
    if (session.awaitingHeartbeatAck) {
      session.state = 'disconnected';
      session.disconnectedAtMs = this.#clock.now();
      throw new GatewayProtocolError(4009, 'Session timed out after a missed heartbeat ACK.');
    }
    session.lastHeartbeatAtMs = this.#clock.now();
    session.lastHeartbeatSequence = sequence;
    session.awaitingHeartbeatAck = true;
    if (!this.#heartbeatAckEnabled) return undefined;
    session.awaitingHeartbeatAck = false;
    return { op: GatewayOpcodes.HEARTBEAT_ACK, d: null };
  }

  public setHeartbeatAckEnabled(enabled: boolean): void {
    this.#heartbeatAckEnabled = enabled;
  }

  public checkLiveness(sessionId: string): boolean {
    const session = this.#requireSession(sessionId);
    if (session.state !== 'ready') return false;
    if (
      session.awaitingHeartbeatAck &&
      session.lastHeartbeatAtMs !== undefined &&
      this.#clock.now() - session.lastHeartbeatAtMs >= this.#heartbeatIntervalMs
    ) {
      session.state = 'disconnected';
      session.disconnectedAtMs = this.#clock.now();
      return false;
    }
    return true;
  }

  public disconnect(sessionId: string): void {
    const session = this.#requireSession(sessionId);
    if (session.state !== 'ready') return;
    session.state = 'disconnected';
    session.disconnectedAtMs = this.#clock.now();
  }

  public reconnectRequest(): GatewayPacket<null> {
    return { op: GatewayOpcodes.RECONNECT, d: null };
  }

  public invalidate(sessionId: string, resumable: boolean): GatewayPacket<boolean> {
    const session = this.#requireSession(sessionId);
    session.state = resumable ? 'disconnected' : 'invalid';
    session.disconnectedAtMs = this.#clock.now();
    return { op: GatewayOpcodes.INVALID_SESSION, d: resumable };
  }

  public resume(sessionId: string, token: string, lastSequence: number): GatewayResumeResult {
    this.#sweepSessions();
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined ||
      session.state !== 'disconnected' ||
      !tokenMatches(token, session.token) ||
      !Number.isSafeInteger(lastSequence) ||
      lastSequence < 0 ||
      lastSequence > (session?.sequence ?? -1) ||
      this.#sessionExpired(session)
    ) {
      if (session !== undefined && this.#sessionExpired(session)) {
        this.#deleteSession(session);
      }
      return {
        accepted: false,
        replayed: [],
        invalidSession: { op: GatewayOpcodes.INVALID_SESSION, d: false },
      };
    }

    const oldestAvailable = session.history[0]?.packet.s ?? session.sequence;
    if (lastSequence < oldestAvailable - 1) {
      session.state = 'invalid';
      return {
        accepted: false,
        replayed: [],
        invalidSession: { op: GatewayOpcodes.INVALID_SESSION, d: false },
      };
    }
    const replayed = session.history
      .map((entry) => entry.packet)
      .filter((packet) => packet.s > lastSequence)
      .map(cloneDispatch);
    const resumed = this.#appendDispatch(session, 'RESUMED', { _trace: [] });
    session.state = 'ready';
    session.connectedAtMs = this.#clock.now();
    delete session.disconnectedAtMs;
    session.awaitingHeartbeatAck = false;
    return { accepted: true, replayed, resumed };
  }

  public session(sessionId: string): GatewaySessionView | undefined {
    this.#sweepSessions();
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : toSessionView(session);
  }

  public sessions(): readonly GatewaySessionView[] {
    this.#sweepSessions();
    return [...this.#sessions.values()].map(toSessionView);
  }

  public replay(sessionId: string, afterSequence: number): readonly GatewayDispatch[] {
    const session = this.#requireSession(sessionId);
    return session.history
      .map((entry) => entry.packet)
      .filter((packet) => packet.s > afterSequence)
      .map(cloneDispatch);
  }

  #appendDispatch(session: MutableSession, eventName: string, data: unknown): GatewayDispatch {
    const sequence = session.sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new GatewayProtocolError(4002, 'Gateway sequence exceeds the safe integer range.');
    }
    const { packet, bytes } = createStoredDispatch(
      eventName,
      sequence,
      data,
      this.#maxDispatchBytes,
    );

    let evictCount = 0;
    let retainedBytes = session.historyBytes + bytes;
    while (
      session.history.length - evictCount + 1 > this.#replayLimit ||
      retainedBytes > this.#maxReplayBytesPerSession
    ) {
      const evicted = session.history[evictCount];
      if (evicted === undefined) break;
      retainedBytes -= evicted.bytes;
      evictCount += 1;
    }
    const evictedBytes = session.historyBytes + bytes - retainedBytes;
    if (this.#totalReplayBytes - evictedBytes + bytes > this.#maxTotalReplayBytes) {
      throw new GatewayProtocolError(4008, 'Gateway replay history capacity exceeded.');
    }

    if (evictCount > 0) session.history.splice(0, evictCount);
    session.sequence = sequence;
    session.history.push({ packet, bytes });
    session.historyBytes = retainedBytes;
    this.#totalReplayBytes += bytes - evictedBytes;
    return cloneDispatch(packet);
  }

  #requireSession(sessionId: string): MutableSession {
    this.#sweepSessions();
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new GatewayProtocolError(4009, 'Session timed out.');
    return session;
  }

  #requireReadySession(sessionId: string): MutableSession {
    const session = this.#requireSession(sessionId);
    if (session.state !== 'ready')
      throw new GatewayProtocolError(4009, 'Session is not connected.');
    return session;
  }

  #sessionExpired(session: MutableSession): boolean {
    return (
      session.disconnectedAtMs !== undefined &&
      this.#clock.now() - session.disconnectedAtMs >= this.#sessionTtlMs
    );
  }

  #consumeIdentify(): void {
    const nowMs = this.#clock.now();
    if (nowMs - this.#identifyWindowStartedAtMs >= this.#identifyWindowMs) {
      this.#identifyWindowStartedAtMs = nowMs;
      this.#identifyCount = 0;
    }
    if (this.#identifyCount >= this.#maxIdentifiesPerWindow) {
      throw new GatewayProtocolError(4008, 'Identify session start limit exceeded.');
    }
    this.#identifyCount += 1;
  }

  #sweepSessions(): void {
    for (const session of this.#sessions.values()) {
      if (session.state === 'invalid' || this.#sessionExpired(session)) {
        this.#deleteSession(session);
      }
    }
  }

  #deleteSession(session: MutableSession): void {
    if (!this.#sessions.delete(session.id)) return;
    this.#totalReplayBytes -= session.historyBytes;
  }
}

export class GatewayProtocolError extends Error {
  public readonly closeCode: number;
  public constructor(closeCode: number, message: string) {
    super(message);
    this.name = 'GatewayProtocolError';
    this.closeCode = closeCode;
  }
}

function validateShard(shard: readonly [number, number] | undefined): void {
  if (shard === undefined) return;
  const [id, count] = shard;
  if (
    !Number.isSafeInteger(id) ||
    !Number.isSafeInteger(count) ||
    id < 0 ||
    count < 1 ||
    id >= count
  ) {
    throw new GatewayProtocolError(4010, 'Invalid shard.');
  }
}

function tokenMatches(received: string, expected: string): boolean {
  return timingSafeTokenEqual(received, expected);
}

function cloneDispatch(packet: GatewayDispatch): GatewayDispatch {
  return structuredClone(packet);
}

function createStoredDispatch(
  eventName: string,
  sequence: number,
  data: unknown,
  maxBytes: number,
): StoredDispatch {
  const normalized = normalizeDispatchData(eventName, sequence, data, maxBytes);
  const packet = {
    op: GatewayOpcodes.DISPATCH,
    t: eventName,
    s: sequence,
    d: normalized.data,
  } satisfies GatewayDispatch;
  return { packet, bytes: normalized.bytes };
}

function dispatchEventNameByteLength(eventName: string): number {
  if (typeof eventName !== 'string' || eventName.length === 0) {
    throw new GatewayProtocolError(4002, 'Gateway dispatch event name must not be empty.');
  }
  return jsonStringByteLength(
    eventName,
    MAX_DISPATCH_EVENT_NAME_BYTES,
    `Gateway dispatch event name exceeds ${MAX_DISPATCH_EVENT_NAME_BYTES} encoded bytes.`,
  );
}

function normalizeDispatchData(
  eventName: string,
  sequence: number,
  data: unknown,
  maxBytes: number,
): { readonly data: unknown; readonly bytes: number } {
  const eventNameBytes = dispatchEventNameByteLength(eventName);
  const overheadBytes =
    DISPATCH_PACKET_PREFIX_BYTES + eventNameBytes + Buffer.byteLength(`,"s":${sequence},"d":`) + 1;
  if (overheadBytes >= maxBytes) throw dispatchSizeError(maxBytes);
  const normalized = cloneJsonDispatchData(data, maxBytes - overheadBytes, maxBytes);
  return { data: normalized.data, bytes: overheadBytes + normalized.bytes };
}

function cloneJsonDispatchData(
  value: unknown,
  maxBytes: number,
  packetMaxBytes: number,
): { readonly data: unknown; readonly bytes: number } {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let remainingBytes = maxBytes;

  const consume = (bytes: number): void => {
    if (bytes > remainingBytes) throw dispatchSizeError(packetMaxBytes);
    remainingBytes -= bytes;
  };

  const consumeString = (text: string): void => {
    const bytes = jsonStringByteLength(
      text,
      remainingBytes,
      `Gateway dispatch exceeds the configured ${packetMaxBytes} byte limit.`,
    );
    consume(bytes);
  };

  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_DISPATCH_JSON_NODES || depth > MAX_DISPATCH_JSON_DEPTH) {
      throw new GatewayProtocolError(
        4002,
        'Gateway dispatch data exceeds the JSON nesting or node limit.',
      );
    }
    if (current === null) {
      consume(4);
      return current;
    }
    if (typeof current === 'string') {
      consumeString(current);
      return current;
    }
    if (typeof current === 'boolean') {
      consume(current ? 4 : 5);
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new GatewayProtocolError(4002, 'Gateway dispatch numbers must be finite.');
      }
      consume(String(current).length);
      return current;
    }
    if (typeof current !== 'object') {
      throw new GatewayProtocolError(4002, 'Gateway dispatch data must contain only JSON values.');
    }
    if (seen.has(current)) {
      throw new GatewayProtocolError(
        4002,
        'Gateway dispatch data must not contain cycles or shared references.',
      );
    }
    seen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) {
        throw new GatewayProtocolError(4002, 'Gateway dispatch arrays must be plain arrays.');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
      const length: unknown = lengthDescriptor?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_DISPATCH_JSON_NODES
      ) {
        throw new GatewayProtocolError(
          4002,
          'Gateway dispatch array length exceeds the node limit.',
        );
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length !== length + 1) {
        throw new GatewayProtocolError(
          4002,
          'Gateway dispatch arrays must not be sparse or contain custom properties.',
        );
      }
      if (length + nodes > MAX_DISPATCH_JSON_NODES) {
        throw new GatewayProtocolError(4002, 'Gateway dispatch data exceeds the JSON node limit.');
      }
      consume(2 + Math.max(0, length - 1));
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new GatewayProtocolError(
            4002,
            'Gateway dispatch arrays must contain ordinary JSON elements.',
          );
        }
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }

    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GatewayProtocolError(
        4002,
        'Gateway dispatch data must contain only plain JSON objects and arrays.',
      );
    }
    const keys = Reflect.ownKeys(current);
    if (keys.length + nodes > MAX_DISPATCH_JSON_NODES) {
      throw new GatewayProtocolError(4002, 'Gateway dispatch data exceeds the JSON node limit.');
    }
    consume(2 + (keys.length === 0 ? 0 : keys.length * 2 - 1));
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new GatewayProtocolError(4002, 'Gateway dispatch objects must not use symbol keys.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new GatewayProtocolError(
          4002,
          'Gateway dispatch objects must contain ordinary enumerable JSON properties.',
        );
      }
      consumeString(key);
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: visit(descriptor.value, depth + 1),
        writable: true,
      });
    }
    return output;
  };

  try {
    const data = visit(value, 0);
    return { data, bytes: maxBytes - remainingBytes };
  } catch (error) {
    if (error instanceof GatewayProtocolError) throw error;
    throw new GatewayProtocolError(4002, 'Gateway dispatch data could not be read safely.');
  }
}

function jsonStringByteLength(value: string, maxBytes: number, errorMessage: string): number {
  let bytes = 2;
  if (bytes > maxBytes) throw new GatewayProtocolError(4002, errorMessage);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let addedBytes: number;
    if (code === 0x22 || code === 0x5c) {
      addedBytes = 2;
    } else if (code <= 0x1f) {
      addedBytes =
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addedBytes = 4;
        index += 1;
      } else {
        addedBytes = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      addedBytes = 6;
    } else if (code <= 0x7f) {
      addedBytes = 1;
    } else if (code <= 0x7ff) {
      addedBytes = 2;
    } else {
      addedBytes = 3;
    }
    if (addedBytes > maxBytes - bytes) throw new GatewayProtocolError(4002, errorMessage);
    bytes += addedBytes;
  }
  return bytes;
}

function dispatchSizeError(maxBytes: number): GatewayProtocolError {
  return new GatewayProtocolError(
    4002,
    `Gateway dispatch exceeds the configured ${maxBytes} byte limit.`,
  );
}

function boundedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function toSessionView(session: MutableSession): GatewaySessionView {
  return {
    id: session.id,
    state: session.state,
    sequence: session.sequence,
    intents: session.intents,
    connectedAtMs: session.connectedAtMs,
    ...(session.disconnectedAtMs === undefined
      ? {}
      : { disconnectedAtMs: session.disconnectedAtMs }),
    ...(session.lastHeartbeatAtMs === undefined
      ? {}
      : { lastHeartbeatAtMs: session.lastHeartbeatAtMs }),
    ...(session.lastHeartbeatSequence === undefined
      ? {}
      : { lastHeartbeatSequence: session.lastHeartbeatSequence }),
  };
}
