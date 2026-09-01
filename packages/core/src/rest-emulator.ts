import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { SimulationMode } from './contracts.js';
import type { GatewayEmulator } from './gateway.js';
import {
  DiscordApiError,
  type InteractionEngine,
  type InteractionResponseType,
} from './interactions.js';
import { assertOfflineGatewayUrl, isLoopbackHostname } from './network-policy.js';
import { assertValidMessagePayload } from './protocol-limits.js';
import type { RateLimitEngine, RateLimitResult } from './rate-limits.js';
import { redactString } from './redaction.js';
import { ResourceNotFoundError, type VirtualState } from './state.js';
import type { SpanHandle, TraceCollector } from './trace.js';
import { assertSyntheticToken, timingSafeTokenEqual } from './session-token.js';

export interface RestEmulatorOptions {
  readonly state: VirtualState;
  readonly interactions: InteractionEngine;
  readonly gateway: GatewayEmulator;
  readonly rateLimits: RateLimitEngine;
  readonly fakeToken?: string;
  readonly gatewayUrl?: string;
  readonly mode?: SimulationMode;
  readonly maxBodyBytes?: number;
  readonly trace?: TraceCollector;
}

export interface RestEmulatorAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
}

export class LocalRestEmulator {
  readonly #state: VirtualState;
  readonly #interactions: InteractionEngine;
  readonly #rateLimits: RateLimitEngine;
  readonly #fakeToken: string;
  readonly #gatewayUrl: string;
  readonly #mode: SimulationMode;
  readonly #maxBodyBytes: number;
  readonly #trace: TraceCollector | undefined;
  #server: Server | undefined;
  #address: RestEmulatorAddress | undefined;

  public constructor(options: RestEmulatorOptions) {
    this.#state = options.state;
    this.#interactions = options.interactions;
    this.#rateLimits = options.rateLimits;
    this.#fakeToken = assertSyntheticToken(options.fakeToken ?? options.gateway.sessionToken);
    this.#gatewayUrl = assertOfflineGatewayUrl(options.gatewayUrl ?? 'ws://127.0.0.1/gateway').href;
    this.#mode = options.mode ?? 'strict';
    this.#maxBodyBytes = boundedSizeLimit(options.maxBodyBytes ?? 1_048_576, 'maxBodyBytes');
    this.#trace = options.trace;
  }

  public get address(): RestEmulatorAddress | undefined {
    return this.#address;
  }

  /** The per-instance synthetic token to inject into the contained bot process. */
  public get sessionToken(): string {
    return this.#fakeToken;
  }

  public async start(port = 0): Promise<RestEmulatorAddress> {
    if (this.#server !== undefined) throw new Error('REST emulator is already running.');
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new RangeError('Port is invalid.');
    const server = createServer((request, response) => void this.#handle(request, response));
    this.#server = server;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolvePromise();
        });
      });
    } catch (error) {
      try {
        server.close();
      } catch {
        // A listen failure can leave no active HTTP listener to close.
      }
      this.#server = undefined;
      this.#address = undefined;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await this.stop();
      throw new Error('REST emulator did not bind a TCP port.');
    }
    this.#address = {
      host: '127.0.0.1',
      port: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/v10`,
    };
    return this.#address;
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
      server.closeAllConnections();
    });
    this.#server = undefined;
    this.#address = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let span: SpanHandle | undefined;
    try {
      this.#validateLocalRequest(request);
      const method = request.method?.toUpperCase() ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const routePath = stripApiVersion(url.pathname);
      const routeTemplate = traceRouteTemplate(routePath);
      span = this.#trace?.start('rest', `${method} ${routeTemplate}`, {
        method,
        path: routeTemplate,
        authorization: request.headers.authorization,
      });
      const authorization = request.headers.authorization;
      const tokenAuthenticated = isTokenAuthenticatedRoute(method, routePath);
      let rateLimitPath = routePath;
      if (tokenAuthenticated) {
        rateLimitPath = this.#authorizeTokenRoute(routePath);
      } else if (!this.#authorized(authorization)) {
        throw new DiscordApiError(401, 0, '401: Unauthorized');
      }
      // Never let an untrusted Authorization value choose a user-scoped bucket. Protected
      // routes share the already-authenticated simulator identity; token-authenticated
      // interaction/webhook routes use a fixed identity plus their route major parameters.
      const identity = tokenAuthenticated ? 'interaction-webhook' : 'authenticated-bot';
      const rateLimit = this.#rateLimits.acquire({ method, path: rateLimitPath, identity });
      if (!rateLimit.allowed) {
        sendJson(response, 429, rateLimit.body, rateLimit.headers);
        if (span !== undefined) this.#trace?.end(span, 'warning', { status: 429 });
        return;
      }
      const body = await readJsonBody(request, this.#maxBodyBytes);
      this.#route(method, routePath, url, body, response, rateLimit);
      if (span !== undefined) this.#trace?.end(span, 'ok', { status: response.statusCode });
    } catch (error) {
      const apiError = normalizeError(error);
      sendJson(response, apiError.status, apiError.toJSON());
      if (span !== undefined)
        this.#trace?.end(span, 'error', { status: apiError.status, error: apiError.message });
    }
  }

  #route(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    response: ServerResponse,
    rateLimit: RateLimitResult,
  ): void {
    if (method === 'GET' && path === '/gateway') {
      sendJson(response, 200, { url: this.#gatewayUrl }, rateLimit.headers);
      return;
    }
    if (method === 'GET' && path === '/gateway/bot') {
      sendJson(
        response,
        200,
        {
          url: this.#gatewayUrl,
          shards: 1,
          session_start_limit: {
            total: 1_000,
            remaining: 1_000,
            reset_after: 86_400_000,
            max_concurrency: 1,
          },
        },
        rateLimit.headers,
      );
      return;
    }
    if (method === 'GET' && path === '/users/@me') {
      const user = this.#state.list('user').find((candidate) => candidate['bot'] === true) ?? {
        id: '0',
        resourceType: 'user',
        username: 'DisRunner Bot',
        discriminator: '0000',
        bot: true,
      };
      sendJson(response, 200, stripResourceType(user), rateLimit.headers);
      return;
    }

    const channelMatch = /^\/channels\/(\d+)$/.exec(path);
    if (channelMatch !== null) {
      const channelId = channelMatch[1] as string;
      if (method === 'GET') {
        sendJson(
          response,
          200,
          stripResourceType(this.#state.require('channel', channelId)),
          rateLimit.headers,
        );
        return;
      }
      if (method === 'PATCH') {
        const changes = requireObjectBody(body);
        sendJson(
          response,
          200,
          stripResourceType(this.#state.update('channel', channelId, changes)),
          rateLimit.headers,
        );
        return;
      }
      if (method === 'DELETE') {
        this.#state.delete('channel', channelId);
        sendEmpty(response, 204, rateLimit.headers);
        return;
      }
    }

    const messagesMatch = /^\/channels\/(\d+)\/messages$/.exec(path);
    if (messagesMatch !== null) {
      const channelId = messagesMatch[1] as string;
      this.#state.require('channel', channelId);
      if (method === 'POST') {
        const data = requireObjectBody(body);
        validateMessage(data, this.#mode);
        const message = this.#state.create('message', {
          ...data,
          channel_id: channelId,
          timestamp: new Date(this.#state.now()).toISOString(),
        });
        sendJson(response, 200, stripResourceType(message), rateLimit.headers);
        return;
      }
      if (method === 'GET') {
        const limit = parseMessageLimit(url.searchParams.get('limit'));
        const messages = this.#state
          .list('message')
          .filter((message) => message['channel_id'] === channelId)
          .slice(-limit)
          .map(stripResourceType);
        sendJson(response, 200, messages, rateLimit.headers);
        return;
      }
    }

    const messageMatch = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (messageMatch !== null) {
      const channelId = messageMatch[1] as string;
      const messageId = messageMatch[2] as string;
      const message = this.#state.require('message', messageId);
      if (message['channel_id'] !== channelId)
        throw new ResourceNotFoundError('message', messageId);
      if (method === 'GET') {
        sendJson(response, 200, stripResourceType(message), rateLimit.headers);
        return;
      }
      if (method === 'PATCH') {
        const changes = requireObjectBody(body);
        validateMessage(changes, this.#mode, true);
        sendJson(
          response,
          200,
          stripResourceType(
            this.#state.update('message', messageId, {
              ...changes,
              edited_timestamp: new Date(this.#state.now()).toISOString(),
            }),
          ),
          rateLimit.headers,
        );
        return;
      }
      if (method === 'DELETE') {
        this.#state.delete('message', messageId);
        sendEmpty(response, 204, rateLimit.headers);
        return;
      }
    }

    const guildMatch = /^\/guilds\/(\d+)$/.exec(path);
    if (guildMatch !== null && method === 'GET') {
      sendJson(
        response,
        200,
        stripResourceType(this.#state.require('guild', guildMatch[1] as string)),
        rateLimit.headers,
      );
      return;
    }
    const guildChannelsMatch = /^\/guilds\/(\d+)\/channels$/.exec(path);
    if (guildChannelsMatch !== null) {
      const guildId = guildChannelsMatch[1] as string;
      this.#state.require('guild', guildId);
      if (method === 'GET') {
        sendJson(
          response,
          200,
          this.#state
            .list('channel')
            .filter((channel) => channel['guild_id'] === guildId)
            .map(stripResourceType),
          rateLimit.headers,
        );
        return;
      }
      if (method === 'POST') {
        const channel = this.#state.create('channel', {
          ...requireObjectBody(body),
          guild_id: guildId,
        });
        sendJson(response, 201, stripResourceType(channel), rateLimit.headers);
        return;
      }
    }

    const callbackMatch = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(path);
    if (callbackMatch !== null && method === 'POST') {
      const interactionId = callbackMatch[1] as string;
      const token = decodeURIComponent(callbackMatch[2] as string);
      const interaction = this.#interactions.get(interactionId);
      if (interaction === undefined || interaction.token !== token)
        throw new DiscordApiError(404, 10062, 'Unknown interaction.');
      const payload = requireObjectBody(body);
      const callbackType = callbackTypeName(payload['type']);
      this.#interactions.respond(interactionId, callbackType, objectOrEmpty(payload['data']));
      sendEmpty(response, 204, rateLimit.headers);
      return;
    }

    const webhookMatch = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path);
    if (webhookMatch !== null && method === 'POST') {
      const token = decodeURIComponent(webhookMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      if (interaction === undefined) throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      sendJson(
        response,
        200,
        this.#interactions.followup(interaction.id, requireObjectBody(body)),
        rateLimit.headers,
      );
      return;
    }

    throw new DiscordApiError(404, 0, '404: Not Found');
  }

  #validateLocalRequest(request: IncomingMessage): void {
    const hostHeader = request.headers.host;
    if (hostHeader === undefined) throw new DiscordApiError(400, 0, 'Host header is required.');
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      throw new DiscordApiError(400, 0, 'Invalid Host header.');
    }
    if (!isLoopbackHostname(hostname))
      throw new DiscordApiError(403, 0, 'Only loopback requests are accepted.');
  }

  #authorized(header: string | undefined): boolean {
    return header !== undefined && timingSafeTokenEqual(header, this.#fakeToken);
  }

  #authorizeTokenRoute(path: string): string {
    const callbackMatch = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(path);
    if (callbackMatch !== null) {
      const interactionId = callbackMatch[1] as string;
      const token = decodeRouteToken(callbackMatch[2] as string);
      const interaction = this.#interactions.get(interactionId);
      if (interaction === undefined || interaction.token !== token) {
        throw new DiscordApiError(404, 10062, 'Unknown interaction.');
      }
      return `/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`;
    }
    const webhookMatch = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path);
    if (webhookMatch !== null) {
      const token = decodeRouteToken(webhookMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      if (interaction === undefined) {
        throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      }
      // The core interaction model does not yet carry an application ID. Canonicalize the
      // untrusted webhookId to the verified interaction ID so rotating path IDs cannot create
      // unbounded rate-limit majors for one valid token.
      return `/webhooks/${interaction.id}/${encodeURIComponent(interaction.token)}`;
    }
    throw new DiscordApiError(404, 0, '404: Not Found');
  }
}

function stripApiVersion(path: string): string {
  return path.replace(/^\/api\/v(?:10|9)(?=\/|$)/, '') || '/';
}

function traceRouteTemplate(path: string): string {
  return path
    .replace(
      /^\/interactions\/\d+\/[^/]+\/callback$/,
      '/interactions/:interactionId/:token/callback',
    )
    .replace(/^\/webhooks\/\d+\/[^/]+$/, '/webhooks/:webhookId/:token');
}

function isTokenAuthenticatedRoute(method: string, path: string): boolean {
  return (
    method === 'POST' &&
    (/^\/interactions\/\d+\/[^/]+\/callback$/.test(path) || /^\/webhooks\/\d+\/[^/]+$/.test(path))
  );
}

function decodeRouteToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DiscordApiError(400, 50035, 'Invalid route token encoding.');
  }
}

function parseMessageLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new DiscordApiError(400, 50035, 'limit must be an integer between 1 and 100.');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new DiscordApiError(400, 50035, 'limit must be an integer between 1 and 100.');
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) throw new DiscordApiError(413, 40005, 'Request entity too large.');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DiscordApiError(400, 50035, 'Invalid JSON body.');
  }
}

function requireObjectBody(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiscordApiError(400, 50035, 'A JSON object body is required.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function objectOrEmpty(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function validateMessage(
  data: Readonly<Record<string, unknown>>,
  mode: SimulationMode,
  partial = false,
): void {
  const content = data['content'];
  if (
    !partial &&
    mode === 'strict' &&
    content === undefined &&
    data['embeds'] === undefined &&
    data['components'] === undefined
  ) {
    throw new DiscordApiError(400, 50006, 'Cannot send an empty message.');
  }
  try {
    assertValidMessagePayload(data, mode);
  } catch (error) {
    if (error instanceof Error) throw new DiscordApiError(400, 50035, error.message);
    throw error;
  }
}

function callbackTypeName(value: unknown): InteractionResponseType {
  const mapping: Readonly<Record<number, InteractionResponseType>> = {
    4: 'message',
    5: 'defer',
    6: 'defer-update',
    7: 'update',
    8: 'autocomplete',
    9: 'modal',
  };
  if (typeof value !== 'number' || mapping[value] === undefined) {
    throw new DiscordApiError(400, 50035, 'Invalid interaction callback type.');
  }
  return mapping[value];
}

function stripResourceType(
  resource: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...resource };
  delete result['resourceType'];
  return result;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function sendEmpty(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

function normalizeError(error: unknown): DiscordApiError {
  if (error instanceof DiscordApiError) return error;
  if (error instanceof ResourceNotFoundError)
    return new DiscordApiError(404, error.code, error.message);
  return new DiscordApiError(
    500,
    0,
    error instanceof Error ? redactString(error.message) : 'Internal simulator error.',
  );
}

function boundedSizeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 67_108_864) {
    throw new RangeError(`${name} must be a positive safe integer no greater than 64 MiB.`);
  }
  return value;
}
