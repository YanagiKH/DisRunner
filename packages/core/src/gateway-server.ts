import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  GatewayOpcodes,
  GatewayProtocolError,
  type GatewayEmulator,
  type GatewayPacket,
  type IdentifyPayload,
} from './gateway.js';
import { GatewayIntentError } from './intents.js';
import type { FaultPolicy, GatewayFaultEffect } from './fault-policy.js';
import type { TraceCollector } from './trace.js';

export interface LocalGatewayServerOptions {
  readonly gateway: GatewayEmulator;
  readonly faultPolicy?: FaultPolicy;
  readonly trace?: TraceCollector;
  readonly maxPayloadBytes?: number;
  readonly maxConnections?: number;
  /** Maximum time a new connection may remain unauthenticated. */
  readonly identifyTimeoutMs?: number;
  /** Host-time deadline between authenticated heartbeats, independent of model time. */
  readonly heartbeatTimeoutMs?: number;
}

export interface LocalGatewayAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly url: string;
}

interface ConnectionState {
  sessionId?: string;
  identifyTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
}

/** Loopback-only WebSocket transport for the in-memory gateway protocol engine. */
export class LocalGatewayServer {
  readonly #gateway: GatewayEmulator;
  readonly #faultPolicy: FaultPolicy | undefined;
  readonly #publicationFaults = new Map<number, GatewayFaultEffect | null>();
  readonly #trace: TraceCollector | undefined;
  readonly #maxPayloadBytes: number;
  readonly #maxConnections: number;
  readonly #identifyTimeoutMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #connections = new Map<WebSocket, ConnectionState>();
  readonly #sessionConnections = new Map<string, WebSocket>();
  #unsubscribeBroadcast: (() => void) | undefined;
  #server: WebSocketServer | undefined;
  #address: LocalGatewayAddress | undefined;

  public constructor(options: LocalGatewayServerOptions) {
    this.#gateway = options.gateway;
    this.#faultPolicy = options.faultPolicy;
    this.#trace = options.trace;
    this.#maxPayloadBytes = boundedPositive(
      options.maxPayloadBytes ?? 1_048_576,
      'maxPayloadBytes',
    );
    this.#maxConnections = boundedPositive(options.maxConnections ?? 100, 'maxConnections');
    this.#identifyTimeoutMs = boundedPositive(
      options.identifyTimeoutMs ?? 10_000,
      'identifyTimeoutMs',
    );
    this.#heartbeatTimeoutMs = boundedPositive(
      options.heartbeatTimeoutMs ?? this.#gateway.heartbeatIntervalMs * 2,
      'heartbeatTimeoutMs',
    );
    if (this.#heartbeatTimeoutMs > 2_147_483_647) {
      throw new RangeError('heartbeatTimeoutMs exceeds the host timer limit.');
    }
  }

  public get address(): LocalGatewayAddress | undefined {
    return this.#address;
  }

  public async start(port = 0): Promise<LocalGatewayAddress> {
    if (this.#server !== undefined) throw new Error('Gateway server is already running.');
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new RangeError('Port is invalid.');
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: this.#maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#server = server;
    server.on('connection', (socket) => this.#accept(socket));
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.once('listening', () => {
          server.off('error', onError);
          resolvePromise();
        });
      });
    } catch (error) {
      try {
        server.close();
      } catch {
        // A listen failure can leave no underlying HTTP server to close.
      }
      this.#unsubscribeBroadcast?.();
      this.#unsubscribeBroadcast = undefined;
      this.#server = undefined;
      this.#address = undefined;
      throw error;
    }
    const rawAddress = server.address();
    if (rawAddress === null || typeof rawAddress === 'string') {
      await this.stop();
      throw new Error('Gateway server did not bind a TCP port.');
    }
    const address = rawAddress;
    const boundAddress: LocalGatewayAddress = {
      host: '127.0.0.1',
      port: address.port,
      url: `ws://127.0.0.1:${address.port}/gateway`,
    };
    try {
      this.#gateway.bindTransportEndpoint(boundAddress.url);
      this.#unsubscribeBroadcast = this.#gateway.subscribeBroadcast(
        (sessionId, packet, publicationId) => {
          const socket = this.#sessionConnections.get(sessionId);
          if (socket !== undefined && socket.readyState === WebSocket.OPEN)
            this.#send(socket, packet, publicationId);
        },
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.#address = boundAddress;
    return boundAddress;
  }

  /** True when queued on an open socket, not a peer receipt; buffered/filtered packets return false. */
  public dispatch(sessionId: string, eventName: string, data: unknown): boolean {
    const packet = this.#gateway.dispatch(sessionId, eventName, data);
    if (packet === undefined) return false;
    const connection = this.#sessionConnections.get(sessionId);
    if (connection === undefined || connection.readyState !== WebSocket.OPEN) return false;
    return this.#send(connection, packet);
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    for (const [socket, state] of this.#connections) {
      if (state.identifyTimer !== undefined) clearTimeout(state.identifyTimer);
      if (state.heartbeatTimer !== undefined) clearTimeout(state.heartbeatTimer);
      if (
        state.sessionId !== undefined &&
        this.#sessionConnections.get(state.sessionId) === socket
      ) {
        this.#sessionConnections.delete(state.sessionId);
        try {
          this.#gateway.disconnect(state.sessionId);
        } catch {
          // The protocol engine may already have invalidated the session.
        }
      }
      socket.terminate();
    }
    this.#connections.clear();
    this.#sessionConnections.clear();
    this.#publicationFaults.clear();
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
    );
    this.#unsubscribeBroadcast?.();
    this.#unsubscribeBroadcast = undefined;
    this.#server = undefined;
    this.#address = undefined;
  }

  #accept(socket: WebSocket): void {
    if (this.#connections.size >= this.#maxConnections) {
      socket.close(4008, 'Connection limit exceeded.');
      return;
    }
    const state: ConnectionState = {};
    this.#connections.set(socket, state);
    state.identifyTimer = setTimeout(() => {
      if (state.sessionId === undefined) socket.close(4003, 'Identify timeout.');
    }, this.#identifyTimeoutMs);
    state.identifyTimer.unref();
    this.#send(socket, this.#gateway.hello());
    socket.on('message', (data, isBinary) => this.#message(socket, state, data, isBinary));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (state.identifyTimer !== undefined) clearTimeout(state.identifyTimer);
      if (state.heartbeatTimer !== undefined) clearTimeout(state.heartbeatTimer);
      this.#connections.delete(socket);
      if (
        state.sessionId !== undefined &&
        this.#sessionConnections.get(state.sessionId) === socket
      ) {
        this.#sessionConnections.delete(state.sessionId);
        try {
          this.#gateway.disconnect(state.sessionId);
        } catch {
          // The protocol engine may already have invalidated the session.
        }
      }
    });
  }

  #message(socket: WebSocket, state: ConnectionState, data: RawData, isBinary: boolean): void {
    const span = this.#trace?.start('gateway', 'gateway.receive', { binary: isBinary });
    try {
      if (isBinary)
        throw new GatewayProtocolError(4002, 'Binary gateway payloads are unsupported.');
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (bytes.byteLength > this.#maxPayloadBytes)
        throw new GatewayProtocolError(4002, 'Gateway payload exceeds the configured limit.');
      const packet = parsePacket(bytes.toString('utf8'));
      if (packet.op === GatewayOpcodes.IDENTIFY) {
        if (state.sessionId !== undefined) {
          throw new GatewayProtocolError(4005, 'Connection is already authenticated.');
        }
        const result = this.#gateway.identify(asIdentify(packet.d));
        this.#bindSession(socket, state, result.sessionId);
        this.#send(socket, result.ready);
        for (const packet of result.bootstrap ?? []) this.#send(socket, packet);
      } else if (packet.op === GatewayOpcodes.HEARTBEAT) {
        const sequence =
          packet.d === null ? null : requireSafeInteger(packet.d, 'heartbeat sequence');
        // HELLO can trigger a heartbeat before IDENTIFY or RESUME. This ACK is
        // transport-only: do not bind a session or change the auth deadline.
        if (state.sessionId === undefined) {
          if (sequence !== null && sequence < 0)
            throw new GatewayProtocolError(4002, 'Heartbeat sequence must be nonnegative.');
          this.#send(socket, { op: GatewayOpcodes.HEARTBEAT_ACK, d: null });
        } else {
          const ack = this.#gateway.heartbeat(state.sessionId, sequence);
          this.#armHeartbeatDeadline(socket, state);
          if (ack !== undefined) this.#send(socket, ack);
        }
      } else if (packet.op === GatewayOpcodes.RESUME) {
        if (state.sessionId !== undefined) {
          throw new GatewayProtocolError(4005, 'Connection is already authenticated.');
        }
        const resume = asRecord(packet.d, 'resume payload');
        const sessionId = requireString(resume['session_id'], 'session_id');
        if (this.#sessionConnections.has(sessionId)) {
          throw new GatewayProtocolError(4005, 'Gateway session is already connected.');
        }
        const result = this.#gateway.resume(
          sessionId,
          requireString(resume['token'], 'token'),
          requireSafeInteger(resume['seq'], 'seq'),
        );
        if (!result.accepted) this.#send(socket, result.invalidSession);
        else {
          this.#bindSession(socket, state, sessionId);
          for (const replayed of result.replayed) this.#send(socket, replayed);
          this.#send(socket, result.resumed);
        }
      } else {
        throw new GatewayProtocolError(4001, 'Unknown or unsupported gateway opcode.');
      }
      if (span !== undefined) this.#trace?.end(span, 'ok', { opcode: packet.op });
    } catch (error) {
      if (span !== undefined)
        this.#trace?.end(span, 'error', {
          error: error instanceof Error ? error.message : String(error),
        });
      const protocol =
        error instanceof GatewayProtocolError || error instanceof GatewayIntentError
          ? error
          : new GatewayProtocolError(4002, 'Invalid gateway payload.');
      socket.close(protocol.closeCode, protocol.message.slice(0, 123));
    }
  }

  #send(socket: WebSocket, packet: unknown, publicationId?: number): boolean {
    if (packet === undefined || socket.readyState !== WebSocket.OPEN) return false;
    let copies = 1;
    const dispatch = packet as GatewayPacket;
    if (this.#faultPolicy !== undefined && dispatch.op === 0 && typeof dispatch.t === 'string') {
      let effect: GatewayFaultEffect | null;
      if (publicationId !== undefined && this.#publicationFaults.has(publicationId)) {
        effect = this.#publicationFaults.get(publicationId)!;
      } else {
        effect = this.#faultPolicy.consumeGateway(dispatch.t);
        if (publicationId !== undefined) {
          this.#publicationFaults.set(publicationId, effect);
          while (this.#publicationFaults.size > 128) {
            this.#publicationFaults.delete(this.#publicationFaults.keys().next().value!);
          }
        }
      }
      if (effect?.kind === 'disconnect') {
        const state = this.#connections.get(socket);
        if (state?.sessionId !== undefined) {
          this.#gateway.disconnect(state.sessionId);
          if (state.heartbeatTimer !== undefined) clearTimeout(state.heartbeatTimer);
        }
        socket.close(effect.closeCode, 'Injected Gateway disconnect.');
        return false;
      }
      if (effect?.kind === 'duplicate') copies = effect.copies;
    }
    const json = JSON.stringify(packet);
    for (let index = 0; index < copies; index += 1) socket.send(json);
    return true;
  }

  #bindSession(socket: WebSocket, state: ConnectionState, sessionId: string): void {
    if (state.sessionId !== undefined || this.#sessionConnections.has(sessionId)) {
      throw new GatewayProtocolError(4005, 'Gateway session is already connected.');
    }
    state.sessionId = sessionId;
    this.#sessionConnections.set(sessionId, socket);
    if (state.identifyTimer !== undefined) {
      clearTimeout(state.identifyTimer);
      delete state.identifyTimer;
    }
    this.#armHeartbeatDeadline(socket, state);
  }

  #armHeartbeatDeadline(socket: WebSocket, state: ConnectionState): void {
    if (state.heartbeatTimer !== undefined) clearTimeout(state.heartbeatTimer);
    state.heartbeatTimer = setTimeout(() => {
      if (state.sessionId !== undefined) {
        try {
          this.#gateway.disconnect(state.sessionId);
        } catch {
          // The protocol engine may already have expired this session.
        }
      }
      socket.close(4009, 'Heartbeat timeout.');
    }, this.#heartbeatTimeoutMs);
    state.heartbeatTimer.unref();
  }
}

function parsePacket(json: string): GatewayPacket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new GatewayProtocolError(4002, 'Invalid JSON gateway payload.');
  }
  const object = asRecord(parsed, 'gateway packet');
  return { op: requireSafeInteger(object['op'], 'op'), d: object['d'] };
}

function asIdentify(value: unknown): IdentifyPayload {
  const payload = asRecord(value, 'identify payload');
  const intents = payload['intents'];
  if (typeof intents !== 'number' && typeof intents !== 'string')
    throw new GatewayProtocolError(4002, 'Identify intents are invalid.');
  return {
    token: requireString(payload['token'], 'token'),
    intents,
    ...(Array.isArray(payload['shard'])
      ? { shard: payload['shard'] as unknown as readonly [number, number] }
      : {}),
  };
}

function asRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new GatewayProtocolError(4002, `${name} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new GatewayProtocolError(4002, `${name} must be a string.`);
  return value;
}

function requireSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new GatewayProtocolError(4002, `${name} must be a safe integer.`);
  return value;
}

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive.`);
  return value;
}
