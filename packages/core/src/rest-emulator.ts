import { ResourceDomainService } from './resource-domain.js';
import { FaultPolicy } from './fault-policy.js';
import {
  LocalAttachmentStore,
  parseMultipartBody,
  type PreparedAttachments,
} from './local-attachments.js';
import { ApplicationCommandRegistry } from './application-command-registry.js';
import {
  canonicalCommandId,
  commandError,
  type CommandRegistryProfile,
} from './application-command-profile.js';
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
  readonly faultPolicy?: FaultPolicy;
  readonly commandRegistry?: CommandRegistryProfile;
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
  readonly #resources: ResourceDomainService;
  readonly #faultPolicy: FaultPolicy;
  readonly #attachments: LocalAttachmentStore;
  readonly #state: VirtualState;
  readonly #commands: ApplicationCommandRegistry | undefined;
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
    this.#faultPolicy = options.faultPolicy ?? new FaultPolicy();
    this.#attachments = new LocalAttachmentStore({
      baseUrl: () => this.#address?.baseUrl ?? 'http://127.0.0.1:1',
    });
    const bootstrap = options.bootstrap;
    this.#bootstrap = bootstrap === undefined ? undefined : parseRestBootstrapProfile(bootstrap);
    this.#state = options.state;
    this.#resources = new ResourceDomainService({
      state: options.state,
      gateway: options.gateway,
      enforcePermissions: options.commandRegistry?.profile === 'command-registry-v2',
    });
    if (options.commandRegistry !== undefined && this.#bootstrap === undefined)
      throw commandError('payload');
    this.#commands =
      options.commandRegistry === undefined
        ? undefined
        : new ApplicationCommandRegistry(
            options.state,
            this.#bootstrap!.application.id,
            options.commandRegistry,
          );
    this.#messages = new MessageDomainService({
      state: options.state,
      sdkCompatibility: options.commandRegistry?.profile === 'command-registry-v2',
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

  public localAttachments(): LocalAttachmentStore {
    return this.#attachments;
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
    this.#faultPolicy.clear();
    this.#attachments.clear();
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
    let upload: PreparedAttachments | undefined;
    let spanFinished = false;
    const finishSpan = (
      status: 'ok' | 'warning' | 'error',
      metadata: Readonly<Record<string, unknown>>,
    ): void => {
      if (span === undefined || spanFinished) return;
      spanFinished = true;
      this.#trace?.end(span, status, metadata);
    };
    try {
      this.#validateLocalRequest(request);
      const method = request.method?.toUpperCase() ?? 'GET';
      const requestedPath = (request.url ?? '/').split('?')[0]!;
      if (
        this.#commands?.profile === 'command-registry-v2' &&
        /^\/api\/v[0-9]+(?:\/|$)/u.test(requestedPath) &&
        !/^\/api\/v10(?:\/|$)/u.test(requestedPath)
      )
        throw new DiscordApiError(501, 0, 'Unsupported API version. Use v10.');
      if (isCommandRegistryTarget(request.url ?? '/')) {
        span = this.#trace?.start('rest', 'application-command-registry', {
          path: '/applications/:applicationId/commands',
        });
        if (!this.#authorized(request.headers.authorization))
          throw new DiscordApiError(401, 0, '401: Unauthorized');
        await this.#commandRoute(method, request, response);
        if (span !== undefined)
          finishSpan(
            response.statusCode === 429 ? 'warning' : response.statusCode >= 400 ? 'error' : 'ok',
            {
              status: response.statusCode,
            },
          );
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const routePath = stripApiVersion(url.pathname.replace(/%40original$/iu, '@original'));
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
      const rateLimit = this.#rateLimits.acquire({
        method,
        path: rateLimitPath,
        identity,
        ...(tokenAuthenticated && this.#commands?.profile === 'command-registry-v2'
          ? { exemptGlobal: true }
          : {}),
      });
      if (!rateLimit.allowed) {
        sendJson(response, 429, rateLimit.body, rateLimit.headers);
        if (span !== undefined) finishSpan('warning', { status: 429 });
        return;
      }
      if (await this.#applyFault(method, routePath, response)) return;
      const attachmentRoute = /^\/attachments\/([1-9][0-9]{0,19})$/.exec(routePath);
      if (attachmentRoute && method === 'GET') {
        const retained = this.#attachments.get(attachmentRoute[1]!);
        if (
          !retained ||
          (!this.#state
            .list('message')
            .some(
              (m) =>
                Array.isArray(m['attachments']) &&
                records(m['attachments']).some((a) => a['id'] === attachmentRoute[1]) &&
                (m['visibility'] === 'channel' ||
                  (isRecord(m['author']) && m['author']['id'] === this.#bootstrap?.user.id)),
            ) &&
            !this.#state.get('attachment', attachmentRoute[1]!))
        )
          throw new DiscordApiError(404, 10008, 'Unknown attachment.');
        response.writeHead(200, {
          'Content-Type': retained.metadata.content_type,
          'Content-Length': retained.data.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(retained.data);
        return;
      }
      let body: unknown;
      if (request.headers['content-type']?.startsWith('multipart/form-data')) {
        if (this.#commands?.profile !== 'command-registry-v2') throw invalidMessagePayload();
        const parsed = parseMultipartBody(
          request.headers['content-type'],
          await readRawBody(request, 8 * 1_048_576),
        );
        upload = this.#attachments.prepare(parsed.files);
        body = this.#resolveAttachments(parsed.payload, upload, routePath);
      } else {
        body = await readJsonBody(request, this.#maxBodyBytes);
        if (isRecord(body)) {
          upload = this.#attachments.prepare([]);
          body = this.#resolveAttachments(body, upload, routePath);
        }
      }
      this.#route(method, routePath, url, body, response, rateLimit);
      upload?.commit();
      if (span !== undefined)
        finishSpan('ok', {
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
      upload?.rollback();
      if (isCommandRegistryTarget(request.url ?? '/')) {
        if (!response.headersSent) response.setHeader('Connection', 'close');
        request.resume();
      }
      const apiError = normalizeError(error);
      sendJson(response, apiError.status, apiError.toJSON());
      if (span !== undefined)
        finishSpan('error', { status: apiError.status, error: apiError.message });
    } finally {
      finishSpan(
        response.destroyed
          ? 'error'
          : response.statusCode >= 500
            ? 'error'
            : response.statusCode >= 400
              ? 'warning'
              : 'ok',
        { status: response.statusCode },
      );
    }
  }

  async #applyFault(method: string, route: string, response: ServerResponse): Promise<boolean> {
    const effect = await this.#faultPolicy.applyHttp({ method, route });
    if (!effect || effect.kind === 'delay') return false;
    if (effect.kind === 'timeout') {
      response.destroy();
      return true;
    }
    if (effect.kind !== 'http-status') return false;
    sendJson(
      response,
      effect.status,
      {
        message: 'Injected local HTTP fault.',
        retry_after: effect.retryAfterMs / 1000,
        global: false,
      },
      effect.status === 429
        ? {
            'Retry-After': String(effect.retryAfterMs / 1000),
            'X-RateLimit-Reset-After': String(effect.retryAfterMs / 1000),
            'X-RateLimit-Scope': 'shared',
          }
        : {},
    );
    return true;
  }
  #resolveAttachments(
    payload: Record<string, unknown>,
    upload: PreparedAttachments,
    route: string,
  ): Record<string, unknown> {
    const callback = route.startsWith('/interactions/');
    const target = callback ? payload['data'] : payload;
    if (!isRecord(target)) {
      if (upload.attachments.length) throw invalidMessagePayload();
      return payload;
    }
    const declared = target['attachments'];
    if (declared === undefined && upload.attachments.length === 0) return payload;
    if (declared !== undefined && !Array.isArray(declared)) throw invalidMessagePayload();
    let owner: Readonly<Record<string, unknown>> | undefined;
    const channelItem = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route);
    if (channelItem) {
      const message = this.#state.get('message', channelItem[2]!);
      if (message?.['channel_id'] === channelItem[1]) owner = message;
    }
    const webhookItem = /^\/webhooks\/\d+\/([^/]+)\/messages\/(@original|\d+)$/.exec(route);
    if (webhookItem) {
      const interaction = this.#interactions.getByToken(decodeRouteToken(webhookItem[1]!));
      if (interaction)
        owner =
          webhookItem[2] === '@original'
            ? this.#interactions.getOriginalMessage(interaction.id)
            : this.#interactions.getFollowupMessage(interaction.id, webhookItem[2]!);
    }
    const descriptors = declared ?? upload.attachments;
    const attachments = (descriptors as unknown[]).map((value) => {
      if (!isRecord(value) || (typeof value['id'] !== 'string' && typeof value['id'] !== 'number'))
        throw invalidMessagePayload();
      if (typeof value['id'] === 'number' && !Number.isSafeInteger(value['id']))
        throw invalidMessagePayload();
      const id = String(value['id']);
      if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(id)) throw invalidMessagePayload();
      const prepared = upload.byUploadId[id] ?? upload.attachments.find((a) => a.id === id);
      if (prepared)
        return {
          ...prepared,
          ...(typeof value['description'] === 'string'
            ? { description: value['description'] }
            : {}),
        };
      const old = this.#attachments.get(id);
      if (!old || !owner || !records(owner['attachments']).some((file) => file['id'] === id))
        throw invalidMessagePayload();
      return {
        ...old.metadata,
        ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
      };
    });
    if (
      attachments.length > 10 ||
      new Set(attachments.map((a) => a.id)).size !== attachments.length
    )
      throw invalidMessagePayload();
    const replacement = { ...target, attachments };
    return callback ? { ...payload, data: replacement } : replacement;
  }

  async #commandRoute(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const route = parseCommandRoute(request.url ?? '/');
    if (this.#commands === undefined)
      throw new DiscordApiError(501, 0, 'Command registry profile is not enabled.');
    if (
      route.unsupported ||
      !(route.id === undefined ? ['GET', 'POST', 'PUT'] : ['GET', 'PATCH', 'DELETE']).includes(
        method,
      )
    )
      throw new DiscordApiError(501, 0, 'Unsupported application command route.');
    this.#commands.verifyScope(route.app, route.guild);
    if (await this.#applyFault(method, route.collection, response)) return;
    if (route.id === undefined) this.#commands.list(route.app, route.guild);
    else this.#commands.get(route.app, route.guild, route.id);
    const rate = this.#rateLimits.acquire({
      method,
      path: route.collection,
      identity: 'authenticated-bot',
    });
    if (!rate.allowed) {
      sendJson(response, 429, rate.body, rate.headers);
      return;
    }
    const url = new URL(request.url!, 'http://127.0.0.1');
    const query = [...url.searchParams];
    if (request.url!.includes('?')) {
      if (
        method !== 'GET' ||
        route.id !== undefined ||
        query.length !== 1 ||
        query[0]![0] !== 'with_localizations'
      )
        throw commandError('payload');
      if ((request.url!.split('?')[1] ?? '') !== 'with_localizations=' + query[0]![1])
        throw commandError('payload');
      if (query[0]![1] === 'true' && this.#commands.profile !== 'command-registry-v2')
        throw commandError('feature');
      if (!['true', 'false'].includes(query[0]![1])) throw commandError('payload');
    }
    const body =
      method === 'GET' || method === 'DELETE'
        ? await requireNoCommandBody(request, this.#maxBodyBytes)
        : await readJsonBody(request, this.#maxBodyBytes);
    let result: unknown;
    let status = 200;
    if (method === 'GET')
      result =
        route.id === undefined
          ? this.#commands.list(route.app, route.guild)
          : this.#commands.get(route.app, route.guild, route.id);
    else if (method === 'POST') {
      const saved = this.#commands.post(route.app, route.guild, body);
      result = saved.command;
      status = saved.created ? 201 : 200;
    } else if (method === 'PUT') result = this.#commands.put(route.app, route.guild, body);
    else if (method === 'PATCH')
      result = this.#commands.patch(route.app, route.guild, route.id!, body);
    else {
      this.#commands.delete(route.app, route.guild, route.id!);
      status = 204;
    }
    const headers = { ...rate.headers, 'X-DisRunner-State-Revision': String(this.#state.revision) };
    if (status === 204) sendEmpty(response, status, headers);
    else sendJson(response, status, result, headers);
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

    if (this.#commands?.profile === 'command-registry-v2') {
      const roles = /^\/guilds\/(\d+)\/roles(?:\/(\d+))?$/.exec(path);
      const members = /^\/guilds\/(\d+)\/members(?:\/(\d+|@me))?$/.exec(path);
      if (roles || members) {
        const match = roles ?? members!;
        const kind = roles ? 'role' : 'member';
        const guildId = match[1]!;
        const id = match[2] === '@me' ? this.#bootstrap!.user.id : match[2];
        if (method === 'GET') {
          sendJson(
            response,
            200,
            id ? this.#resources.get(kind, id, guildId) : this.#resources.list(kind, guildId),
            rateLimit.headers,
          );
          return;
        }
        if (method === 'POST' && kind === 'role' && !id) {
          const saved = this.#resources.execute({
            kind,
            operation: 'create',
            guildId,
            data: requireObjectBody(body),
          })!;
          sendJson(response, 200, this.#resources.get(kind, saved.id, guildId), rateLimit.headers);
          return;
        }
        if (method === 'PATCH' && id) {
          this.#resources.execute({
            kind,
            operation: 'update',
            guildId,
            resourceId: id,
            data: requireObjectBody(body),
          });
          sendJson(response, 200, this.#resources.get(kind, id, guildId), rateLimit.headers);
          return;
        }
        if (method === 'DELETE' && kind === 'role' && id) {
          this.#resources.execute({ kind, operation: 'delete', guildId, resourceId: id });
          sendEmpty(response, 204, rateLimit.headers);
          return;
        }
        throw new DiscordApiError(501, 0, 'Unsupported fixture resource operation.');
      }
    }

    const channelMatch = /^\/channels\/(\d+)$/.exec(path);
    if (channelMatch !== null) {
      const channelId = channelMatch[1] as string;
      if (this.#commands?.profile === 'command-registry-v2') {
        const channel = this.#state.require('channel', channelId);
        if (method === 'GET') {
          sendJson(response, 200, this.#resources.get('channel', channelId), rateLimit.headers);
          return;
        }
        if (typeof channel['guild_id'] !== 'string')
          throw new DiscordApiError(501, 0, 'Direct message channel mutations are unsupported.');
        if (method === 'PATCH') {
          this.#resources.execute({
            kind: 'channel',
            operation: 'update',
            guildId: channel['guild_id'],
            resourceId: channelId,
            data: requireObjectBody(body),
          });
          sendJson(response, 200, this.#resources.get('channel', channelId), rateLimit.headers);
          return;
        }
        if (method === 'DELETE') {
          this.#resources.execute({
            kind: 'channel',
            operation: 'delete',
            guildId: channel['guild_id'],
            resourceId: channelId,
          });
          sendEmpty(response, 204, rateLimit.headers);
          return;
        }
      }
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
      if (this.#commands?.profile === 'command-registry-v2') {
        sendJson(response, 200, this.#resources.get('guild', guildMatch[1]!), rateLimit.headers);
        return;
      }
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
      if (this.#commands?.profile === 'command-registry-v2') {
        if (method === 'GET') {
          sendJson(response, 200, this.#resources.list('channel', guildId), rateLimit.headers);
          return;
        }
        if (method === 'POST') {
          const saved = this.#resources.execute({
            kind: 'channel',
            operation: 'create',
            guildId,
            data: requireObjectBody(body),
          })!;
          sendJson(response, 201, this.#resources.get('channel', saved.id), rateLimit.headers);
          return;
        }
      }
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
        if (interaction.messageProfile !== 'interactions-v1') requireNoMessageQuery(url);
        else if (
          [...url.searchParams].some(
            ([key, value]) =>
              !['wait', 'with_components'].includes(key) ||
              !['true', 'false', '1', '0'].includes(value),
          ) ||
          new Set([...url.searchParams.keys()]).size !== [...url.searchParams].length
        )
          throw invalidMessagePayload();
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
    const withResponse = parseWithResponse(url, interaction.messageProfile === 'interactions-v1');
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
          type:
            interaction.type === 'component'
              ? 3
              : interaction.type === 'autocomplete'
                ? 4
                : interaction.type === 'modal-submit'
                  ? 5
                  : 2,
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
  return (
    interaction.messageProfile === 'chat-input-messages-v1' ||
    interaction.messageProfile === 'interactions-v1'
  );
}

const AUTHORITATIVE_CALLBACK_TYPES: Readonly<Record<number, InteractionResponseType>> = {
  4: 'message',
  5: 'defer',
  6: 'defer-update',
  7: 'update',
  8: 'autocomplete',
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
function parseWithResponse(url: URL, sdk = false): boolean {
  const entries = [...url.searchParams.entries()];
  if (url.search === '' || url.search === '?') return false;
  if (entries.length !== 1 || entries[0]?.[0] !== 'with_response') throw invalidMessagePayload();
  const value = entries[0][1];
  if (value === 'true' || (sdk && value === '1')) return true;
  if (value === 'false' || (sdk && value === '0')) return false;
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
    'Content-Type': 'application/json',
    ...(status === 429 ? { Via: '1.1 disrunner' } : {}),
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

// The raw family gate runs before URL normalization, including dot-segment aliases.
function isCommandRegistryTarget(raw: string): boolean {
  const path = raw.split('?')[0] ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
  const segments = decoded.replaceAll('\\', '/').split('/');
  const application = segments.indexOf('applications');
  return application >= 0 && segments.slice(application + 1).includes('commands');
}
function parseCommandRoute(raw: string): {
  app: string;
  guild: string | undefined;
  id: string | undefined;
  collection: string;
  unsupported: boolean;
} {
  const rawPath = raw.split('?')[0]!;
  if (
    !rawPath.startsWith('/') ||
    rawPath.includes('%') ||
    rawPath.includes('\\') ||
    raw.includes('#') ||
    rawPath.split('/').some((p) => p === '.' || p === '..')
  )
    throw commandError('route');
  const path = stripApiVersion(rawPath);
  const match = /^\/applications\/([^/]+)(?:\/guilds\/([^/]+))?\/commands((?:\/[^/]+)*)$/.exec(
    path,
  );
  if (
    !match ||
    !canonicalCommandId(match[1]) ||
    (match[2] !== undefined && !canonicalCommandId(match[2]))
  )
    throw commandError('route');
  const suffix = match[3]!.split('/').filter(Boolean);
  let id: string | undefined;
  if (suffix[0] !== undefined && suffix[0] !== 'permissions') {
    if (!canonicalCommandId(suffix[0])) throw commandError('route');
    id = suffix[0];
  }
  return {
    app: match[1],
    guild: match[2],
    id,
    collection:
      '/applications/' +
      match[1] +
      (match[2] === undefined ? '' : '/guilds/' + match[2]) +
      '/commands',
    unsupported: suffix.length > (id === undefined ? 0 : 1),
  };
}
async function requireNoCommandBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<undefined> {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > maxBytes) {
    request.resume();
    throw new DiscordApiError(413, 40005, 'Request entity too large.');
  }
  if (length > 0) {
    request.resume();
    throw commandError('payload');
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer): void => {
      if (chunk.length) {
        cleanup();
        request.resume();
        reject(commandError('payload'));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(undefined);
    };
    const onError = (): void => {
      cleanup();
      reject(commandError('payload'));
    };
    const onAborted = (): void => {
      cleanup();
      reject(commandError('payload'));
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string')
      throw new DiscordApiError(400, 50035, 'Invalid request body bytes.');
    const value: Buffer = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new DiscordApiError(413, 40005, 'Request body is too large.');
    buffers.push(value);
  }
  return Buffer.concat(buffers, size);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
}
