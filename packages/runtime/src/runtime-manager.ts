import { readFile, stat } from 'node:fs/promises';
import { canViewChannel } from './viewer-permissions.js';
import { adapterCommand } from './adapter-host.js';
import { RuntimeActionDriver } from './runtime-actions.js';
import {
  FaultPolicy,
  type FaultPlan,
  type FaultEvidence,
  projectMessageWire,
  GatewayIntents,
  type GatewayEmulator,
  type VirtualState,
  type VirtualClock,
  type InteractionEngine,
  type LocalAttachmentMetadata,
  type LocalRestEmulator,
  type BotProcessControl,
} from '@disrunner/core';
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
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
  type RuntimeAction,
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
const MAX_RENDERER_TRACES = 1000;
const MAX_RENDERER_RISKS = 100;
const MAX_INTERACTION_INPUT_BYTES = 2_000;
const CLEANUP_PENDING_SELECT =
  'Previous run cleanup is not confirmed. Stop again to retry cleanup before selecting a project.';

interface TraceCollectorLike {
  evidence?(): Readonly<Record<string, unknown>>;
  start(kind: string, name: string, metadata?: Readonly<Record<string, unknown>>): unknown;
  end(handle: unknown, status?: string, metadata?: Readonly<Record<string, unknown>>): unknown;
  spans(limit?: number): readonly unknown[];
}

interface RiskCollectorLike {
  evidence?(): Readonly<Record<string, unknown>>;
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
  #driver: RuntimeActionDriver | null = null;
  #inputs:
    | { schemaVersion: 1; fixtureHash: string; profileHash: string; sourceHash: string | null }
    | undefined;
  #sdkReady = false;
  #adapterIssue: SessionError | null = null;
  #faultPolicy = new FaultPolicy();
  #retainedFaultEvidence: FaultEvidence | null = null;
  #droppedOutput = 0;
  #diagnostics: SessionIssue[] = [];
  #activeHandlers = new Set<string>();
  #droppedDiagnostics = 0;
  #captureSnapshot: {
    evidenceComplete: boolean;
    droppedOutput: number;
    droppedTraces: number;
    droppedRisks: number;
  } | null = null;

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
      : contextsFromResources(
          this.#configuration?.resources ?? [],
          this.#configuration?.botUserId,
          this.#configuration?.profile.ordinaryMessagePermissions !== 'legacy-unenforced',
        );
  }

  public validateContext(context: InvocationContext): InvocationContext {
    if (
      context === null ||
      typeof context !== 'object' ||
      ![context.actorId, context.channelId].every(isCanonicalSnowflake) ||
      (context.guildId !== undefined && !isCanonicalSnowflake(context.guildId))
    ) {
      throw new SessionError(
        'invalid',
        'Invocation context IDs must be canonical positive decimal unsigned 64-bit strings.',
      );
    }
    if (
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
    return {
      actorId: context.actorId,
      ...(context.guildId === undefined ? {} : { guildId: context.guildId }),
      channelId: context.channelId,
    };
  }
  public assertLive(): void {
    this.#checkAdapterIssue();
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

  public coreState(actorId?: string): RuntimeCoreSnapshot | null {
    return this.#coreOwner?.snapshot(actorId) ?? null;
  }
  #checkAdapterIssue(): void {
    const issue = this.#adapterIssue;
    if (issue !== null) throw issue;
  }
  #resetBotControl(): void {
    this.#sdkReady = false;
    this.#adapterIssue = null;
    this.#activeHandlers.clear();
  }
  public inputIdentity() {
    return this.#inputs === undefined ? undefined : { ...this.#inputs };
  }
  public commands(context?: InvocationContext): readonly Readonly<Record<string, unknown>>[] {
    if (context) {
      const selected = this.validateContext(context);
      return selected.guildId === undefined
        ? []
        : (this.#coreOwner?.commands(selected.guildId) ?? []);
    }
    return this.#coreOwner?.commands() ?? [];
  }
  public commandsTruncated(): boolean {
    return (this.#coreOwner?.commandCount() ?? 0) > 100;
  }
  public hasActor(id: string): boolean {
    return (
      (this.#coreOwner?.actor(id) ??
        this.#configuration?.resources.find(
          (r) => r['resourceType'] === 'user' && r['id'] === id,
        )) !== undefined
    );
  }
  public activeHandlers(): number {
    return this.#activeHandlers.size;
  }
  public diagnostics(): readonly SessionIssue[] {
    return structuredClone(this.#diagnostics);
  }
  public captureEvidence() {
    return this.#captureSnapshot
      ? { ...this.#captureSnapshot }
      : this.#measureCapture(this.#trace, this.#risks, this.#bot);
  }
  #measureCapture(
    traceSource: TraceCollectorLike | null,
    riskSource: RiskCollectorLike | null,
    botSource: BotRunnerLike | null,
  ) {
    const trace = traceSource?.evidence?.();
    const risks = riskSource?.evidence?.();
    const output = botSource?.evidence?.();
    const droppedTraces =
      Number(trace?.['droppedSpans'] ?? 0) +
      Math.max(
        0,
        Number(trace?.['retainedSpans'] ?? traceSource?.spans().length ?? 0) - MAX_RENDERER_TRACES,
      );
    const droppedRisks =
      Number(risks?.['droppedFindings'] ?? 0) +
      Math.max(
        0,
        Number(risks?.['retainedFindings'] ?? riskSource?.all().length ?? 0) - MAX_RENDERER_RISKS,
      );
    const droppedOutput =
      this.#droppedOutput +
      Number(output?.['evictedEntries'] ?? 0) +
      Number(output?.['truncatedLines'] ?? 0) +
      Number(output?.['observerFailures'] ?? 0);
    return {
      evidenceComplete:
        trace?.['complete'] !== false &&
        risks?.['complete'] !== false &&
        output?.['complete'] !== false &&
        droppedTraces === 0 &&
        droppedRisks === 0 &&
        droppedOutput === 0 &&
        this.#droppedDiagnostics === 0 &&
        this.faultEvidence().complete,
      droppedOutput,
      droppedTraces,
      droppedRisks,
    };
  }
  public setFaults(plans: readonly FaultPlan[]): void {
    if (this.#state.phase !== 'running')
      throw new SessionError('not-running', 'Start a run before configuring faults.');
    this.#retainedFaultEvidence = null;
    this.#faultPolicy.set(plans);
  }
  public faultEvidence() {
    return this.#retainedFaultEvidence ?? this.#faultPolicy.evidence();
  }
  public interactionStates(): readonly { id: string; status: string }[] {
    const engine = this.#interactions as unknown as InteractionEngine | null;
    return (
      engine
        ?.list()
        .slice(-1000)
        .map(({ id, status }) => ({ id, status })) ?? []
    );
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
      const project = await loadProjectConfiguration(directory, { allowInvalidWorkspace: true });
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
    this.#retainedFaultEvidence = null;
    this.#captureSnapshot = null;
    this.#droppedOutput = 0;
    this.#diagnostics = [];
    this.#droppedDiagnostics = 0;
    this.#resetBotControl();
    this.#faultPolicy.clear();
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
      if (configuration.workspaceIssue)
        throw new SessionError('invalid', configuration.workspaceIssue);
      this.#publish({ ...this.#state, project: configuration.summary });
      const core = await loadCore();
      signal.throwIfAborted();
      const GatewayServer = core.LocalGatewayServer;
      if (GatewayServer === undefined) {
        throw new Error(
          '@disrunner/core does not export LocalGatewayServer. Desktop startup is fail-closed until the core gateway transport is available.',
        );
      }
      let sourceHash: string | null = null;
      if (
        configuration.entryPoint !== null &&
        (await stat(configuration.entryPoint)).size <= 16 * 1_048_576
      )
        sourceHash = createHash('sha256')
          .update(await readFile(configuration.entryPoint))
          .digest('hex');
      signal.throwIfAborted();
      this.#inputs = {
        schemaVersion: 1,
        fixtureHash: createHash('sha256')
          .update(JSON.stringify(configuration.resources))
          .digest('hex'),
        profileHash: createHash('sha256')
          .update(JSON.stringify(configuration.profile))
          .digest('hex'),
        sourceHash,
      };
      const sessionToken = core.createOfflineSessionToken();
      const interactionCredentials = createInteractionCredentials();
      const interactionPeerSecret =
        configuration.adapter.type === 'raw-interaction-webhook' ? createWebhookPeerSecret() : null;
      const configuredSensitiveValues = Object.entries(configuration.environment)
        .filter(([key]) =>
          /(?:^|_)(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|CREDENTIAL)$/iu.test(
            key,
          ),
        )
        .map(([, value]) => value);
      this.#sanitizeForExport = (value: unknown) =>
        core.sanitizeForExport(value, {
          sensitiveValues: [
            ...configuredSensitiveValues,
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
      const reservedUserIds = new Set(
        configuration.resources
          .filter((resource) => resource['resourceType'] === 'user')
          .map((resource) => resource['id']),
      );
      const nextIdentity = (): string => {
        let id = snowflakes.generate();
        while (reservedUserIds.has(id)) id = snowflakes.generate();
        reservedUserIds.add(id);
        return id;
      };
      const applicationId =
        configuration.botUserId === undefined ? snowflakes.generate() : nextIdentity();
      const botUserId = configuration.botUserId ?? snowflakes.generate();
      const ownerId =
        configuration.botUserId === undefined ? snowflakes.generate() : nextIdentity();
      const trace = new core.TraceCollector({ clock, random });
      const risks = new core.RiskCollector(clock);
      const state = new core.VirtualState(clock, snowflakes, configuration.resources);
      const runId = options.runId ?? randomUUID();
      const owner = new RetainedCoreState(
        runId,
        state,
        clock,
        this.#sanitizeForExport,
        botUserId,
        true,
        configuration.profile.ordinaryMessagePermissions !== 'legacy-unenforced',
      );
      this.#coreOwner = owner;
      owner.subscribe(() => {
        if (generation !== this.#generation || this.#expectedStop || this.#coreOwner !== owner)
          return;
        this.#publish(this.#state);
      });
      this.#applicationId = applicationId;
      this.#interactionContext = deriveInteractionContext(configuration.resources);
      const botUser = {
        id: botUserId,
        username: 'DisRunner Bot',
        discriminator: '0',
        avatar: null,
        bot: true,
      };
      if (
        (configuration.adapter.type !== 'raw-interaction-webhook' ||
          configuration.profile.commandRegistry?.profile === 'command-registry-v2') &&
        !(state as VirtualState).get('user', botUserId)
      )
        (state as VirtualState).create('user', botUser);
      if (
        configuration.adapter.type !== 'raw-interaction-webhook' ||
        configuration.profile.commandRegistry?.profile === 'command-registry-v2'
      )
        for (const guild of (state as VirtualState).list('guild')) {
          if (!(state as VirtualState).get('role', guild.id))
            (state as VirtualState).create('role', {
              id: guild.id,
              guild_id: guild.id,
              name: '@everyone',
              permissions: '68608',
              position: 0,
            });
          if (
            !(state as VirtualState)
              .list('member')
              .some(
                (member) =>
                  member['guild_id'] === guild.id &&
                  (member['user_id'] === botUserId || member.id === botUserId),
              )
          )
            (state as VirtualState).create('member', {
              guild_id: guild.id,
              user_id: botUserId,
              roles: [],
              flags: 0,
              joined_at: new Date(0).toISOString(),
              deaf: false,
              mute: false,
            });
        }
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
        portalEnabledPrivilegedIntents: configuration.profile.intents.reduce(
          (bits, name) => bits | (GatewayIntents[name as keyof typeof GatewayIntents] ?? 0n),
          0n,
        ),
        ...(configuration.adapter.type === 'raw-interaction-webhook'
          ? {}
          : { bootstrap: { state, user: botUser } }),
      });
      // Shared state, Gateway and the bootstrap bot exist before the engine; the engine and
      // the REST emulator share one message run so both origins use one ordered record.
      const interactions = new core.InteractionEngine({
        applicationId,
        clock,
        random,
        snowflakes,
        profile,
        onRisk: (finding: unknown) => risks.add(finding),
        messageAuthority: {
          state,
          gateway,
          author: botUser,
          context: { runId, clockDomain: 'realtime' },
        },
      });
      this.#interactions = interactions;
      // Own the real resource before wrapping it: if wrapping throws, cleanup still reaches it.
      this.#gatewayServer = new GatewayServer({ gateway, trace, faultPolicy: this.#faultPolicy });
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
        faultPolicy: this.#faultPolicy,
        state,
        ...(configuration.profile.commandRegistry === undefined
          ? configuration.adapter.type === 'raw-interaction-webhook'
            ? {}
            : {
                commandRegistry: {
                  profile: 'command-registry-v2',
                  guildIds: configuration.resources
                    .filter((r) => r['resourceType'] === 'guild')
                    .map((r) => r['id']),
                },
              }
          : { commandRegistry: configuration.profile.commandRegistry }),
        ordinaryMessagePermissions: configuration.profile.ordinaryMessagePermissions,
        messageDomain: { runId, clockDomain: 'realtime' },
        interactions,
        gateway,
        rateLimits,
        fakeToken: sessionToken,
        gatewayUrl,
        bootstrap: {
          user: botUser,
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

      this.#driver = new RuntimeActionDriver({
        state: state as VirtualState,
        clock: clock as VirtualClock,
        gateway: gateway as GatewayEmulator,
        interactions: interactions as unknown as InteractionEngine,
        applicationId,
        projectRoot: configuration.summary.root,
        attachments: (rest as LocalRestEmulator).localAttachments(),
        requireRegisteredCommands:
          configuration.adapter.type !== 'raw-interaction-webhook' ||
          configuration.profile.commandRegistry?.profile === 'command-registry-v2',
        enforcePermissions:
          configuration.profile.ordinaryMessagePermissions !== 'legacy-unenforced',
        assertLive: () => this.assertLive(),
        ...(configuration.adapter.type === 'raw-interaction-webhook'
          ? {
              transport: async (
                payload: Readonly<Record<string, unknown>>,
                requestSignal: AbortSignal,
              ) => {
                if (
                  !this.#interactionEndpoint ||
                  !this.#interactionPrivateKey ||
                  !this.#interactionPeerSecret
                )
                  throw new SessionError('transport', 'Webhook transport is unavailable.');
                const effect = await this.#faultPolicy.applyHttp(
                  { method: 'POST', route: '/interactions' },
                  { signal: requestSignal },
                );
                if (effect?.kind === 'timeout')
                  throw new SessionError('timeout', 'Injected webhook timeout.');
                if (effect?.kind === 'http-status')
                  throw new SessionError('transport', `Injected webhook HTTP ${effect.status}.`);
                const callback = await sendSignedInteraction(
                  this.#interactionEndpoint,
                  this.#interactionPrivateKey,
                  this.#interactionPeerSecret,
                  payload,
                  { signal: requestSignal },
                );
                const normalized = normalizeInteractionCallback(callback, 'interactions-v1');
                if (normalized.type === 'pong')
                  throw new SessionError('transport', 'Unexpected PONG callback.');
                return { type: normalized.type, data: normalized.data };
              },
            }
          : {}),
      });
      const output: RuntimeOutputEntry[] = [];
      let outputBytes = 0;
      const appendOutput = (entry: RuntimeOutputEntry): void => {
        outputBytes += Buffer.byteLength(entry.text);
        output.push(entry);
        while (
          output.length > 0 &&
          (output.length > MAX_RENDERER_OUTPUT || outputBytes > MAX_RENDERER_OUTPUT_BYTES)
        ) {
          const removed = output.shift();
          this.#droppedOutput += 1;
          if (removed !== undefined) outputBytes -= Buffer.byteLength(removed.text);
        }
        this.#publish({ ...this.#state, output: [...output] });
      };
      const safeControlMessage = (message: string, fallback: string): string => {
        const cleaned = this.#sanitizeForExport?.({ message });
        return isRecord(cleaned) && typeof cleaned['message'] === 'string'
          ? cleaned['message']
          : fallback;
      };
      const controlFailure = (): void => {
        this.#droppedDiagnostics += 1;
        this.#adapterIssue = new SessionError(
          'transport',
          'Invalid or incomplete Bot control record.',
        );
      };
      const bot = new core.BotRunner({
        maxOutputEntries: 1000,
        maxOutputBytes: MAX_RENDERER_OUTPUT_BYTES,
        maxOutputLineBytes: 65_536,
        onControl: (record: BotProcessControl) => {
          if (generation !== this.#generation) return;
          switch (record.kind) {
            case 'ready':
              this.#sdkReady = true;
              return;
            case 'handler':
              if (record.phase === 'start') {
                if (this.#activeHandlers.size >= 1000 || this.#activeHandlers.has(record.id))
                  controlFailure();
                else this.#activeHandlers.add(record.id);
              } else if (!this.#activeHandlers.delete(record.id)) controlFailure();
              this.#publish(this.#state);
              return;
            case 'adapter-error': {
              const message = safeControlMessage(
                record.message,
                'The configured SDK or language runtime is unsupported.',
              );
              this.#adapterIssue = new SessionError('invalid', message);
              appendOutput({ stream: 'stderr', text: message + '\n', atMs: Date.now() });
              return;
            }
            case 'diagnostic': {
              const message = safeControlMessage(
                record.message,
                'The bot reported a handler error.',
              );
              this.#diagnostics.push({ code: 'bot-error', message: truncateUtf8(message, 8192) });
              if (this.#diagnostics.length > 100) {
                this.#diagnostics.shift();
                this.#droppedDiagnostics += 1;
              }
              try {
                const diagnosticSpan = trace.start('bot-handler', 'Handler error');
                trace.end(diagnosticSpan, 'error', { message });
              } catch {
                this.#droppedDiagnostics += 1;
              }
              appendOutput({ stream: 'stderr', text: message + '\n', atMs: Date.now() });
              return;
            }
            case 'protocol-error':
              controlFailure();
              return;
          }
        },
        onOutput: (entry: unknown) => {
          if (generation !== this.#generation) return;
          const sanitized = sanitizeOutput(entry);
          if (sanitized === null) return;
          if (
            isRecord(entry) &&
            typeof entry['text'] === 'string' &&
            Buffer.byteLength(entry['text']) > MAX_RENDERER_OUTPUT_ENTRY_BYTES
          )
            this.#droppedOutput += 1;
          appendOutput(sanitized);
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
        args: adapterCommand(configuration),
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
      if (configuration.adapter.type !== 'raw-interaction-webhook') {
        while (
          !this.#sdkReady ||
          !(gateway as GatewayEmulator).sessions().some((session) => session.state === 'ready') ||
          this.#activeHandlers.size !== 0
        ) {
          signal.throwIfAborted();
          this.#checkAdapterIssue();
          if (this.#diagnostics.length > 0)
            throw new SessionError('bot-error', 'The Bot reported an error during startup.');
          this.assertLive();
          await delay(10, undefined, { signal });
        }
        if (this.#diagnostics.length > 0)
          throw new SessionError('bot-error', 'The Bot reported an error during startup.');
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
      this.#failure = signal.aborted
        ? operationFailure(error, signal, 'start-failed')
        : (this.#adapterIssue ?? operationFailure(error, signal, 'start-failed'));
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
      if (this.#adapterIssue && !signal.aborted) this.#failure = this.#adapterIssue;
      const reportedFailure =
        this.#adapterIssue && !signal.aborted ? this.#adapterIssue.message : primaryFailure;
      this.#publish({
        ...this.#state,
        phase: 'error',
        project: configuration?.summary ?? this.#state.project,
        error:
          cleanupFailure === null
            ? reportedFailure
            : `${reportedFailure} Cleanup also failed: ${cleanupFailure}`,
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

  public readAttachment(id: string, context: InvocationContext) {
    if (!this.#driver || this.#state.phase !== 'running')
      throw new SessionError('not-running', 'Start a run before reading attachments.');
    return this.#driver.readAttachment(id, this.validateContext(context));
  }
  public async importAttachment(
    relativePath: string,
    context: InvocationContext,
  ): Promise<LocalAttachmentMetadata> {
    if (!this.#driver || this.#state.phase !== 'running')
      throw new SessionError('not-running', 'Start a run before importing attachments.');
    return this.#driver.importAttachment(
      relativePath,
      this.validateContext(context),
      this.#runAbort?.signal,
    );
  }
  public async dispatch(
    action: RuntimeAction,
    context: InvocationContext,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RuntimeInvocationResult> {
    if (this.#state.phase !== 'running' || !this.#driver)
      throw new SessionError('not-running', 'Start a bot project first.');
    const selected = this.validateContext(context);
    const signal = AbortSignal.any([
      ...(this.#runAbort ? [this.#runAbort.signal] : []),
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 3000),
    ]);
    const span = this.#trace?.start(
      'interaction',
      action.type === 'command' ? `/${action.name ?? ''}` : action.type,
      { action: action.type, actorId: selected.actorId, channelId: selected.channelId },
    );
    try {
      const result = await this.#driver.dispatch(action, selected, signal);
      const exactResult = this.#exactInvocationResult(result);
      if (span) this.#trace?.end(span, 'ok');
      this.#refreshEvidence();
      return exactResult;
    } catch (error) {
      if (span) this.#trace?.end(span, 'error');
      this.#refreshEvidence();
      if (signal.aborted)
        throw new SessionError(
          isRecord(signal.reason as unknown) &&
            (signal.reason as Record<string, unknown>)['name'] === 'TimeoutError'
            ? 'timeout'
            : 'cancelled',
          'The operation timed out or was cancelled.',
        );
      throw error;
    }
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
      context !== undefined &&
      (this.#configuration?.adapter.type !== 'raw-interaction-webhook' ||
        this.#configuration.profile.commandRegistry?.profile === 'command-registry-v2')
    ) {
      const argumentText = normalized.slice(commandToken.length).trim();
      return this.dispatch(
        {
          type: 'command',
          name: commandName,
          ...(argumentText ? { options: [{ name: 'text', type: 3, value: argumentText }] } : {}),
        },
        context,
        options,
      );
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
      // Context-bound chat-input invocations use authoritative messages; the older
      // contextless path stays model-only.
      const created = this.#interactions.create({
        ...(selectedContext === undefined
          ? {}
          : { context: selectedContext, messageProfile: 'chat-input-messages-v1' }),
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
      const normalizedCallback = normalizeInteractionCallback(
        callback,
        selectedContext === undefined ? 'model' : 'chat-input-messages-v1',
      );
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
    this.#captureSnapshot = this.captureEvidence();
    this.#retainedFaultEvidence = this.#faultPolicy.evidence();
    this.#faultPolicy.clear();
    const bot = this.#bot;
    const rest = this.#rest;
    const gatewayServer = this.#gatewayServer;
    const capturedTrace = this.#trace;
    const capturedRisks = this.#risks;

    this.#trace = null;
    this.#risks = null;
    this.#interactionPrivateKey = null;
    this.#interactionPeerSecret = null;
    this.#interactionEndpoint = null;
    this.#applicationId = null;
    this.#interactionContext = null;
    this.#interactions = null;
    this.#driver = null;
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
    this.#captureSnapshot = this.#measureCapture(capturedTrace, capturedRisks, bot);
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
  const staleSigningTimestamp = new Error('Readiness signing timestamp has not advanced.');
  let signedSecond: number | undefined;
  while (true) {
    signal.throwIfAborted();
    assertLive();
    try {
      await verifySignedPing(endpoint, key, secret, signal, (timestamp) => {
        const nextSecond = Number(timestamp);
        // A clock adjustment can race the wait/check below. Veto before fetch.
        if (signedSecond !== undefined && nextSecond <= signedSecond) {
          throw staleSigningTimestamp;
        }
        signedSecond = nextSecond;
      });
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WebhookPeerAuthenticationError) throw error;
      if (
        error !== staleSigningTimestamp &&
        !(error instanceof TypeError && error.message === 'fetch failed')
      )
        throw error;
    }
    // An accepted request may have lost its response. Re-signing the same PING
    // in the same second would replay its deterministic signature. Wait for real
    // wall time to advance, never manufacture a timestamp. The original startup
    // deadline/cancellation bounds this polling even if the clock stalls or rolls back.
    do {
      await delay(50, undefined, { signal });
      signal.throwIfAborted();
      assertLive();
    } while (signedSecond !== undefined && Math.floor(Date.now() / 1_000) <= signedSecond);
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
  onSignedTimestamp: (timestamp: string) => void,
): Promise<void> {
  const payload = await sendSignedInteraction(
    endpoint,
    privateKey,
    peerSecretHex,
    { type: 1 },
    { signal, timeoutMs: 60_000, onSignedTimestamp },
  );
  if (!isRecord(payload) || payload['type'] !== 1) {
    throw new Error('Signed interaction PING readiness returned an invalid response.');
  }
}

function normalizeInteractionCallback(
  value: unknown,
  profile: 'model' | 'chat-input-messages-v1' | 'interactions-v1',
): NonNullable<RuntimeInvocationResult['response']> {
  if (
    profile !== 'model' &&
    (!isRecord(value) ||
      Object.keys(value).some((key) => key !== 'type' && key !== 'data') ||
      typeof value['type'] !== 'number' ||
      !(profile === 'interactions-v1' ? [4, 5, 6, 7, 8, 9] : [4, 5, 9]).includes(value['type']) ||
      (Object.hasOwn(value, 'data') && !isRecord(value['data'])))
  ) {
    throw new Error('Invalid interaction message payload.');
  }
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

function isCanonicalSnowflake(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
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
    readonly excludedActorId?: string,
    readonly extended = false,
    readonly enforceViewPermissions = false,
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
    return contextsFromResources(
      this.#resources(),
      this.excludedActorId,
      this.enforceViewPermissions,
    );
  }
  public actor(id: string): Readonly<Record<string, unknown>> | undefined {
    const actor = this.#resources().find((r) => r['resourceType'] === 'user' && r['id'] === id);
    return actor === undefined ? undefined : structuredClone(actor);
  }
  public commandCount(): number {
    return this.#resources().filter((r) => r['resourceType'] === 'application-command').length;
  }
  public commands(guildId?: string): readonly Readonly<Record<string, unknown>>[] {
    let all = this.#resources().filter((r) => r['resourceType'] === 'application-command');
    if (guildId !== undefined) {
      all = all
        .filter((r) => r['guild_id'] === undefined || r['guild_id'] === guildId)
        .sort((a, b) => Number(b['guild_id'] !== undefined) - Number(a['guild_id'] !== undefined));
      const keys = new Set<string>();
      all = all.filter((command) => {
        const key = JSON.stringify([command['type'], command['name']]);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
    }
    return all
      .slice(0, guildId === undefined ? 100 : 220)
      .map(
        (r) =>
          this.sanitize(
            Object.fromEntries(
              Object.entries(r).filter(
                ([key]) => !['resourceType', 'registry_profile'].includes(key),
              ),
            ),
          ) as Readonly<Record<string, unknown>>,
      );
  }
  public snapshot(actorId?: string): RuntimeCoreSnapshot | null {
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
      const resourceLimit = this.extended ? 2_000 : 1_000;
      const rawResources = (raw['resources'] as unknown[]).filter(isRecord);
      const channels = new Map(
        rawResources
          .filter((resource) => resource['resourceType'] === 'channel')
          .map((channel) => [channel['id'], channel]),
      );
      const visibleChannels = new Map<unknown, boolean>();
      const nowMs = clock.now();
      const resources: RuntimeResourceView[] = [];
      let bytes = 2;
      let evidenceComplete = totalResources <= resourceLimit;
      for (const resource of selectProjectionResources(
        raw['resources'] as unknown[],
        resourceLimit,
        this.extended,
      )) {
        if (actorId !== undefined && this.enforceViewPermissions && isRecord(resource)) {
          const channel =
            resource['resourceType'] === 'channel'
              ? resource
              : resource['resourceType'] === 'message'
                ? channels.get(resource['channel_id'])
                : undefined;
          if (channel) {
            let visible = visibleChannels.get(channel['id']);
            if (visible === undefined) {
              visible = canViewChannel(rawResources, actorId, channel, nowMs);
              visibleChannels.set(channel['id'], visible);
            }
            if (!visible) continue;
          }
        }
        if (
          isRecord(resource) &&
          resource['resourceType'] === 'message' &&
          !isPublicChannelMessage(resource, raw['resources']) &&
          !(actorId !== undefined && canViewDirectMessage(resource, raw['resources'], actorId)) &&
          !(
            actorId !== undefined &&
            resource['visibility'] === 'ephemeral' &&
            resource['recipient_id'] === actorId &&
            isRecord(resource['author']) &&
            resource['author']['bot'] === true
          )
        )
          continue;
        if (
          isRecord(resource) &&
          resource['resourceType'] === 'channel' &&
          resource['type'] === 1 &&
          (actorId === undefined || !directRecipient(resource, actorId))
        )
          continue;
        const view = projectResourceView(resource, actorId !== undefined, this.extended);
        if (view === null) continue;
        const sanitized = this.sanitize(view);
        if (!isRecord(sanitized)) return null;
        const encoded = JSON.stringify(sanitized);
        if (bytes + Buffer.byteLength(encoded) + (resources.length > 0 ? 1 : 0) > 1_048_576) {
          evidenceComplete = false;
          break;
        }
        bytes += Buffer.byteLength(encoded) + (resources.length > 0 ? 1 : 0);
        resources.push(JSON.parse(encoded) as RuntimeResourceView);
      }
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
        evidenceComplete,
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

function selectProjectionResources(
  resources: readonly unknown[],
  limit: number,
  extended: boolean,
): readonly unknown[] {
  if (!extended || resources.length <= limit) return resources.slice(0, limit);
  const structure = resources
    .filter((resource) => !isRecord(resource) || resource['resourceType'] !== 'message')
    .slice(0, limit);
  const remaining = limit - structure.length;
  if (remaining === 0) return structure;
  const messages = resources
    .flatMap((resource, index) => {
      if (!isRecord(resource) || resource['resourceType'] !== 'message') return [];
      const timestamp = resource['timestamp'];
      const parsed =
        typeof timestamp === 'string' && timestamp.length <= 64 ? Date.parse(timestamp) : NaN;
      return [{ resource, index, at: Number.isFinite(parsed) ? parsed : 0 }];
    })
    .sort((a, b) => a.at - b.at || a.index - b.index);
  return [...structure, ...messages.slice(-remaining).map(({ resource }) => resource)];
}

function projectResourceView(
  value: unknown,
  rich = false,
  extended = false,
): RuntimeResourceView | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !(
      rich
        ? ['guild', 'channel', 'user', 'message', 'role', 'member']
        : ['guild', 'channel', 'user', 'message']
    ).includes(String(value['resourceType']))
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
  if (rich && (type === 'role' || type === 'member'))
    for (const field of [
      'name',
      'guild_id',
      'user_id',
      'roles',
      'permissions',
      'position',
      'color',
    ])
      if (value[field] !== undefined) result[field] = value[field];
  if (type === 'user') copyAuthorFields(value, result);
  if (type === 'channel' && Number.isSafeInteger(value['type'])) result['type'] = value['type'];
  if (type === 'message') {
    result['visibility'] = value['visibility'] === 'ephemeral' ? 'ephemeral' : 'channel';
    if (result['visibility'] === 'ephemeral' && typeof value['recipient_id'] === 'string')
      result['visibleTo'] = value['recipient_id'];
    if (typeof value['interaction_id'] === 'string')
      result['interaction_id'] = value['interaction_id'];
    if (rich || extended) {
      const wire = projectMessageWire(value);
      for (const field of ['components', 'embeds', 'attachments'])
        if (Array.isArray(wire[field])) result[field] = wire[field];
    }
    // Only type 0 and type 20 reach this projection; the type is kept, not forced.
    result['type'] = value['type'] === 20 ? 20 : 0;
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
  excludedActorId?: string,
  membersOnly = false,
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
    .filter(
      (r) =>
        r['resourceType'] === 'user' && typeof r['id'] === 'string' && r['id'] !== excludedActorId,
    )
    .flatMap((user) => [
      ...channels
        .filter(
          (channel) =>
            !membersOnly ||
            resources.some(
              (m) =>
                m['resourceType'] === 'member' &&
                m['guild_id'] === channel['guild_id'] &&
                (m['user_id'] === user['id'] || m['id'] === user['id']),
            ),
        )
        .map((channel) => ({
          actorId: String(user['id']),
          guildId: String(channel['guild_id']),
          channelId: String(channel['id']),
        })),
      ...resources
        .filter(
          (r) =>
            r['resourceType'] === 'channel' &&
            r['type'] === 1 &&
            r['guild_id'] === undefined &&
            directRecipient(r, String(user['id'])),
        )
        .map((channel) => ({ actorId: String(user['id']), channelId: String(channel['id']) })),
    ]);
}

/**
 * Data consistency check on the full core record. An interaction message is projected only
 * with interaction origin, the kind that matches its type, an interaction ID, a matching
 * application and webhook ID and a bot author; anything else is not a channel row.
 */
function interactionRecordConsistent(message: Record<string, unknown>): boolean {
  const kind = message['interaction_message_kind'];
  const author = message['author'];
  return (
    message['message_origin'] === 'interaction' &&
    ((kind === 'original' && message['type'] === 20) ||
      (kind === 'followup' && message['type'] === 0)) &&
    isCanonicalSnowflake(message['interaction_id']) &&
    isCanonicalSnowflake(message['application_id']) &&
    message['application_id'] === message['webhook_id'] &&
    message['recipient_id'] === undefined &&
    isRecord(author) &&
    isCanonicalSnowflake(author['id']) &&
    author['bot'] === true
  );
}

function isPublicChannelMessage(
  message: Record<string, unknown>,
  resources: readonly unknown[],
): boolean {
  const interaction =
    message['message_origin'] === 'interaction' ||
    message['interaction_id'] !== undefined ||
    message['interaction_message_kind'] !== undefined ||
    message['type'] === 20;
  if (interaction ? !interactionRecordConsistent(message) : message['type'] !== 0) return false;
  if (
    message['visibility'] !== 'channel' ||
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

function directRecipient(channel: Readonly<Record<string, unknown>>, actorId: string): boolean {
  return (
    Array.isArray(channel['recipients']) &&
    channel['recipients'].some((recipient) => isRecord(recipient) && recipient['id'] === actorId)
  );
}
function canViewDirectMessage(
  message: Record<string, unknown>,
  resources: readonly unknown[],
  actorId: string,
): boolean {
  const channel = resources.find(
    (r) => isRecord(r) && r['resourceType'] === 'channel' && r['id'] === message['channel_id'],
  );
  return (
    isRecord(channel) &&
    channel['type'] === 1 &&
    channel['guild_id'] === undefined &&
    directRecipient(channel, actorId) &&
    message['guild_id'] === undefined &&
    (message['visibility'] !== 'ephemeral' || message['recipient_id'] === actorId)
  );
}
