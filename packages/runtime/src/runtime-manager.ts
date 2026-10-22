import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { createWebhookPeerSecret } from './interaction-peer-auth.js';
import {
  INTERACTION_TIMEOUT_MS,
  sendSignedInteraction,
  WebhookPeerAuthenticationError,
} from './interaction-transport.js';
import { loadProjectConfiguration, type ResolvedProjectConfiguration } from './project-config.js';
import {
  emptyRuntimeState,
  SessionError,
  type SessionIssue,
  type InvocationContext,
  type DesktopRuntimeState,
  type RuntimeEndpoints,
  type RuntimeInvocationResult,
  type RuntimeOutputEntry,
  type RuntimeRiskEntry,
  type RuntimeTraceEntry,
  type RuntimeCoreSnapshot,
  type RuntimeResourceView,
} from './contracts.js';
import {
  freezeResourceDependencies,
  type BotRunnerLike,
  type GatewayServerLike,
  type RestServerLike,
  type RuntimeResourceDependencies,
} from './resource-lifecycle.js';

const CORE_SPECIFIER: string = '@disrunner/core';
const MAX_RENDERER_OUTPUT = 200;
const MAX_RENDERER_OUTPUT_BYTES = 1_048_576;
const MAX_RENDERER_OUTPUT_ENTRY_BYTES = 32_768;
const MAX_RENDERER_TRACES = 100;
const MAX_RENDERER_RISKS = 100;
const MAX_INTERACTION_INPUT_BYTES = 2_000;
const CLEANUP_PENDING_SELECT =
  'Previous run cleanup is not confirmed. Stop again to retry cleanup before selecting a project.';

interface TraceCollectorLike {
  start(kind: string, name: string, metadata?: Readonly<Record<string, unknown>>): unknown;
  end(handle: unknown, status?: string, metadata?: Readonly<Record<string, unknown>>): unknown;
  spans(limit?: number): readonly unknown[];
}

interface RiskCollectorLike {
  add(finding: unknown): unknown;
  all(limit?: number): readonly unknown[];
}

interface SnowflakeGeneratorLike {
  generate(): string;
}

interface InteractionEngineLike {
  create(input?: Readonly<Record<string, unknown>>): unknown;
  get(id: string): unknown;
  respond(id: string, responseType: string, data?: Readonly<Record<string, unknown>>): unknown;
}

interface CoreApi {
  readonly VirtualClock: new (options?: Readonly<Record<string, unknown>>) => unknown;
  readonly SeededRandom: new (seed: number) => unknown;
  readonly SnowflakeGenerator: new (
    clock: unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => SnowflakeGeneratorLike;
  readonly VirtualState: new (
    clock: unknown,
    snowflakes: unknown,
    resources?: readonly Readonly<Record<string, unknown>>[],
  ) => unknown;
  readonly TraceCollector: new (options: Readonly<Record<string, unknown>>) => TraceCollectorLike;
  readonly RiskCollector: new (clock: unknown) => RiskCollectorLike;
  readonly InteractionEngine: new (
    options: Readonly<Record<string, unknown>>,
  ) => InteractionEngineLike;
  readonly GatewayEmulator: new (options: Readonly<Record<string, unknown>>) => unknown;
  readonly RateLimitEngine: new (
    clock: unknown,
    rules?: readonly Readonly<Record<string, unknown>>[],
  ) => unknown;
  readonly LocalRestEmulator: new (options: Readonly<Record<string, unknown>>) => RestServerLike;
  readonly BotRunner: new (options?: Readonly<Record<string, unknown>>) => BotRunnerLike;
  readonly LocalGatewayServer?: new (
    options: Readonly<Record<string, unknown>>,
  ) => GatewayServerLike;
  readonly createSimulationProfile: (options?: Readonly<Record<string, unknown>>) => unknown;
  readonly createOfflineSessionToken: () => string;
  readonly sanitizeForExport: (
    value: unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => unknown;
}

type StateListener = (state: DesktopRuntimeState) => void;
type EndpointListener = (endpoints: RuntimeEndpoints | null) => void;

export class DesktopRuntimeManager {
  readonly #onState: StateListener;
  readonly #onEndpoints: EndpointListener;
  readonly #dependencies: Required<RuntimeResourceDependencies>;
  #state: DesktopRuntimeState = emptyRuntimeState();
  #configuration: ResolvedProjectConfiguration | null = null;
  #runAbort: AbortController | null = null;
  #failure: SessionError | null = null;
  #cleanupIssues: SessionIssue[] = [];
  #unexpectedExit = false;
  #expectedStop = false;
  #generation = 0;
  #coreOwner: RetainedCoreState | null = null;

  public get failure(): SessionError | null {
    return this.#failure;
  }
  public get shutdownIssues(): readonly SessionIssue[] {
    return structuredClone([
      ...(this.#unexpectedExit
        ? [{ code: 'child-exited' as const, message: 'Bot process exited unexpectedly.' }]
        : []),
      ...this.#cleanupIssues,
    ]);
  }
  public get hasResources(): boolean {
    return (
      this.#bot !== null ||
      this.#rest !== null ||
      this.#gatewayServer !== null ||
      this.#coreOwner !== null
    );
  }
  public contexts(): InvocationContext[] {
    return this.#coreOwner !== null
      ? this.#coreOwner.contexts()
      : contextsFromResources(this.#configuration?.resources ?? []);
  }

  public validateContext(context: InvocationContext): InvocationContext {
    if (
      context === null ||
      typeof context !== 'object' ||
      ![context.actorId, context.guildId, context.channelId].every(
        (id) =>
          typeof id === 'string' &&
          id.length > 0 &&
          Buffer.byteLength(id) <= 128 &&
          !id.includes('\0'),
      ) ||
      !this.contexts().some(
        (candidate) =>
          candidate.actorId === context.actorId &&
          candidate.guildId === context.guildId &&
          candidate.channelId === context.channelId,
      )
    ) {
      throw new SessionError(
        'invalid',
        'Invocation context must identify an existing user, guild and supported guild text channel.',
      );
    }
    return { actorId: context.actorId, guildId: context.guildId, channelId: context.channelId };
  }
  public assertLive(): void {
    const bot = this.#bot?.snapshot();
    if (
      bot !== undefined &&
      !this.#expectedStop &&
      !this.#unexpectedExit &&
      (bot.startedAtMs !== undefined || bot.exitedAtMs !== undefined)
    ) {
      if (['stopped', 'crashed'].includes(bot.status)) this.#unexpectedExit = true;
      else if (process.platform === 'linux') {
        const observed = this.#bot?.observeExit?.();
        if (observed === 'exited') this.#unexpectedExit = true;
        else if (observed === 'unknown')
          throw new SessionError('transport', 'Bot process liveness is uncertain.');
      }
    }
    if (this.#unexpectedExit)
      throw new SessionError('child-exited', 'Bot process exited unexpectedly.');
  }
  #bot: BotRunnerLike | null = null;
  #rest: RestServerLike | null = null;
  #gatewayServer: GatewayServerLike | null = null;
  #trace: TraceCollectorLike | null = null;
  #risks: RiskCollectorLike | null = null;
  #interactionPrivateKey: KeyObject | null = null;
  #interactionPeerSecret: string | null = null;
  #interactionEndpoint: string | null = null;
  #applicationId: string | null = null;
  #interactionContext: { readonly guildId?: string; readonly channelId?: string } | null = null;
  #interactions: InteractionEngineLike | null = null;
  #sanitizeForExport: ((value: unknown) => unknown) | null = null;
  #poller: NodeJS.Timeout | null = null;
  #handlingChildExit = false;
  #startPromise: Promise<DesktopRuntimeState> | null = null;
  #stopPromise: Promise<DesktopRuntimeState> | null = null;
  #cleanupPromise: Promise<void> | null = null;

  public constructor(
    onState: StateListener,
    onEndpoints: EndpointListener,
    dependencies: RuntimeResourceDependencies = {},
  ) {
    this.#onState = onState;
    this.#onEndpoints = onEndpoints;
    this.#dependencies = freezeResourceDependencies(dependencies);
  }

  public coreState(): RuntimeCoreSnapshot | null {
    return this.#coreOwner?.snapshot() ?? null;
  }

  public snapshot(): DesktopRuntimeState {
    return structuredClone(this.#state);
  }

  public async selectProject(directory: string): Promise<DesktopRuntimeState> {
    if (['starting', 'running', 'stopping'].includes(this.#state.phase)) {
      return this.#setError('Stop the active bot before selecting another project.');
    }
    // Retained resources still belong to the current configuration. Reject before reading or
    // replacing it, and leave ownership, state and recorded failures untouched.
    if (this.hasResources) throw new SessionError('invalid', CLEANUP_PENDING_SELECT);
    try {
      const project = await loadProjectConfiguration(directory);
      this.#configuration = structuredClone(project);
      this.#failure = null;
      this.#publish({
        ...emptyRuntimeState(),
        phase: 'ready',
        project: project.summary,
      });
    } catch (error) {
      this.#configuration = null;
      this.#failure = new SessionError('invalid', 'Project configuration could not be validated.');
      this.#publish({
        ...emptyRuntimeState(),
        phase: 'error',
        error: errorMessage(error),
      });
    }
    return this.snapshot();
  }

  public async start(
    options: { signal?: AbortSignal; timeoutMs?: number; runId?: string } = {},
  ): Promise<DesktopRuntimeState> {
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#stopPromise !== null) await this.#stopPromise;
    this.#runAbort = new AbortController();
    const operation = Promise.resolve().then(() => this.#startInternal(options));
    this.#startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#startPromise === operation) this.#startPromise = null;
    }
  }

  async #startInternal(options: {
    runId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<DesktopRuntimeState> {
    if (this.#state.phase === 'running' || this.#state.phase === 'starting') return this.snapshot();
    if (this.#state.phase === 'stopping')
      return this.#setError('The current bot is still stopping.');
    if (this.#configuration === null)
      return this.#setError('Select a valid bot project before starting.');

    if (this.hasResources)
      return this.#setError('Outstanding cleanup must succeed before restart.');
    this.#runAbort ??= new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new SessionError('timeout', 'Startup deadline exceeded.')),
      options.timeoutMs ?? 10_000,
    );
    const signal = AbortSignal.any([
      this.#runAbort.signal,
      deadline.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const generation = ++this.#generation;
    this.#expectedStop = false;
    this.#unexpectedExit = false;
    this.#failure = null;
    this.#cleanupIssues = [];
    this.#publish({
      ...this.#state,
      phase: 'starting',
      error: null,
      output: [],
      traces: [],
      risks: [],
    });
    let configuration: ResolvedProjectConfiguration | null = null;
    try {
      signal.throwIfAborted();
      configuration = this.#configuration;
      this.#publish({ ...this.#state, project: configuration.summary });
      const core = await loadCore();
      signal.throwIfAborted();
      const GatewayServer = core.LocalGatewayServer;
      if (GatewayServer === undefined) {
        throw new Error(
          '@disrunner/core does not export LocalGatewayServer. Desktop startup is fail-closed until the core gateway transport is available.',
        );
      }
      const sessionToken = core.createOfflineSessionToken();
      const interactionCredentials =
        configuration.adapter.type === 'raw-interaction-webhook'
          ? createInteractionCredentials()
          : null;
      if (interactionCredentials === null) {
        throw new Error(
          'Shared runtime bootstrap requires raw-interaction-webhook signing credentials.',
        );
      }
      const interactionPeerSecret =
        interactionCredentials === null ? null : createWebhookPeerSecret();
      this.#sanitizeForExport = (value: unknown) =>
        core.sanitizeForExport(value, {
          sensitiveValues: [
            sessionToken,
            ...(interactionPeerSecret === null ? [] : [interactionPeerSecret]),
          ],
        });
      this.#interactionPrivateKey = interactionCredentials?.privateKey ?? null;
      this.#interactionPeerSecret = interactionPeerSecret;

      const profile = core.createSimulationProfile({
        seed: configuration.profile.seed,
        mode: configuration.profile.mode,
        networkPolicy: 'offline',
      });
      const clock = new core.VirtualClock({ nowMs: Date.now(), mode: 'realtime' });
      const random = new core.SeededRandom(configuration.profile.seed);
      const snowflakes = new core.SnowflakeGenerator(clock, {
        workerId: configuration.profile.seed & 31,
        processId: (configuration.profile.seed >>> 5) & 31,
      });
      const applicationId = snowflakes.generate();
      const botUserId = snowflakes.generate();
      const ownerId = snowflakes.generate();
      const trace = new core.TraceCollector({ clock, random });
      const risks = new core.RiskCollector(clock);
      const state = new core.VirtualState(clock, snowflakes, configuration.resources);
      const runId = options.runId ?? randomUUID();
      const owner = new RetainedCoreState(runId, state, clock, this.#sanitizeForExport);
      this.#coreOwner = owner;
      owner.subscribe(() => {
        if (generation !== this.#generation || this.#expectedStop || this.#coreOwner !== owner)
          return;
        this.#publish(this.#state);
      });
      const interactions = new core.InteractionEngine({
        applicationId,
        clock,
        random,
        snowflakes,
        profile,
        onRisk: (finding: unknown) => risks.add(finding),
      });
      this.#interactions = interactions;
      this.#applicationId = applicationId;
      this.#interactionContext = deriveInteractionContext(configuration.resources);
      const gatewayPort = await reserveLoopbackPort();
      signal.throwIfAborted();
      const expectedGatewayUrl = `ws://127.0.0.1:${gatewayPort}/gateway`;
      const gateway = new core.GatewayEmulator({
        clock,
        random,
        snowflakes,
        fakeToken: sessionToken,
        resumeGatewayUrl: expectedGatewayUrl,
        applicationId,
        botUserId,
      });
      // Own the real resource before wrapping it: if wrapping throws, cleanup still reaches it.
      this.#gatewayServer = new GatewayServer({ gateway, trace });
      const gatewayServer = this.#dependencies.wrapGateway(this.#gatewayServer);
      this.#gatewayServer = gatewayServer;
      const gatewayStartResult = await gatewayServer.start(gatewayPort);
      signal.throwIfAborted();
      const gatewayUrl = requireGatewayUrl(gatewayStartResult ?? gatewayServer.address);
      if (gatewayUrl !== expectedGatewayUrl) {
        throw new Error('LocalGatewayServer address does not match the Gateway READY resume URL.');
      }

      const rateLimits = new core.RateLimitEngine(clock, [
        {
          id: 'desktop-message-create',
          method: 'POST',
          route: '/channels/:channelId/messages',
          limit: 5,
          windowMs: 5_000,
          scope: 'shared',
        },
      ]);
      const rest = new core.LocalRestEmulator({
        state,
        messageDomain: { runId, clockDomain: 'realtime' },
        interactions,
        gateway,
        rateLimits,
        fakeToken: sessionToken,
        gatewayUrl,
        bootstrap: {
          user: {
            id: botUserId,
            username: 'DisRunner Bot',
            discriminator: '0',
            avatar: null,
            bot: true,
          },
          application: {
            id: applicationId,
            name: 'DisRunner Test Application',
            description: 'Synthetic application profile for local tests.',
            icon: null,
            bot_public: false,
            bot_require_code_grant: false,
            owner: {
              id: ownerId,
              username: 'test-owner',
              discriminator: '0',
              avatar: null,
              bot: false,
            },
            // Reuse the same ephemeral signing identity injected into this run's bot.
            verify_key: interactionCredentials.publicKeyHex,
            flags: 0,
            team: null,
          },
        },
        mode: configuration.profile.mode,
        trace,
      });
      this.#rest = rest;
      this.#rest = this.#dependencies.wrapRest(rest);
      const restAddress = requireRestAddress(await this.#rest.start(0));
      signal.throwIfAborted();
      const interactionEndpoint = await resolveInteractionEndpoint(
        configuration.adapter.interactionEndpoint,
      );
      signal.throwIfAborted();
      this.#interactionEndpoint = interactionEndpoint ?? null;
      const endpoints: RuntimeEndpoints = {
        restBaseUrl: restAddress.apiBaseUrl,
        gatewayUrl,
        ...(interactionEndpoint === undefined ? {} : { interactionEndpoint }),
      };
      this.#notifyEndpoints(endpoints);
      signal.throwIfAborted();

      const output: RuntimeOutputEntry[] = [];
      let outputBytes = 0;
      const bot = new core.BotRunner({
        maxOutputEntries: MAX_RENDERER_OUTPUT,
        maxOutputBytes: MAX_RENDERER_OUTPUT_BYTES,
        maxOutputLineBytes: 65_536,
        onOutput: (entry: unknown) => {
          if (generation !== this.#generation || this.#expectedStop) return;
          const sanitized = sanitizeOutput(entry);
          if (sanitized === null) return;
          outputBytes += Buffer.byteLength(sanitized.text);
          output.push(sanitized);
          while (
            output.length > 0 &&
            (output.length > MAX_RENDERER_OUTPUT || outputBytes > MAX_RENDERER_OUTPUT_BYTES)
          ) {
            const removed = output.shift();
            if (removed !== undefined) outputBytes -= Buffer.byteLength(removed.text);
          }
          this.#publish({ ...this.#state, output: [...output] });
        },
      });
      this.#bot = bot;
      const ownedBot = this.#dependencies.wrapBot(bot);
      this.#bot = ownedBot;
      const activeGatewayPort = new URL(gatewayUrl).port;
      const restPort = new URL(restAddress.baseUrl).port;
      const interactionPort =
        interactionEndpoint === undefined ? '' : new URL(interactionEndpoint).port;
      const processSnapshot = await ownedBot.start({
        executable: configuration.summary.executable,
        args: configuration.summary.args,
        cwd: configuration.summary.cwd,
        workspaceRoot: configuration.summary.root,
        env: {
          ...configuration.environment,
          DISRUNNER_REST_PORT: restPort,
          DISRUNNER_GATEWAY_PORT: activeGatewayPort,
          ...(interactionPort === '' ? {} : { DISRUNNER_BOT_PORT: interactionPort }),
          ...(interactionCredentials === null
            ? {}
            : { DISRUNNER_PUBLIC_KEY: interactionCredentials.publicKeyHex }),
        },
        restBaseUrl: restAddress.apiBaseUrl,
        gatewayUrl,
        ...(interactionEndpoint === undefined ? {} : { interactionEndpoint }),
        ...(interactionPeerSecret === null ? {} : { interactionPeerSecret }),
        fakeToken: sessionToken,
      });
      signal.throwIfAborted();
      if (
        interactionEndpoint !== undefined &&
        interactionCredentials !== null &&
        interactionPeerSecret !== null
      ) {
        await waitForSignedPing(
          interactionEndpoint,
          interactionCredentials.privateKey,
          interactionPeerSecret,
          signal,
          () => this.assertLive(),
        );
      }
      signal.throwIfAborted();
      this.assertLive();
      this.#trace = trace;
      this.#risks = risks;
      this.#publish({
        ...this.#state,
        phase: 'running',
        error: null,
        pid: processSnapshot.pid ?? null,
        endpoints,
        output: [...output],
      });
      signal.throwIfAborted();
      this.#startPolling();
    } catch (error) {
      this.#failure = operationFailure(error, signal, 'start-failed');
      const rawFailure = this.#failure.message;
      const sanitizedFailure = this.#sanitizeForExport?.({ message: rawFailure });
      const primaryFailure =
        isRecord(sanitizedFailure) && typeof sanitizedFailure['message'] === 'string'
          ? sanitizedFailure['message']
          : rawFailure;
      let cleanupFailure: string | null = null;
      try {
        await this.#cleanup();
      } catch (cleanupError) {
        cleanupFailure = errorMessage(cleanupError);
      }
      this.#publish({
        ...this.#state,
        phase: 'error',
        project: configuration?.summary ?? this.#state.project,
        error:
          cleanupFailure === null
            ? primaryFailure
            : `${primaryFailure} Cleanup also failed: ${cleanupFailure}`,
        pid: null,
        endpoints: null,
      });
    }
    clearTimeout(timer);
    return this.snapshot();
  }

  public async stop(): Promise<DesktopRuntimeState> {
    try {
      this.assertLive();
    } catch {
      /* Retain unexpected exit before shutdown intent. */
    }
    this.#expectedStop = true;
    this.#runAbort?.abort(
      new SessionError('cancelled', 'Runtime operation cancelled by shutdown.'),
    );
    if (this.#startPromise !== null) await this.#startPromise;
    if (this.#stopPromise !== null) return this.#stopPromise;
    const operation = Promise.resolve().then(() => this.#stopInternal());
    this.#stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#stopPromise === operation) this.#stopPromise = null;
    }
  }

  async #stopInternal(): Promise<DesktopRuntimeState> {
    if (this.#state.phase === 'stopping') return this.snapshot();
    const active = this.hasResources;
    if (!active) {
      this.#publish({
        ...this.#state,
        phase: this.#state.project === null ? 'idle' : 'ready',
        error: null,
        pid: null,
        endpoints: null,
      });
      return this.snapshot();
    }
    this.#publish({ ...this.#state, phase: 'stopping', error: null });
    try {
      await this.#cleanup();
      this.#publish({
        ...this.#state,
        phase: this.#state.project === null ? 'idle' : 'ready',
        error: null,
        pid: null,
        endpoints: null,
      });
    } catch (error) {
      this.#publish({
        ...this.#state,
        phase: 'error',
        error: `Runtime shutdown failed: ${errorMessage(error)}`,
        pid: null,
        endpoints: null,
      });
    }
    return this.snapshot();
  }

  public async invoke(
    input: string,
    context?: InvocationContext,
    options: { signal?: AbortSignal; timeoutMs?: number; requireExactResponse?: boolean } = {},
  ): Promise<RuntimeInvocationResult> {
    const signal = AbortSignal.any([
      ...(this.#runAbort ? [this.#runAbort.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    const startedAtMs = Date.now();
    this.#failure = null;
    if (
      typeof input !== 'string' ||
      input.length > MAX_INTERACTION_INPUT_BYTES ||
      Buffer.byteLength(input) > MAX_INTERACTION_INPUT_BYTES
    ) {
      return this.#invocationResult({
        ok: false,
        command: '',
        interactionId: null,
        durationMs: Date.now() - startedAtMs,
        response: null,
        error: 'Command input cannot exceed 2,000 UTF-8 bytes.',
      });
    }
    const normalized = input.trim();
    const commandToken = normalized.split(/\s+/u)[0] ?? '';
    const commandName = commandToken.startsWith('/') ? commandToken.slice(1) : commandToken;
    if (normalized === '' || !/^[a-z0-9_-]{1,32}$/u.test(commandName)) {
      return this.#invocationResult({
        ok: false,
        command: commandName,
        interactionId: null,
        durationMs: Date.now() - startedAtMs,
        response: null,
        error:
          'Command must be /name with 1–32 lowercase letters, digits, underscores, or hyphens.',
      });
    }
    if (
      this.#state.phase !== 'running' ||
      this.#interactionEndpoint === null ||
      this.#interactionPrivateKey === null ||
      this.#interactionPeerSecret === null ||
      this.#applicationId === null ||
      this.#interactionContext === null ||
      this.#interactions === null ||
      this.#trace === null
    ) {
      return this.#invocationResult({
        ok: false,
        command: commandName,
        interactionId: null,
        durationMs: Date.now() - startedAtMs,
        response: null,
        error: 'A running raw-interaction-webhook project is required.',
      });
    }

    let interactionId: string | null = null;
    let span: unknown;
    try {
      signal.throwIfAborted();
      this.assertLive();
      const selectedContext = context === undefined ? undefined : this.validateContext(context);
      const actor =
        selectedContext === undefined ? undefined : this.#coreOwner?.actor(selectedContext.actorId);
      if (selectedContext !== undefined && actor === undefined)
        throw new SessionError(
          'invalid',
          'Invocation actor is unavailable in the current live state.',
        );
      const actorUser = Object.fromEntries(
        Object.entries(actor ?? {}).filter(([key]) => key !== 'resourceType'),
      );
      const argumentText = normalized.slice(commandToken.length).trim();
      const created = this.#interactions.create({
        ...(selectedContext === undefined ? {} : { context: selectedContext }),
        type: 'command',
        data: {
          name: commandName,
          type: 1,
          ...(argumentText === ''
            ? {}
            : { options: [{ name: 'text', type: 3, value: argumentText }] }),
        },
      });
      if (
        !isRecord(created) ||
        typeof created['id'] !== 'string' ||
        typeof created['token'] !== 'string'
      ) {
        throw new Error('InteractionEngine.create() returned an invalid interaction.');
      }
      interactionId = created['id'];
      const payload = {
        id: interactionId,
        application_id: this.#applicationId,
        type: 2,
        token: created['token'],
        version: 1,
        ...(selectedContext === undefined
          ? {}
          : {
              guild_id: selectedContext.guildId,
              channel_id: selectedContext.channelId,
              member: { user: actorUser },
            }),
        ...(selectedContext !== undefined || this.#interactionContext.guildId === undefined
          ? {}
          : { guild_id: this.#interactionContext.guildId }),
        ...(selectedContext !== undefined || this.#interactionContext.channelId === undefined
          ? {}
          : { channel_id: this.#interactionContext.channelId }),
        data: {
          name: commandName,
          type: 1,
          ...(argumentText === ''
            ? {}
            : { options: [{ name: 'text', type: 3, value: argumentText }] }),
        },
      };
      span = this.#trace.start('interaction', `/${commandName}`, {
        adapter: 'raw-interaction-webhook',
      });
      const callback = await sendSignedInteraction(
        this.#interactionEndpoint,
        this.#interactionPrivateKey,
        this.#interactionPeerSecret,
        payload,
        { ...options, signal },
      );
      signal.throwIfAborted();
      this.assertLive();
      if (selectedContext !== undefined) this.validateContext(selectedContext);
      const normalizedCallback = normalizeInteractionCallback(callback);
      const result: RuntimeInvocationResult = {
        ok: true,
        command: commandName,
        interactionId,
        durationMs: Date.now() - startedAtMs,
        response: normalizedCallback,
        error: null,
      };
      // Exact consumers must never evaluate a redacted or truncated display projection.
      // Validate before recording an accepted callback or a successful trace.
      const exactResult = options.requireExactResponse ? this.#exactInvocationResult(result) : null;
      this.#interactions.respond(interactionId, normalizedCallback.type, normalizedCallback.data);
      this.#trace.end(span, 'ok', { callbackType: normalizedCallback.type });
      this.#refreshEvidence();
      return exactResult ?? this.#invocationResult(result);
    } catch (error) {
      this.#failure = operationFailure(error, signal, 'transport');
      if (interactionId !== null) this.#interactions?.get(interactionId);
      const timedOut = this.#failure.code === 'timeout';
      const peerAuthenticationFailed = error instanceof WebhookPeerAuthenticationError;
      this.#risks?.add({
        ruleId: timedOut
          ? 'INTERACTION_TIMEOUT'
          : peerAuthenticationFailed
            ? 'WEBHOOK_PEER_AUTHENTICATION_FAILED'
            : 'INVALID_INTERACTION_CALLBACK',
        severity: timedOut ? 'critical' : 'high',
        confidence: 1,
        title: timedOut
          ? 'Interaction callback timed out'
          : peerAuthenticationFailed
            ? 'Webhook peer authentication failed'
            : 'Invalid interaction callback',
        evidence: timedOut
          ? `/${commandName} did not return a callback within ${options.timeoutMs ?? INTERACTION_TIMEOUT_MS} ms.`
          : peerAuthenticationFailed
            ? `/${commandName} returned bytes without valid per-run response authentication.`
            : `/${commandName} returned a callback that could not be accepted.`,
        impact: peerAuthenticationFailed
          ? 'The listener cannot be trusted as the supervised bot, so no callback evidence is accepted.'
          : 'The local interaction cannot complete with Discord-compatible behavior.',
        recommendation: peerAuthenticationFailed
          ? 'Use the protected per-run webhook peer secret and authenticate the exact response bytes.'
          : 'Return one valid callback within the interaction deadline.',
        ...(interactionId === null ? {} : { eventId: interactionId }),
      });
      if (span !== undefined) {
        try {
          this.#trace.end(span, 'error', { error: errorMessage(error) });
        } catch {
          // Preserve the original invocation failure if tracing is already closed.
        }
      }
      this.#refreshEvidence();
      const failureResult: RuntimeInvocationResult = {
        ok: false,
        command: commandName,
        interactionId,
        durationMs: Date.now() - startedAtMs,
        response: null,
        error: options.requireExactResponse
          ? this.#failure.message
          : timedOut
            ? `Bot interaction timed out after ${options.timeoutMs ?? INTERACTION_TIMEOUT_MS} ms.`
            : errorMessage(error),
      };
      // Exact-mode errors contain no response and must not re-enter a failed sanitizer.
      return options.requireExactResponse ? failureResult : this.#invocationResult(failureResult);
    }
  }

  #exactInvocationResult(result: RuntimeInvocationResult): RuntimeInvocationResult {
    try {
      const sanitized = this.#sanitizeForExport?.(result);
      if (isInvocationResult(sanitized) && isDeepStrictEqual(sanitized.response, result.response)) {
        return sanitized;
      }
    } catch {
      // Sanitizer failures are not safe response evidence either.
    }
    throw new SessionError(
      'transport',
      'Authenticated response cannot be represented exactly and safely.',
    );
  }

  #invocationResult(result: RuntimeInvocationResult): RuntimeInvocationResult {
    const sanitized = this.#sanitizeForExport?.(result);
    return isInvocationResult(sanitized)
      ? sanitized
      : { ...result, error: result.error === null ? null : redactText(result.error) };
  }

  #refreshEvidence(): void {
    if (this.#expectedStop) return;
    this.#publish({
      ...this.#state,
      traces: sanitizeTraces(this.#trace?.spans(MAX_RENDERER_TRACES) ?? []),
      risks: sanitizeRisks(this.#risks?.all(MAX_RENDERER_RISKS) ?? []),
    });
  }

  #setError(message: string): DesktopRuntimeState {
    this.#publish({ ...this.#state, phase: 'error', error: message });
    return this.snapshot();
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#poller = setInterval(() => {
      const bot = this.#bot;
      if (bot === null) return;
      const processSnapshot = bot.snapshot();
      const traces = sanitizeTraces(this.#trace?.spans(MAX_RENDERER_TRACES) ?? []);
      const risks = sanitizeRisks(this.#risks?.all(MAX_RENDERER_RISKS) ?? []);
      this.#publish({
        ...this.#state,
        pid: processSnapshot.pid ?? null,
        traces,
        risks,
      });
      if (
        this.#state.phase === 'running' &&
        (processSnapshot.status === 'crashed' || processSnapshot.status === 'stopped') &&
        !this.#handlingChildExit
      ) {
        this.#handlingChildExit = true;
        void this.stop()
          .then(() => {
            if (this.#unexpectedExit) {
              // Keep an unconfirmed-cleanup message visible next to the exit.
              const cleanupError = this.hasResources ? this.#state.error : null;
              this.#publish({
                ...this.#state,
                phase: 'error',
                error:
                  cleanupError === null
                    ? 'Bot process exited unexpectedly.'
                    : `Bot process exited unexpectedly. ${cleanupError}`,
                pid: null,
                endpoints: null,
              });
            }
          })
          .finally(() => {
            this.#handlingChildExit = false;
          });
      }
    }, 250);
    this.#poller.unref();
  }

  #stopPolling(): void {
    if (this.#poller !== null) clearInterval(this.#poller);
    this.#poller = null;
  }

  async #cleanup(): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;
    const operation = Promise.resolve().then(() => this.#cleanupInternal());
    this.#cleanupPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#cleanupPromise === operation) this.#cleanupPromise = null;
    }
  }

  async #cleanupInternal(): Promise<void> {
    this.#stopPolling();
    const bot = this.#bot;
    const rest = this.#rest;
    const gatewayServer = this.#gatewayServer;

    this.#trace = null;
    this.#risks = null;
    this.#interactionPrivateKey = null;
    this.#interactionPeerSecret = null;
    this.#interactionEndpoint = null;
    this.#applicationId = null;
    this.#interactionContext = null;
    this.#interactions = null;
    this.#notifyEndpoints(null);
    const errors: string[] = [];
    if (bot !== null) {
      try {
        const stopped = await bot.stop(5_000);
        if (stopped.status !== 'stopped' && stopped.status !== 'crashed')
          throw new Error('Child termination was not confirmed.');
        this.#bot = null;
      } catch {
        errors.push('Bot termination could not be confirmed.');
      }
    }
    if (rest !== null) {
      try {
        await rest.stop();
        this.#rest = null;
      } catch {
        errors.push('REST closure could not be confirmed.');
      }
    }
    if (gatewayServer !== null) {
      try {
        await gatewayServer.stop();
        this.#gatewayServer = null;
      } catch {
        errors.push('Gateway closure could not be confirmed.');
      }
    }
    if (errors.length === 0) {
      try {
        this.#coreOwner?.release();
        this.#coreOwner = null;
      } catch {
        errors.push('Core state subscription closure could not be confirmed.');
      }
    }
    this.#cleanupIssues = errors.map((message) => ({
      code: 'cleanup',
      message: redactText(message),
    }));
    if (errors.length > 0) throw new Error(`Runtime resource cleanup failed: ${errors.join(' ')}`);
    // Failed closure must retain the store, clock, and redaction context for retry.
    this.#sanitizeForExport = null;
  }

  #notifyEndpoints(endpoints: RuntimeEndpoints | null): void {
    try {
      this.#onEndpoints(structuredClone(endpoints));
    } catch {
      /* Observer only. */
    }
  }

  #publish(state: DesktopRuntimeState): void {
    const sanitized = this.#sanitizeForExport?.(state);
    this.#state = structuredClone(isRuntimeState(sanitized) ? sanitized : state);
    try {
      this.#onState(this.snapshot());
    } catch {
      /* Observers cannot corrupt lifecycle. */
    }
  }
}

async function loadCore(): Promise<CoreApi> {
  const loaded: unknown = await import(CORE_SPECIFIER);
  if (!isRecord(loaded)) throw new Error('@disrunner/core did not load as a module.');
  const required = [
    'VirtualClock',
    'SeededRandom',
    'SnowflakeGenerator',
    'VirtualState',
    'TraceCollector',
    'RiskCollector',
    'InteractionEngine',
    'GatewayEmulator',
    'RateLimitEngine',
    'LocalRestEmulator',
    'BotRunner',
    'createSimulationProfile',
    'createOfflineSessionToken',
    'sanitizeForExport',
  ];
  const missing = required.filter((name) => typeof loaded[name] !== 'function');
  if (missing.length > 0)
    throw new Error(`@disrunner/core is missing required export(s): ${missing.join(', ')}.`);
  return loaded as unknown as CoreApi;
}

async function resolveInteractionEndpoint(
  template: string | undefined,
): Promise<string | undefined> {
  if (template === undefined) return undefined;
  let port: number;
  if (template.includes('${DISRUNNER_BOT_PORT}')) {
    port = await reserveLoopbackPort();
  } else {
    const configured = new URL(template).port;
    if (configured === '')
      throw new TypeError('adapter.interactionEndpoint must include an explicit loopback port.');
    port = Number(configured);
  }
  const rendered = template.replaceAll('${DISRUNNER_BOT_PORT}', String(port));
  const parsed = new URL(rendered);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
    throw new TypeError('Resolved interaction endpoint must be an explicit http://127.0.0.1 port.');
  }
  return parsed.href;
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback bot port.'));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePromise(port) : reject(error)));
    });
  });
}

async function waitForSignedPing(
  endpoint: string,
  key: KeyObject,
  secret: string,
  signal: AbortSignal,
  assertLive: () => void,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    assertLive();
    try {
      await verifySignedPing(endpoint, key, secret, signal);
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WebhookPeerAuthenticationError) throw error;
      if (!(error instanceof TypeError && error.message === 'fetch failed')) throw error;
    }
    await delay(50, undefined, { signal });
  }
}

function createInteractionCredentials(): {
  readonly publicKeyHex: string;
  readonly privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'der', type: 'spki' });
  const bytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  if (bytes.byteLength < 32) throw new Error('Generated Ed25519 public key is invalid.');
  return { publicKeyHex: bytes.subarray(bytes.byteLength - 32).toString('hex'), privateKey };
}

/** Legacy string-invoke compatibility only; Session always supplies an explicit context. */
function deriveInteractionContext(resources: readonly Readonly<Record<string, unknown>>[]): {
  readonly guildId?: string;
  readonly channelId?: string;
} {
  const guildId = resources.find(
    (resource) => resource['resourceType'] === 'guild' && typeof resource['id'] === 'string',
  )?.['id'];
  const channelId = resources.find(
    (resource) => resource['resourceType'] === 'channel' && typeof resource['id'] === 'string',
  )?.['id'];
  return {
    ...(typeof guildId === 'string' ? { guildId } : {}),
    ...(typeof channelId === 'string' ? { channelId } : {}),
  };
}

async function verifySignedPing(
  endpoint: string,
  privateKey: KeyObject,
  peerSecretHex: string,
  signal: AbortSignal,
): Promise<void> {
  const payload = await sendSignedInteraction(
    endpoint,
    privateKey,
    peerSecretHex,
    { type: 1 },
    { signal, timeoutMs: 60_000 },
  );
  if (!isRecord(payload) || payload['type'] !== 1) {
    throw new Error('Signed interaction PING readiness returned an invalid response.');
  }
}

function normalizeInteractionCallback(
  value: unknown,
): NonNullable<RuntimeInvocationResult['response']> {
  if (!isRecord(value) || typeof value['type'] !== 'number') {
    throw new Error('Bot interaction callback must be an object with a numeric type.');
  }
  const mapping: Readonly<
    Record<number, NonNullable<RuntimeInvocationResult['response']>['type']>
  > = {
    4: 'message',
    5: 'defer',
    6: 'defer-update',
    7: 'update',
    8: 'autocomplete',
    9: 'modal',
  };
  const type = mapping[value['type']];
  if (type === undefined)
    throw new Error(`Unsupported interaction callback type: ${value['type']}.`);
  const data = value['data'] === undefined ? {} : value['data'];
  if (!isRecord(data)) throw new Error('Bot interaction callback data must be an object.');
  return { type, data: structuredClone(data) };
}

function isInvocationResult(value: unknown): value is RuntimeInvocationResult {
  return (
    isRecord(value) &&
    typeof value['ok'] === 'boolean' &&
    typeof value['command'] === 'string' &&
    (typeof value['interactionId'] === 'string' || value['interactionId'] === null) &&
    typeof value['durationMs'] === 'number' &&
    (value['response'] === null || isRecord(value['response'])) &&
    (typeof value['error'] === 'string' || value['error'] === null)
  );
}

function isRuntimeState(value: unknown): value is DesktopRuntimeState {
  return (
    isRecord(value) &&
    ['idle', 'ready', 'starting', 'running', 'stopping', 'error'].includes(
      String(value['phase']),
    ) &&
    (value['project'] === null || isRecord(value['project'])) &&
    (typeof value['error'] === 'string' || value['error'] === null) &&
    (typeof value['pid'] === 'number' || value['pid'] === null) &&
    Array.isArray(value['output']) &&
    Array.isArray(value['traces']) &&
    Array.isArray(value['risks'])
  );
}

function requireGatewayUrl(value: unknown): string {
  if (!isRecord(value))
    throw new Error('LocalGatewayServer.start() did not return an address object.');
  const candidate = [value['gatewayUrl'], value['url'], value['baseUrl']].find(
    (entry): entry is string => typeof entry === 'string',
  );
  if (candidate === undefined)
    throw new Error('LocalGatewayServer address is missing gatewayUrl/url.');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
    throw new Error('LocalGatewayServer must bind an explicit ws://127.0.0.1 port.');
  }
  return parsed.href;
}

function requireRestAddress(value: unknown): {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
} {
  if (
    !isRecord(value) ||
    typeof value['baseUrl'] !== 'string' ||
    typeof value['apiBaseUrl'] !== 'string'
  ) {
    throw new Error('LocalRestEmulator.start() returned an invalid address.');
  }
  for (const candidate of [value['baseUrl'], value['apiBaseUrl']]) {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
      throw new Error('LocalRestEmulator must bind an explicit http://127.0.0.1 port.');
    }
  }
  return { baseUrl: value['baseUrl'], apiBaseUrl: value['apiBaseUrl'] };
}

function sanitizeOutput(value: unknown): RuntimeOutputEntry | null {
  if (!isRecord(value)) return null;
  const stream = value['stream'];
  const text = value['text'];
  const atMs = value['atMs'];
  if (
    (stream !== 'stdout' && stream !== 'stderr') ||
    typeof text !== 'string' ||
    typeof atMs !== 'number'
  )
    return null;
  return {
    stream,
    text: truncateUtf8(redactText(text), MAX_RENDERER_OUTPUT_ENTRY_BYTES),
    atMs,
  };
}

function sanitizeTraces(values: readonly unknown[]): readonly RuntimeTraceEntry[] {
  return values
    .flatMap((value): readonly RuntimeTraceEntry[] => {
      if (!isRecord(value)) return [];
      const { id, traceId, kind, name, status, startedAtMs, durationMs } = value;
      if (
        typeof id !== 'string' ||
        typeof traceId !== 'string' ||
        typeof kind !== 'string' ||
        typeof name !== 'string' ||
        typeof status !== 'string' ||
        typeof startedAtMs !== 'number' ||
        typeof durationMs !== 'number'
      )
        return [];
      return [{ id, traceId, kind, name: redactText(name), status, startedAtMs, durationMs }];
    })
    .slice(-MAX_RENDERER_TRACES);
}

function sanitizeRisks(values: readonly unknown[]): readonly RuntimeRiskEntry[] {
  return values
    .flatMap((value): readonly RuntimeRiskEntry[] => {
      if (!isRecord(value)) return [];
      const { ruleId, severity, title, evidence } = value;
      if (
        typeof ruleId !== 'string' ||
        typeof severity !== 'string' ||
        typeof title !== 'string' ||
        typeof evidence !== 'string'
      )
        return [];
      return [{ ruleId, severity, title: redactText(title), evidence: redactText(evidence) }];
    })
    .slice(-MAX_RENDERER_RISKS);
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:mfa\.)?[A-Za-z\d_-]{24,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/gu, '[REDACTED]')
    .replace(/\b(Bot|Bearer)\s+[A-Za-z\d._~+/-]{16,}\b/giu, '$1 [REDACTED]');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return Buffer.from(value)
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationFailure(
  error: unknown,
  signal: AbortSignal,
  fallback: 'transport' | 'start-failed',
): SessionError {
  if (signal.aborted)
    return signal.reason instanceof SessionError
      ? signal.reason
      : new SessionError('cancelled', 'Runtime operation cancelled.');
  if (error instanceof SessionError) return error;
  if (error instanceof WebhookPeerAuthenticationError)
    return new SessionError('peer-auth', 'Webhook response authentication failed.');
  if (error instanceof Error && error.name === 'TimeoutError')
    return new SessionError('timeout', 'Interaction deadline exceeded.');
  return new SessionError(
    fallback,
    fallback === 'transport' ? 'Bot interaction failed.' : 'Bot startup failed.',
  );
}

interface CoreSnapshotSource {
  snapshot(): unknown;
  revisionedSnapshot?: () => unknown;
  subscribeCommits?: (listener: (commit: unknown) => void) => () => void;
}

/** Internal ownership adapter. Exported from this module only for contract tests. */
export class RetainedCoreState {
  #source: CoreSnapshotSource | null;
  #clock: { now(): number; readonly mode: string } | null;
  #unsubscribe: (() => void) | null = null;
  #subscriptionGeneration = 0;
  public constructor(
    readonly runId: string,
    source: unknown,
    clock: unknown,
    readonly sanitize: (value: unknown) => unknown,
  ) {
    if (
      !isRecord(source) ||
      typeof source['snapshot'] !== 'function' ||
      !isRecord(clock) ||
      typeof clock['now'] !== 'function' ||
      clock['mode'] !== 'realtime'
    )
      throw new TypeError('Runtime requires an actual core store and realtime clock.');
    this.#source = source as unknown as CoreSnapshotSource;
    this.#clock = clock as unknown as { now(): number; readonly mode: string };
  }
  public subscribe(listener: () => void): void {
    this.#detach();
    const source = this.#source;
    const generation = this.#subscriptionGeneration;
    if (
      typeof source?.revisionedSnapshot !== 'function' ||
      typeof source.subscribeCommits !== 'function'
    )
      return;
    this.#unsubscribe = source.subscribeCommits(() => {
      if (this.#source !== source || generation !== this.#subscriptionGeneration) return;
      try {
        listener();
      } catch {
        /* Observers cannot change commit outcomes. */
      }
    });
  }
  // Authorization reads the retained store, never the bounded renderer projection.
  #resources(): readonly Record<string, unknown>[] {
    try {
      const raw = this.#source?.snapshot();
      return isRecord(raw) && Array.isArray(raw['resources'])
        ? raw['resources'].filter(isRecord)
        : [];
    } catch {
      return [];
    }
  }
  public contexts(): InvocationContext[] {
    return contextsFromResources(this.#resources());
  }
  public actor(id: string): Readonly<Record<string, unknown>> | undefined {
    const actor = this.#resources().find((r) => r['resourceType'] === 'user' && r['id'] === id);
    return actor === undefined ? undefined : structuredClone(actor);
  }
  public snapshot(): RuntimeCoreSnapshot | null {
    const source = this.#source;
    const clock = this.#clock;
    if (source === null || clock === null) return null;
    try {
      const revisioned =
        typeof source.revisionedSnapshot === 'function' &&
        typeof source.subscribeCommits === 'function';
      const pair = revisioned ? source.revisionedSnapshot?.() : null;
      if (
        revisioned &&
        (!isRecord(pair) || !Number.isSafeInteger(pair['revision']) || Number(pair['revision']) < 0)
      )
        return null;
      const raw = revisioned && isRecord(pair) ? pair['snapshot'] : source.snapshot();
      if (!isRecord(raw) || !Array.isArray(raw['resources'])) return null;
      const totalResources = raw['resources'].length;
      // Bound the sanitized renderer projection independently of the core store capacity.
      const resources: RuntimeResourceView[] = [];
      let bytes = 2;
      for (const resource of raw['resources'].slice(0, 1_000)) {
        if (
          isRecord(resource) &&
          resource['resourceType'] === 'message' &&
          !isPublicOrdinaryMessage(resource, raw['resources'])
        )
          continue;
        const view = projectResourceView(resource);
        if (view === null) continue;
        const sanitized = this.sanitize(view);
        if (!isRecord(sanitized)) return null;
        const encoded = JSON.stringify(sanitized);
        if (bytes + Buffer.byteLength(encoded) + (resources.length > 0 ? 1 : 0) > 1_048_576) break;
        bytes += Buffer.byteLength(encoded) + (resources.length > 0 ? 1 : 0);
        resources.push(JSON.parse(encoded) as RuntimeResourceView);
      }
      const nowMs = clock.now();
      if (!Number.isFinite(nowMs) || clock.mode !== 'realtime') return null;
      return {
        schemaVersion: 1,
        runId: this.runId,
        stateRevision: revisioned && isRecord(pair) ? Number(pair['revision']) : null,
        revisioned,
        clock: { domain: 'bot', mode: 'realtime', nowMs },
        resources,
        totalResources,
        truncated: resources.length !== totalResources,
      };
    } catch {
      return null;
    } // No raw-state fallback when sanitization fails.
  }
  public release(): void {
    this.#detach();
    this.#source = null;
    this.#clock = null;
  }
  #detach(): void {
    this.#subscriptionGeneration += 1;
    const unsubscribe = this.#unsubscribe;
    unsubscribe?.();
    this.#unsubscribe = null;
  }
}

function projectResourceView(value: unknown): RuntimeResourceView | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !['guild', 'channel', 'user', 'message'].includes(String(value['resourceType']))
  )
    return null;
  const type = value['resourceType'] as RuntimeResourceView['resourceType'];
  const result: Record<string, unknown> = { id: value['id'], resourceType: type };
  const strings =
    type === 'user'
      ? ['username']
      : type === 'guild'
        ? ['name']
        : type === 'channel'
          ? ['name', 'guild_id']
          : ['guild_id', 'channel_id', 'content', 'timestamp'];
  for (const key of strings) if (typeof value[key] === 'string') result[key] = value[key];
  if (type === 'user') copyAuthorFields(value, result);
  if (type === 'channel' && Number.isSafeInteger(value['type'])) result['type'] = value['type'];
  if (type === 'message') {
    result['visibility'] = 'channel';
    result['type'] = 0;
    if (Number.isSafeInteger(value['flags'])) result['flags'] = value['flags'];
    if (typeof value['edited_timestamp'] === 'string' || value['edited_timestamp'] === null)
      result['edited_timestamp'] = value['edited_timestamp'];
    const author = value['author'];
    if (isRecord(author) && typeof author['id'] === 'string') {
      const projectedAuthor: Record<string, unknown> = { id: author['id'] };
      copyAuthorFields(author, projectedAuthor);
      result['author'] = projectedAuthor;
    }
  }
  return result as unknown as RuntimeResourceView;
}
function copyAuthorFields(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (typeof source['username'] === 'string') target['username'] = source['username'];
  if (typeof source['global_name'] === 'string' || source['global_name'] === null)
    target['global_name'] = source['global_name'];
  if (typeof source['bot'] === 'boolean') target['bot'] = source['bot'];
}

function contextsFromResources(
  resources: readonly Readonly<Record<string, unknown>>[],
): InvocationContext[] {
  const guilds = new Set(
    resources.filter((r) => r['resourceType'] === 'guild').map((r) => r['id']),
  );
  const channels = resources.filter(
    (r) =>
      r['resourceType'] === 'channel' &&
      r['type'] === 0 &&
      typeof r['id'] === 'string' &&
      typeof r['guild_id'] === 'string' &&
      guilds.has(r['guild_id']),
  );
  return resources
    .filter((r) => r['resourceType'] === 'user' && typeof r['id'] === 'string')
    .flatMap((user) =>
      channels.map((channel) => ({
        actorId: String(user['id']),
        guildId: String(channel['guild_id']),
        channelId: String(channel['id']),
      })),
    );
}

function isPublicOrdinaryMessage(
  message: Record<string, unknown>,
  resources: readonly unknown[],
): boolean {
  if (
    message['visibility'] !== 'channel' ||
    message['type'] !== 0 ||
    typeof message['flags'] !== 'number' ||
    !Number.isSafeInteger(message['flags']) ||
    ![0, 4, 4096, 4100].includes(message['flags'])
  )
    return false;
  const channel = resources.find(
    (r) => isRecord(r) && r['resourceType'] === 'channel' && r['id'] === message['channel_id'],
  );
  return (
    isRecord(channel) &&
    channel['type'] === 0 &&
    typeof channel['guild_id'] === 'string' &&
    channel['guild_id'] === message['guild_id'] &&
    resources.some(
      (r) => isRecord(r) && r['resourceType'] === 'guild' && r['id'] === channel['guild_id'],
    )
  );
}
