import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createConnection, createServer } from 'node:net';

import { createWebhookPeerSecret } from './interaction-peer-auth.cjs';
import {
  INTERACTION_TIMEOUT_MS,
  sendSignedInteraction,
  WebhookPeerAuthenticationError,
} from './interaction-transport.cjs';
import { loadProjectConfiguration, type ResolvedProjectConfiguration } from './project-config.cjs';
import {
  emptyRuntimeState,
  type DesktopRuntimeState,
  type RuntimeEndpoints,
  type RuntimeInvocationResult,
  type RuntimeOutputEntry,
  type RuntimeRiskEntry,
  type RuntimeTraceEntry,
} from './runtime-contract.cjs';

const CORE_SPECIFIER: string = '@disrunner/core';
const MAX_RENDERER_OUTPUT = 200;
const MAX_RENDERER_OUTPUT_BYTES = 1_048_576;
const MAX_RENDERER_OUTPUT_ENTRY_BYTES = 32_768;
const MAX_RENDERER_TRACES = 100;
const MAX_RENDERER_RISKS = 100;
const MAX_INTERACTION_INPUT_BYTES = 2_000;

interface BotSnapshotLike {
  readonly status: string;
  readonly pid?: number;
}

interface BotRunnerLike {
  start(config: Readonly<Record<string, unknown>>): Promise<BotSnapshotLike>;
  stop(graceMs?: number): Promise<BotSnapshotLike>;
  snapshot(): BotSnapshotLike;
}

interface RestServerLike {
  start(port?: number): Promise<unknown>;
  stop(): Promise<void>;
}

interface GatewayServerLike {
  readonly address?: unknown;
  start(port?: number): Promise<unknown>;
  stop(): Promise<void>;
}

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
  #state: DesktopRuntimeState = emptyRuntimeState();
  #selectedRoot: string | null = null;
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

  public constructor(onState: StateListener, onEndpoints: EndpointListener) {
    this.#onState = onState;
    this.#onEndpoints = onEndpoints;
  }

  public snapshot(): DesktopRuntimeState {
    return structuredClone(this.#state);
  }

  public async selectProject(directory: string): Promise<DesktopRuntimeState> {
    if (['starting', 'running', 'stopping'].includes(this.#state.phase)) {
      return this.#setError('Stop the active bot before selecting another project.');
    }
    try {
      const project = await loadProjectConfiguration(directory);
      this.#selectedRoot = project.summary.root;
      this.#publish({
        ...emptyRuntimeState(),
        phase: 'ready',
        project: project.summary,
      });
    } catch (error) {
      this.#selectedRoot = null;
      this.#publish({
        ...emptyRuntimeState(),
        phase: 'error',
        error: errorMessage(error),
      });
    }
    return this.snapshot();
  }

  public async start(): Promise<DesktopRuntimeState> {
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#stopPromise !== null) await this.#stopPromise;
    const operation = this.#startInternal();
    this.#startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#startPromise === operation) this.#startPromise = null;
    }
  }

  async #startInternal(): Promise<DesktopRuntimeState> {
    if (this.#state.phase === 'running' || this.#state.phase === 'starting') return this.snapshot();
    if (this.#state.phase === 'stopping')
      return this.#setError('The current bot is still stopping.');
    if (this.#selectedRoot === null)
      return this.#setError('Select a valid bot project before starting.');

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
      configuration = await loadProjectConfiguration(this.#selectedRoot);
      this.#publish({ ...this.#state, project: configuration.summary });
      const core = await loadCore();
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
      const trace = new core.TraceCollector({ clock, random });
      const risks = new core.RiskCollector(clock);
      const state = new core.VirtualState(clock, snowflakes, configuration.resources);
      const interactions = new core.InteractionEngine({
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
      const expectedGatewayUrl = `ws://127.0.0.1:${gatewayPort}/gateway`;
      const gateway = new core.GatewayEmulator({
        clock,
        random,
        snowflakes,
        fakeToken: sessionToken,
        resumeGatewayUrl: expectedGatewayUrl,
      });
      const gatewayServer = new GatewayServer({ gateway, trace });
      this.#gatewayServer = gatewayServer;
      const gatewayStartResult = await gatewayServer.start(gatewayPort);
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
        interactions,
        gateway,
        rateLimits,
        fakeToken: sessionToken,
        gatewayUrl,
        mode: configuration.profile.mode,
        trace,
      });
      this.#rest = rest;
      const restAddress = requireRestAddress(await rest.start(0));
      const interactionEndpoint = await resolveInteractionEndpoint(
        configuration.adapter.interactionEndpoint,
      );
      this.#interactionEndpoint = interactionEndpoint ?? null;
      const endpoints: RuntimeEndpoints = {
        restBaseUrl: restAddress.apiBaseUrl,
        gatewayUrl,
        ...(interactionEndpoint === undefined ? {} : { interactionEndpoint }),
      };
      this.#onEndpoints(endpoints);

      const output: RuntimeOutputEntry[] = [];
      let outputBytes = 0;
      const bot = new core.BotRunner({
        maxOutputEntries: MAX_RENDERER_OUTPUT,
        maxOutputBytes: MAX_RENDERER_OUTPUT_BYTES,
        maxOutputLineBytes: 65_536,
        onOutput: (entry: unknown) => {
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
      const activeGatewayPort = new URL(gatewayUrl).port;
      const restPort = new URL(restAddress.baseUrl).port;
      const interactionPort =
        interactionEndpoint === undefined ? '' : new URL(interactionEndpoint).port;
      const processSnapshot = await bot.start({
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
      if (interactionEndpoint !== undefined) {
        await waitForLoopbackEndpoint(interactionEndpoint, 10_000);
        if (interactionCredentials !== null) {
          if (this.#interactionPrivateKey === null)
            throw new Error('Interaction signing key was not retained.');
          if (this.#interactionPeerSecret === null)
            throw new Error('Interaction peer secret was not retained.');
          await verifySignedPing(
            interactionEndpoint,
            this.#interactionPrivateKey,
            this.#interactionPeerSecret,
          );
        }
      }
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
      this.#startPolling();
    } catch (error) {
      const rawFailure = errorMessage(error);
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
    return this.snapshot();
  }

  public async stop(): Promise<DesktopRuntimeState> {
    if (this.#startPromise !== null) await this.#startPromise;
    if (this.#stopPromise !== null) return this.#stopPromise;
    const operation = this.#stopInternal();
    this.#stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#stopPromise === operation) this.#stopPromise = null;
    }
  }

  async #stopInternal(): Promise<DesktopRuntimeState> {
    if (this.#state.phase === 'stopping') return this.snapshot();
    const active = this.#bot !== null || this.#rest !== null || this.#gatewayServer !== null;
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

  public async invoke(input: string): Promise<RuntimeInvocationResult> {
    const startedAtMs = Date.now();
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
      const argumentText = normalized.slice(commandToken.length).trim();
      const created = this.#interactions.create({
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
        ...(this.#interactionContext.guildId === undefined
          ? {}
          : { guild_id: this.#interactionContext.guildId }),
        ...(this.#interactionContext.channelId === undefined
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
      );
      const normalizedCallback = normalizeInteractionCallback(callback);
      this.#interactions.respond(interactionId, normalizedCallback.type, normalizedCallback.data);
      this.#trace.end(span, 'ok', { callbackType: normalizedCallback.type });
      this.#refreshEvidence();
      return this.#invocationResult({
        ok: true,
        command: commandName,
        interactionId,
        durationMs: Date.now() - startedAtMs,
        response: normalizedCallback,
        error: null,
      });
    } catch (error) {
      if (interactionId !== null) this.#interactions.get(interactionId);
      const timedOut = isTimeoutError(error);
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
          ? `/${commandName} did not return a callback within ${INTERACTION_TIMEOUT_MS} ms.`
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
      return this.#invocationResult({
        ok: false,
        command: commandName,
        interactionId,
        durationMs: Date.now() - startedAtMs,
        response: null,
        error: timedOut
          ? `Bot interaction timed out after ${INTERACTION_TIMEOUT_MS} ms.`
          : errorMessage(error),
      });
    }
  }

  #invocationResult(result: RuntimeInvocationResult): RuntimeInvocationResult {
    const sanitized = this.#sanitizeForExport?.(result);
    return isInvocationResult(sanitized)
      ? sanitized
      : { ...result, error: result.error === null ? null : redactText(result.error) };
  }

  #refreshEvidence(): void {
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
            if (processSnapshot.status === 'crashed') {
              this.#publish({
                ...this.#state,
                phase: 'error',
                error: 'Bot process exited unexpectedly.',
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
    const operation = this.#cleanupInternal();
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
    this.#bot = null;
    this.#rest = null;
    this.#gatewayServer = null;
    this.#trace = null;
    this.#risks = null;
    this.#interactionPrivateKey = null;
    this.#interactionPeerSecret = null;
    this.#interactionEndpoint = null;
    this.#applicationId = null;
    this.#interactionContext = null;
    this.#interactions = null;
    this.#sanitizeForExport = null;
    this.#onEndpoints(null);
    const errors: string[] = [];
    if (bot !== null) {
      try {
        await bot.stop(5_000);
      } catch (error) {
        errors.push(`bot: ${errorMessage(error)}`);
      }
    }
    if (rest !== null) {
      try {
        await rest.stop();
      } catch (error) {
        errors.push(`REST: ${errorMessage(error)}`);
      }
    }
    if (gatewayServer !== null) {
      try {
        await gatewayServer.stop();
      } catch (error) {
        errors.push(`Gateway: ${errorMessage(error)}`);
      }
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
  }

  #publish(state: DesktopRuntimeState): void {
    const sanitized = this.#sanitizeForExport?.(state);
    this.#state = structuredClone(isRuntimeState(sanitized) ? sanitized : state);
    this.#onState(this.snapshot());
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

async function waitForLoopbackEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
  const parsed = new URL(endpoint);
  const port = Number(parsed.port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(parsed.hostname, port)) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Bot interaction endpoint did not become ready within ${timeoutMs} ms.`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (connected: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(connected);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
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
): Promise<void> {
  const payload = await sendSignedInteraction(endpoint, privateKey, peerSecretHex, { type: 1 });
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
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
