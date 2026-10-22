import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { OrdinaryMessagePermissionProfile } from './ordinary-message-permissions.js';
import { parseRestBootstrapProfile, type RestBootstrapProfile } from './bootstrap-profile.js';
import type { SimulationMode } from './contracts.js';
import type { GatewayEmulator } from './gateway.js';
import {
  DiscordApiError,
  type InteractionEngine,
  type InteractionResponseType,
  type SimulatedInteraction,
} from './interactions.js';
import type { InteractionMessageResult } from './interaction-message-domain.js';
import { assertOfflineGatewayUrl, isLoopbackHostname } from './network-policy.js';
import {
  MessageDomainService,
  type MessageDomainContext,
  type MessageMutationResult,
} from './message-domain.js';
import type { RateLimitEngine, RateLimitResult } from './rate-limits.js';
import { redactString } from './redaction.js';
import { isOrdinaryMessage, projectMessageWire } from './message-events.js';
import { ResourceNotFoundError, type VirtualState } from './state.js';
import type { SpanHandle, TraceCollector } from './trace.js';
import { assertSyntheticToken, timingSafeTokenEqual } from './session-token.js';

export type {
  BootstrapApplication,
  BootstrapUser,
  RestBootstrapProfile,
} from './bootstrap-profile.js';

export interface RestEmulatorOptions {
  readonly ordinaryMessagePermissions?: OrdinaryMessagePermissionProfile;
  readonly state: VirtualState;
  readonly messageDomain?: MessageDomainContext;
  readonly interactions: InteractionEngine;
  readonly gateway: GatewayEmulator;
  readonly rateLimits: RateLimitEngine;
  readonly fakeToken?: string;
  readonly gatewayUrl?: string;
  readonly mode?: SimulationMode;
  readonly maxBodyBytes?: number;
  readonly trace?: TraceCollector;
  /**
   * Opt-in synthetic identity for `GET /users/@me` and `GET /oauth2/applications/@me`.
   * Validated strictly and deep-copied at construction; omitted means unconfigured.
   */
  readonly bootstrap?: RestBootstrapProfile | undefined;
}

export interface RestEmulatorAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
}

export class LocalRestEmulator {
  readonly #state: VirtualState;
  readonly #messages: MessageDomainService;
  readonly #interactions: InteractionEngine;
  readonly #rateLimits: RateLimitEngine;
  readonly #fakeToken: string;
  readonly #gatewayUrl: string;
  readonly #maxBodyBytes: number;
  readonly #trace: TraceCollector | undefined;
  readonly #bootstrap: RestBootstrapProfile | undefined;
  #server: Server | undefined;
  #address: RestEmulatorAddress | undefined;

  public constructor(options: RestEmulatorOptions) {
    const bootstrap = options.bootstrap;
    this.#bootstrap = bootstrap === undefined ? undefined : parseRestBootstrapProfile(bootstrap);
    this.#state = options.state;
    this.#messages = new MessageDomainService({
      state: options.state,
      ...(options.ordinaryMessagePermissions === undefined
        ? {}
        : { ordinaryMessagePermissions: options.ordinaryMessagePermissions }),
      gateway: options.gateway,
      ...(this.#bootstrap === undefined ? {} : { author: this.#bootstrap.user }),
      ...(options.messageDomain === undefined ? {} : { context: options.messageDomain }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    this.#interactions = options.interactions;
    this.#rateLimits = options.rateLimits;
    this.#fakeToken = assertSyntheticToken(options.fakeToken ?? options.gateway.sessionToken);
    this.#gatewayUrl = assertOfflineGatewayUrl(options.gatewayUrl ?? 'ws://127.0.0.1/gateway').href;
    this.#maxBodyBytes = boundedSizeLimit(options.maxBodyBytes ?? 1_048_576, 'maxBodyBytes');
    this.#trace = options.trace;
  }

  public messageEvidence(): ReturnType<MessageDomainService['evidence']> {
    return this.#messages.evidence();
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
      if (span !== undefined)
        this.#trace?.end(span, 'ok', {
          status: response.statusCode,
          ...(response.hasHeader('X-DisRunner-Event-Id')
            ? {
                eventId: response.getHeader('X-DisRunner-Event-Id'),
                stateRevision: response.getHeader('X-DisRunner-State-Revision'),
                delivery: response.getHeader('X-DisRunner-Delivery'),
              }
            : {}),
        });
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
    if (method === 'GET' && path === '/users/@me' && this.#bootstrap !== undefined) {
      sendJson(response, 200, this.#bootstrap.user, rateLimit.headers);
      return;
    }
    if (method === 'GET' && path === '/oauth2/applications/@me' && this.#bootstrap !== undefined) {
      sendJson(response, 200, this.#bootstrap.application, rateLimit.headers);
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
      const channel = this.#state.require('channel', channelId);
      if (method === 'POST') {
        const result = this.#messages.create(channelId, requireObjectBody(body));
        sendJson(
          response,
          200,
          messageRepresentation(result.message),
          mutationHeaders(rateLimit, result),
        );
        return;
      }
      if (method === 'GET') {
        const history = this.#messages.authorizeRead(channelId);
        const limit = parseMessageLimit(url.searchParams.get('limit'));
        const messages = this.#state
          .list('message')
          .filter(
            (message) =>
              history &&
              readableMessage(message, channel) &&
              (this.#messages.ordinaryMessagePermissions === 'legacy-unenforced' ||
                channel['type'] === 1 ||
                message['message_origin'] !== 'interaction'),
          )
          .slice(-limit)
          .map(messageRepresentation);
        sendJson(response, 200, messages, rateLimit.headers);
        return;
      }
    }

    const messageMatch = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (messageMatch !== null) {
      const channelId = messageMatch[1] as string;
      const messageId = messageMatch[2] as string;
      if (
        this.#messages.ordinaryMessagePermissions === 'guild-text-own-messages-v1' &&
        !isExplicitDirectMessageChannel(this.#state.require('channel', channelId))
      ) {
        const channel = this.#state.require('channel', channelId);
        // Direct mutation service owns policy checks; object-body validation still precedes them.
        if (method === 'PATCH') {
          const result = this.#messages.update(channelId, messageId, requireObjectBody(body));
          sendJson(
            response,
            200,
            messageRepresentation(result.message),
            mutationHeaders(rateLimit, result),
          );
          return;
        }
        if (method === 'DELETE') {
          const result = this.#messages.delete(channelId, messageId);
          sendEmpty(response, 204, mutationHeaders(rateLimit, result));
          return;
        }
        if (method === 'GET') {
          this.#messages.authorizeRead(channelId, true);
          const message = this.#state.require('message', messageId);
          if (
            !readableMessage(message, channel) ||
            (channel['type'] !== 1 && message['message_origin'] === 'interaction')
          )
            throw new ResourceNotFoundError('message', messageId);
          sendJson(response, 200, messageRepresentation(message), rateLimit.headers);
          return;
        }
      }
      const message = this.#state.require('message', messageId);
      if (message['channel_id'] !== channelId)
        throw new ResourceNotFoundError('message', messageId);
      if (method === 'GET') {
        const channel = this.#state.require('channel', channelId);
        if (!readableMessage(message, channel))
          throw new ResourceNotFoundError('message', messageId);
        sendJson(response, 200, messageRepresentation(message), rateLimit.headers);
        return;
      }
      if (method === 'PATCH') {
        const result = this.#messages.update(channelId, messageId, requireObjectBody(body));
        sendJson(
          response,
          200,
          messageRepresentation(result.message),
          mutationHeaders(rateLimit, result),
        );
        return;
      }
      if (method === 'DELETE') {
        const result = this.#messages.delete(channelId, messageId);
        sendEmpty(response, 204, mutationHeaders(rateLimit, result));
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
      const token = decodeRouteToken(callbackMatch[2] as string);
      const interaction = this.#interactions.get(interactionId);
      if (interaction === undefined || !routeTokenEqual(token, interaction.token))
        throw new DiscordApiError(404, 10062, 'Unknown interaction.');
      if (isAuthoritative(interaction)) {
        this.#authoritativeCallback(interaction, url, body, response, rateLimit);
        return;
      }
      const payload = requireObjectBody(body);
      const callbackType = callbackTypeName(payload['type']);
      this.#interactions.respond(interactionId, callbackType, objectOrEmpty(payload['data']));
      sendEmpty(response, 204, rateLimit.headers);
      return;
    }

    const webhookMatch = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path);
    if (webhookMatch !== null && method === 'POST') {
      const token = decodeRouteToken(webhookMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      if (interaction === undefined) throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      if (isAuthoritative(interaction)) {
        requireNoMessageQuery(url);
        const result = this.#interactions.executeMessage({
          operation: 'create-followup',
          interactionId: interaction.id,
          data: requireMessageBody(requireJsonBody(body)),
        });
        sendJson(
          response,
          200,
          messageRepresentation(result.message as Readonly<Record<string, unknown>>),
          interactionHeaders(rateLimit, result),
        );
        return;
      }
      sendJson(
        response,
        200,
        this.#interactions.followup(interaction.id, requireObjectBody(body)),
        rateLimit.headers,
      );
      return;
    }

    const itemMatch = WEBHOOK_ITEM_ROUTE.exec(path);
    if (itemMatch !== null && ['GET', 'PATCH', 'DELETE'].includes(method)) {
      const token = decodeRouteToken(itemMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      if (interaction === undefined) throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      // New item routes validate query options after authentication, quota and body parsing,
      // including model-only interactions that cannot supply authoritative messages.
      requireNoMessageQuery(url);
      if (!isAuthoritative(interaction)) throw unsupportedMessageRoute();
      this.#authoritativeItem(
        method,
        interaction,
        itemMatch[3] as string,
        body,
        response,
        rateLimit,
      );
      return;
    }

    throw new DiscordApiError(404, 0, '404: Not Found');
  }

  #authoritativeCallback(
    interaction: SimulatedInteraction,
    url: URL,
    body: unknown,
    response: ServerResponse,
    rateLimit: RateLimitResult,
  ): void {
    const withResponse = parseWithResponse(url);
    const payload = requireMessageBody(requireJsonBody(body));
    if (Object.keys(payload).some((key) => key !== 'type' && key !== 'data'))
      throw invalidMessagePayload();
    const responseType = AUTHORITATIVE_CALLBACK_TYPES[payload['type'] as number];
    if (typeof payload['type'] !== 'number' || responseType === undefined)
      throw invalidMessagePayload();
    let data: Readonly<Record<string, unknown>> | undefined;
    if (Object.hasOwn(payload, 'data')) data = requireMessageBody(payload['data']);
    const result = this.#interactions.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType,
      ...(data === undefined ? {} : { data }),
    });
    const headers = interactionHeaders(rateLimit, result);
    if (!withResponse) {
      sendEmpty(response, 204, headers);
      return;
    }
    const message = result.message;
    const flags = message === null ? 0 : (message['flags'] as number);
    sendJson(
      response,
      200,
      {
        interaction: {
          id: interaction.id,
          type: 2,
          ...(message === null
            ? {}
            : {
                response_message_id: message.id,
                response_message_loading: (flags & 128) !== 0,
                response_message_ephemeral: (flags & 64) !== 0,
              }),
        },
        ...(message === null || (flags & 128) !== 0
          ? {}
          : { resource: { type: 4, message: messageRepresentation(message) } }),
      },
      headers,
    );
  }

  #authoritativeItem(
    method: string,
    interaction: SimulatedInteraction,
    item: string,
    body: unknown,
    response: ServerResponse,
    rateLimit: RateLimitResult,
  ): void {
    const original = item === '@original';
    if (method === 'GET') {
      const message = original
        ? this.#interactions.getOriginalMessage(interaction.id)
        : this.#interactions.getFollowupMessage(interaction.id, item);
      sendJson(response, 200, messageRepresentation(message), rateLimit.headers);
      return;
    }
    if (method === 'PATCH') {
      const data = requireMessageBody(requireJsonBody(body));
      const result = this.#interactions.executeMessage(
        original
          ? { operation: 'edit-original', interactionId: interaction.id, data }
          : { operation: 'edit-followup', interactionId: interaction.id, messageId: item, data },
      );
      sendJson(
        response,
        200,
        messageRepresentation(result.message as Readonly<Record<string, unknown>>),
        interactionHeaders(rateLimit, result),
      );
      return;
    }
    const result = this.#interactions.executeMessage(
      original
        ? { operation: 'delete-original', interactionId: interaction.id }
        : { operation: 'delete-followup', interactionId: interaction.id, messageId: item },
    );
    sendEmpty(response, 204, interactionHeaders(rateLimit, result));
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
      // Unknown interaction, wrong token, no bound application, or expired: rejected here,
      // before any rate-limit quota is spent and before the body is read.
      if (
        interaction === undefined ||
        !routeTokenEqual(token, interaction.token) ||
        interaction.applicationId === undefined ||
        interaction.status === 'expired'
      ) {
        throw new DiscordApiError(404, 10062, 'Unknown interaction.');
      }
      return `/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`;
    }
    const webhookMatch = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path);
    if (webhookMatch !== null) {
      const applicationId = webhookMatch[1] as string;
      const token = decodeRouteToken(webhookMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      // The path application ID must exactly equal the application the interaction is bound
      // to; unbound interactions fail closed. Rejected before quota and before the body read.
      if (
        interaction === undefined ||
        !routeTokenEqual(token, interaction.token) ||
        interaction.applicationId === undefined ||
        interaction.applicationId !== applicationId
      ) {
        throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      }
      if (interaction.status === 'expired') {
        // The model's own token check reports EXPIRED_INTERACTION_TOKEN and throws 404/10015
        // for an expired interaction without changing it; quota has not been spent yet.
        // Authoritative interactions are rejected on the snapshot alone.
        if (!isAuthoritative(interaction)) this.#interactions.followup(interaction.id, {});
        throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      }
      // The bucket path is the verified identity, so rotating path IDs cannot add buckets.
      return `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}`;
    }
    const itemMatch = WEBHOOK_ITEM_ROUTE.exec(path);
    if (itemMatch !== null) {
      const applicationId = itemMatch[1] as string;
      const token = decodeRouteToken(itemMatch[2] as string);
      const interaction = this.#interactions.getByToken(token);
      // Non-mutating lookup: identity and expiry are compared on the snapshot and rejected
      // before quota and before the body is read. Nothing is recorded on the interaction.
      if (
        interaction === undefined ||
        !routeTokenEqual(token, interaction.token) ||
        interaction.applicationId === undefined ||
        interaction.applicationId !== applicationId ||
        interaction.status === 'expired'
      ) {
        throw new DiscordApiError(404, 10015, 'Unknown webhook.');
      }
      // The item ID is not a major parameter: every followup ID shares one bucket.
      const suffix = itemMatch[3] === '@original' ? '@original' : ':messageId';
      return `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}/messages/${suffix}`;
    }
    throw new DiscordApiError(404, 0, '404: Not Found');
  }
}

function stripApiVersion(path: string): string {
  return path.replace(/^\/api\/v(?:10|9)(?=\/|$)/, '') || '/';
}

function traceRouteTemplate(path: string): string {
  // Trace metadata is recorded before authorization. Never reflect path segments from
  // sensitive route families, even when the method, ID, token encoding, or suffix is invalid.
  if (/^\/interactions(?:\/|$)/.test(path)) return '/interactions/:interactionId/:token/callback';
  if (/^\/webhooks(?:\/|$)/.test(path)) return '/webhooks/:webhookId/:token';
  return path;
}

const WEBHOOK_ITEM_ROUTE = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/(@original|\d+)$/;

function isTokenAuthenticatedRoute(method: string, path: string): boolean {
  if (['GET', 'PATCH', 'DELETE'].includes(method) && WEBHOOK_ITEM_ROUTE.test(path)) return true;
  return (
    method === 'POST' &&
    (/^\/interactions\/\d+\/[^/]+\/callback$/.test(path) || /^\/webhooks\/\d+\/[^/]+$/.test(path))
  );
}

function isAuthoritative(interaction: SimulatedInteraction): boolean {
  return interaction.messageProfile === 'chat-input-messages-v1';
}

const AUTHORITATIVE_CALLBACK_TYPES: Readonly<Record<number, InteractionResponseType>> = {
  4: 'message',
  5: 'defer',
  9: 'modal',
};

function invalidMessagePayload(): DiscordApiError {
  return new DiscordApiError(400, 50035, 'Invalid interaction message payload.');
}

function unsupportedMessageRoute(): DiscordApiError {
  return new DiscordApiError(501, 0, 'This interaction does not support message routes.');
}

/** An empty request body is not valid JSON; it gets the fixed JSON syntax diagnostic. */
function requireJsonBody(value: unknown): unknown {
  if (value === undefined) throw new DiscordApiError(400, 50035, 'Invalid JSON body.');
  return value;
}

/** A present message body or callback data must be a plain JSON object. */
function requireMessageBody(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidMessagePayload();
  return value as Readonly<Record<string, unknown>>;
}

/** Only an absent query or exactly `with_response=true|false` is accepted. */
function parseWithResponse(url: URL): boolean {
  const entries = [...url.searchParams.entries()];
  if (url.search === '' || url.search === '?') return false;
  if (entries.length !== 1 || entries[0]?.[0] !== 'with_response') throw invalidMessagePayload();
  const value = entries[0][1];
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalidMessagePayload();
}

/** Original/followup message routes have no supported query options in this profile. */
function requireNoMessageQuery(url: URL): void {
  if (url.search !== '') throw invalidMessagePayload();
}

/** Revision, delivery and event headers only for a committed public message event. */
function interactionHeaders(
  rateLimit: RateLimitResult,
  result: InteractionMessageResult,
): Readonly<Record<string, string>> {
  if (result.eventId === null || result.delivery === null) return rateLimit.headers;
  return {
    ...rateLimit.headers,
    'X-DisRunner-State-Revision': String(result.stateRevision),
    'X-DisRunner-Delivery': result.delivery.status,
    'X-DisRunner-Delivery-Failures': String(
      result.delivery.failed + result.delivery.transportFailed,
    ),
    'X-DisRunner-Event-Id': result.eventId,
  };
}

/** Constant-time comparison for route tokens; the value is compared exactly as sent. */
function routeTokenEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
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

/** Local diagnostic extensions, not Discord wire contract fields. */
function mutationHeaders(
  rateLimit: RateLimitResult,
  result: MessageMutationResult,
): Readonly<Record<string, string>> {
  return {
    ...rateLimit.headers,
    'X-DisRunner-State-Revision': String(result.stateRevision),
    'X-DisRunner-Delivery': result.delivery.status,
    'X-DisRunner-Delivery-Failures': String(
      result.delivery.failed + result.delivery.transportFailed,
    ),
    ...(result.eventId === null ? {} : { 'X-DisRunner-Event-Id': result.eventId }),
  };
}
function messageRepresentation(
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return projectMessageWire(message);
}

function readableMessage(
  message: Readonly<Record<string, unknown>>,
  channel: Readonly<Record<string, unknown>>,
): boolean {
  return (
    isOrdinaryMessage(message) &&
    message['channel_id'] === channel['id'] &&
    ((channel['type'] === 0 &&
      typeof channel['guild_id'] === 'string' &&
      message['guild_id'] === channel['guild_id']) ||
      (channel['type'] === 1 &&
        channel['guild_id'] === undefined &&
        message['guild_id'] === undefined))
  );
}

function isExplicitDirectMessageChannel(channel: Readonly<Record<string, unknown>>): boolean {
  return channel['type'] === 1 && channel['guild_id'] === undefined;
}
