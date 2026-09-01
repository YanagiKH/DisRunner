import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  GatewayOpcodes,
  GatewayProtocolError,
  type GatewayEmulator,
  type GatewayPacket,
  type IdentifyPayload,
} from './gateway.js';
import type { TraceCollector } from './trace.js';

export interface LocalGatewayServerOptions {
  readonly gateway: GatewayEmulator;
  readonly trace?: TraceCollector;
  readonly maxPayloadBytes?: number;
  readonly maxConnections?: number;
  /** Maximum time a new connection may remain unauthenticated. */
  readonly identifyTimeoutMs?: number;
}

export interface LocalGatewayAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly url: string;
}

interface ConnectionState {
  sessionId?: string;
  identifyTimer?: NodeJS.Timeout;
}

/** Loopback-only WebSocket transport for the in-memory gateway protocol engine. */
export class LocalGatewayServer {
  readonly #gateway: GatewayEmulator;
  readonly #trace: TraceCollector | undefined;
  readonly #maxPayloadBytes: number;
  readonly #maxConnections: number;
  readonly #identifyTimeoutMs: number;
  readonly #connections = new Map<WebSocket, ConnectionState>();
  readonly #sessionConnections = new Map<string, WebSocket>();
  #server: WebSocketServer | undefined;
  #address: LocalGatewayAddress | undefined;

  public constructor(options: LocalGatewayServerOptions) {
    this.#gateway = options.gateway;
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
    this.#address = {
      host: '127.0.0.1',
      port: address.port,
      url: `ws://127.0.0.1:${address.port}/gateway`,
    };
    return this.#address;
  }

  public dispatch(sessionId: string, eventName: string, data: unknown): boolean {
    const packet = this.#gateway.dispatch(sessionId, eventName, data);
    if (packet === undefined) return false;
    const connection = this.#sessionConnections.get(sessionId);
    if (connection === undefined || connection.readyState !== WebSocket.OPEN) return false;
    this.#send(connection, packet);
    return true;
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    for (const [socket, state] of this.#connections) {
      if (state.identifyTimer !== undefined) clearTimeout(state.identifyTimer);
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
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
    );
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
      } else if (packet.op === GatewayOpcodes.HEARTBEAT) {
        if (state.sessionId === undefined)
          throw new GatewayProtocolError(4003, 'Identify before heartbeating.');
        const sequence =
          packet.d === null ? null : requireSafeInteger(packet.d, 'heartbeat sequence');
        const ack = this.#gateway.heartbeat(state.sessionId, sequence);
        if (ack !== undefined) this.#send(socket, ack);
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
        error instanceof GatewayProtocolError
          ? error
          : new GatewayProtocolError(4002, 'Invalid gateway payload.');
      socket.close(protocol.closeCode, protocol.message.slice(0, 123));
    }
  }

  #send(socket: WebSocket, packet: unknown): void {
    if (packet !== undefined && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(packet));
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
