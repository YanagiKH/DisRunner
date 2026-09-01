import { parse as parseYaml } from 'yaml';

import { VirtualClock } from './clock.js';
import type {
  DiscordResourceType,
  GatewayDispatch,
  ResourceRecord,
  ScenarioAction,
  ScenarioAssertion,
  ScenarioAssertionResult,
  ScenarioDefinition,
  ScenarioRunResult,
  SimulationProfile,
} from './contracts.js';
import { GatewayEmulator } from './gateway.js';
import { GatewayIntents } from './intents.js';
import { DiscordApiError, InteractionEngine } from './interactions.js';
import { calculatePermissions, Permissions, type PermissionRole } from './permissions.js';
import { SeededRandom, SnowflakeGenerator } from './random.js';
import { RateLimitEngine } from './rate-limits.js';
import { containsLikelySecret } from './redaction.js';
import { createOfflineSessionToken } from './session-token.js';
import { VirtualState } from './state.js';
import { RiskCollector, TraceCollector } from './trace.js';

const DEFAULT_START_TIME_MS = Date.parse('2026-01-01T00:00:00.000Z');

export interface ScenarioRunnerOptions {
  readonly profile?: Partial<SimulationProfile>;
  readonly state?: VirtualState;
  readonly startTimeMs?: number;
  readonly limits?: Partial<ScenarioLimits>;
}

export interface ScenarioLimits {
  readonly maxInputBytes: number;
  readonly maxActions: number;
  readonly maxRepeat: number;
  readonly maxResources: number;
  readonly maxAssertions: number;
  readonly maxEvents: number;
  readonly maxEventBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxYamlAliases: number;
}

export const DEFAULT_SCENARIO_LIMITS: ScenarioLimits = {
  maxInputBytes: 1_048_576,
  maxActions: 10_000,
  maxRepeat: 1_000,
  maxResources: 10_000,
  maxAssertions: 10_000,
  maxEvents: 50_000,
  maxEventBytes: 67_108_864,
  maxDepth: 64,
  maxNodes: 100_000,
  maxYamlAliases: 100,
};

export interface ScenarioParseOptions {
  readonly limits?: Partial<ScenarioLimits>;
}

export interface ScenarioRunOptions {
  readonly signal?: AbortSignal;
}

interface InteractionObservation {
  readonly id: string;
  readonly command: string;
  readonly createdAtMs: number;
  acknowledgedAtMs?: number;
}

export function createSimulationProfile(
  overrides: Partial<SimulationProfile> = {},
): SimulationProfile {
  if (overrides.apiVersion !== undefined && overrides.apiVersion !== 10) {
    throw new RangeError('This DisRunner build supports Discord API version 10.');
  }
  if (overrides.interactionDeadlineMs !== undefined && overrides.interactionDeadlineMs !== 3_000) {
    throw new RangeError('Discord interaction initial response deadline is fixed at 3,000 ms.');
  }
  if (
    overrides.interactionTokenTtlMs !== undefined &&
    overrides.interactionTokenTtlMs !== 900_000
  ) {
    throw new RangeError('Discord interaction token lifetime is fixed at 900,000 ms.');
  }
  if (overrides.networkPolicy !== undefined && overrides.networkPolicy !== 'offline') {
    throw new RangeError('Only the offline network policy is supported.');
  }
  const seed = overrides.seed ?? 1;
  if (!Number.isSafeInteger(seed)) throw new RangeError('Simulation seed must be a safe integer.');
  return {
    seed,
    mode: overrides.mode ?? 'strict',
    apiVersion: 10,
    interactionDeadlineMs: 3_000,
    interactionTokenTtlMs: 900_000,
    networkPolicy: 'offline',
  };
}

export function parseScenario(
  input: string | ScenarioDefinition,
  options: ScenarioParseOptions = {},
): ScenarioDefinition {
  const limits = resolveScenarioLimits(options.limits);
  if (typeof input === 'string' && Buffer.byteLength(input) > limits.maxInputBytes)
    throw new RangeError('Scenario input exceeds maxInputBytes.');
  const raw =
    typeof input === 'string'
      ? (parseYaml(input, { maxAliasCount: limits.maxYamlAliases }) as unknown)
      : input;
  validateValueBudget(raw, limits);
  if (!isRecord(raw)) throw new TypeError('Scenario must be a YAML or JSON object.');
  const version = raw['version'] ?? 1;
  if (version !== 1)
    throw new RangeError(`Unsupported scenario version: ${displayValue(version)}.`);
  const name = requireString(raw['name'], 'Scenario name');
  const seed = optionalSafeInteger(raw['seed'], 'Scenario seed');
  const mode = raw['mode'];
  if (mode !== undefined && mode !== 'strict' && mode !== 'lenient') {
    throw new TypeError('Scenario mode must be strict or lenient.');
  }
  const actionSource = raw['steps'] ?? raw['actions'];
  if (!Array.isArray(actionSource))
    throw new TypeError('Scenario must contain a steps or actions array.');
  if (actionSource.length > limits.maxActions)
    throw new RangeError('Scenario has too many actions.');
  const initialState = normalizeInitialState(raw['initialState']);
  const assertions = normalizeAssertions(raw['assertions']);
  if (initialState.length > limits.maxResources)
    throw new RangeError('Scenario has too many resources.');
  if (assertions.length > limits.maxAssertions)
    throw new RangeError('Scenario has too many assertions.');
  const steps = actionSource.map((action) => normalizeAction(action, limits));
  const expandedActions = steps.reduce(
    (total, action) => total + (action.type === 'timeline-rest-request' ? (action.repeat ?? 1) : 1),
    0,
  );
  if (expandedActions > limits.maxActions)
    throw new RangeError('Scenario expands to too many actions.');
  return {
    version: 1,
    name,
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
    ...(Array.isArray(raw['tags'])
      ? { tags: raw['tags'].map((tag) => requireString(tag, 'Scenario tag')) }
      : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(mode === undefined ? {} : { mode }),
    ...(initialState.length === 0 ? {} : { initialState }),
    steps,
    ...(assertions.length === 0 ? {} : { assertions }),
  };
}

export class ScenarioRunner {
  readonly #profileOverrides: Partial<SimulationProfile>;
  readonly #baseResources: readonly ResourceRecord[];
  readonly #startTimeMs: number;
  readonly #limits: ScenarioLimits;

  public constructor(options: ScenarioRunnerOptions = {}) {
    this.#profileOverrides = options.profile ?? {};
    this.#baseResources = options.state?.snapshot().resources ?? [];
    this.#startTimeMs = options.startTimeMs ?? DEFAULT_START_TIME_MS;
    this.#limits = resolveScenarioLimits(options.limits);
    if (this.#baseResources.length > this.#limits.maxResources)
      throw new RangeError('Base state has too many resources.');
    if (!Number.isFinite(this.#startTimeMs) || this.#startTimeMs < 0) {
      throw new RangeError('Scenario start time must be a non-negative finite timestamp.');
    }
  }

  public async run(
    input: string | ScenarioDefinition,
    options: ScenarioRunOptions = {},
  ): Promise<ScenarioRunResult> {
    await Promise.resolve();
    const scenario = parseScenario(input, { limits: this.#limits });
    const profile = createSimulationProfile({
      ...(scenario.seed === undefined ? {} : { seed: scenario.seed }),
      ...(scenario.mode === undefined ? {} : { mode: scenario.mode }),
      ...this.#profileOverrides,
    });
    const clock = new VirtualClock({ nowMs: this.#startTimeMs, mode: 'paused' });
    const random = new SeededRandom(profile.seed);
    const snowflakes = new SnowflakeGenerator(clock, {
      workerId: profile.seed & 31,
      processId: (profile.seed >>> 5) & 31,
    });
    const runId = snowflakes.generate();
    const state = new VirtualState(clock, snowflakes, this.#baseResources);
    const risks = new RiskCollector(clock);
    const trace = new TraceCollector({ clock, random });
    const interactions = new InteractionEngine({
      clock,
      random,
      snowflakes,
      profile,
      onRisk: (finding) => void risks.add(finding),
    });
    const rateLimits = new RateLimitEngine(clock, [
      {
        id: 'messages:create',
        method: 'POST',
        route: '/channels/:channelId/messages',
        limit: 5,
        windowMs: 5_000,
        scope: 'shared',
        majorParameters: ['channelId'],
      },
    ]);
    const fakeToken = createOfflineSessionToken();
    const gateway = new GatewayEmulator({
      clock,
      random,
      snowflakes,
      fakeToken,
      portalEnabledPrivilegedIntents: 0n,
    });
    const identify = gateway.identify({
      token: `Bot ${fakeToken}`,
      intents:
        GatewayIntents.GUILDS | GatewayIntents.GUILD_MESSAGES | GatewayIntents.DIRECT_MESSAGES,
    });
    const gatewaySessionId = identify.sessionId;
    let resumeSequence = identify.ready.s;
    let gatewayResumed = false;
    const events: GatewayDispatch[] = [identify.ready];
    let retainedEventBytes = serializedBytes(identify.ready);
    if (retainedEventBytes > this.#limits.maxEventBytes) {
      throw new RangeError('Initial Gateway event exceeds maxEventBytes.');
    }
    const variables = new Map<string, string>();
    const interactionObservations = new Map<string, InteractionObservation>();
    let lastScheduledAtMs = clock.now();
    let resourceCount = this.#baseResources.length;

    state.transaction('scenario-initial-state', () => {
      for (const resource of scenario.initialState ?? []) {
        assertResourceCapacity(resourceCount, this.#limits.maxResources);
        const { resourceType, ...data } = resource;
        state.create(resourceType, data);
        resourceCount += 1;
      }
    });

    for (const rawAction of scenario.steps) {
      throwIfAborted(options.signal);
      const action = resolveAction(rawAction, variables);
      const timelineAt = actionTimelineAt(action);
      if (timelineAt !== undefined) {
        const target = this.#startTimeMs + timelineAt;
        if (target > clock.now()) clock.set(target);
      }
      switch (action.type) {
        case 'advance-time':
          clock.advanceBy(action.ms);
          break;
        case 'create-resource': {
          assertResourceCapacity(resourceCount, this.#limits.maxResources);
          const created = state.create(action.resourceType, action.data);
          resourceCount += 1;
          if (action.saveAs !== undefined) variables.set(action.saveAs, created.id);
          break;
        }
        case 'update-resource':
          state.update(action.resourceType, action.id, action.changes);
          break;
        case 'delete-resource':
          state.delete(action.resourceType, action.id);
          resourceCount -= 1;
          break;
        case 'send-message': {
          assertResourceCapacity(resourceCount, this.#limits.maxResources);
          const message = state.create('message', {
            channel_id: action.channelId,
            author: { id: action.authorId },
            content: action.content,
            timestamp: new Date(clock.now()).toISOString(),
          });
          resourceCount += 1;
          if (action.saveAs !== undefined) variables.set(action.saveAs, message.id);
          const event = gateway.dispatch(
            gatewaySessionId,
            'MESSAGE_CREATE',
            stripResourceType(message),
          );
          if (event !== undefined) {
            retainedEventBytes = appendEvents(
              events,
              [event],
              this.#limits.maxEvents,
              this.#limits.maxEventBytes,
              retainedEventBytes,
            );
          }
          break;
        }
        case 'gateway-dispatch': {
          const event = gateway.dispatch(gatewaySessionId, action.event, action.data);
          if (event !== undefined) {
            retainedEventBytes = appendEvents(
              events,
              [event],
              this.#limits.maxEvents,
              this.#limits.maxEventBytes,
              retainedEventBytes,
            );
          }
          break;
        }
        case 'gateway-disconnect':
          resumeSequence = gateway.session(gatewaySessionId)?.sequence ?? resumeSequence;
          gateway.disconnect(gatewaySessionId);
          break;
        case 'gateway-resume': {
          const resumed = gateway.resume(
            gatewaySessionId,
            `Bot ${fakeToken}`,
            action.sequence ?? resumeSequence,
          );
          if (!resumed.accepted || resumed.resumed === undefined)
            throw new Error('Gateway resume was rejected.');
          retainedEventBytes = appendEvents(
            events,
            [...resumed.replayed, resumed.resumed],
            this.#limits.maxEvents,
            this.#limits.maxEventBytes,
            retainedEventBytes,
          );
          gatewayResumed = true;
          break;
        }
        case 'interaction-create': {
          const interaction = interactions.create({
            ...(action.interactionType === undefined ? {} : { type: action.interactionType }),
            ...(action.data === undefined ? {} : { data: action.data }),
          });
          if (action.saveAs !== undefined) variables.set(action.saveAs, interaction.id);
          break;
        }
        case 'interaction-respond':
          interactions.respond(action.interactionId, action.responseType, action.data ?? {});
          break;
        case 'interaction-followup':
          interactions.followup(action.interactionId, action.data ?? {});
          break;
        case 'rate-limit-request':
          executeRateLimit(action.method, action.path, rateLimits, risks, trace, clock);
          break;
        case 'timeline-interaction': {
          const interactionSpan = trace.start('interaction', `/${action.command}`, {
            command: action.command,
          });
          const interaction = interactions.create({
            type: 'command',
            data: { name: action.command },
          });
          const observation: InteractionObservation = {
            id: interaction.id,
            command: action.command,
            createdAtMs: interaction.createdAtMs,
          };
          interactionObservations.set(action.command, observation);
          lastScheduledAtMs = Math.max(
            lastScheduledAtMs,
            interaction.createdAtMs + action.acknowledgeAfterMs,
          );
          clock.schedule(action.acknowledgeAfterMs, () => {
            try {
              const responseType = action.followUpAfterMs === undefined ? 'message' : 'defer';
              interactions.respond(interaction.id, responseType, { content: `/${action.command}` });
              observation.acknowledgedAtMs = clock.now();
              trace.end(interactionSpan, 'ok', { acknowledgedAtMs: clock.now() });
            } catch (error) {
              trace.end(interactionSpan, 'error', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
          if (action.followUpAfterMs !== undefined) {
            lastScheduledAtMs = Math.max(
              lastScheduledAtMs,
              interaction.createdAtMs + action.followUpAfterMs,
            );
            clock.schedule(action.followUpAfterMs, () => {
              try {
                interactions.followup(interaction.id, { content: `/${action.command} completed` });
              } catch (error) {
                if (!(error instanceof DiscordApiError)) throw error;
              }
            });
          }
          break;
        }
        case 'timeline-gateway-disconnect':
          resumeSequence = gateway.session(gatewaySessionId)?.sequence ?? resumeSequence;
          if (action.resumable === false) gateway.invalidate(gatewaySessionId, false);
          else gateway.disconnect(gatewaySessionId);
          break;
        case 'timeline-gateway-resume': {
          const resumed = gateway.resume(gatewaySessionId, `Bot ${fakeToken}`, resumeSequence);
          if (resumed.accepted && resumed.resumed !== undefined) {
            retainedEventBytes = appendEvents(
              events,
              [...resumed.replayed, resumed.resumed],
              this.#limits.maxEvents,
              this.#limits.maxEventBytes,
              retainedEventBytes,
            );
            gatewayResumed = true;
          }
          break;
        }
        case 'timeline-permission-check': {
          executePermissionCheck(action.permission, action.expected, state, risks, trace, clock);
          break;
        }
        case 'timeline-rest-request':
          for (let index = 0; index < (action.repeat ?? 1); index += 1) {
            throwIfAborted(options.signal);
            executeRateLimit(action.method, action.path, rateLimits, risks, trace, clock);
            if ((index & 63) === 63)
              await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
          }
          break;
      }
    }

    if (lastScheduledAtMs > clock.now()) clock.set(lastScheduledAtMs);
    interactions.sweepExpired();
    risks.analyzeSpans(trace.spans());
    const finalState = state.snapshot();
    const assertions = (scenario.assertions ?? []).map((assertion) =>
      evaluateAssertion(
        assertion,
        state,
        interactions,
        interactionObservations,
        events,
        risks,
        trace,
        gatewayResumed,
        finalState.hash,
        variables,
        scenario.assertions ?? [],
        {
          runId,
          seed: profile.seed,
          startedAt: new Date(this.#startTimeMs).toISOString(),
          scenario: scenario.name,
          mode: profile.mode,
          apiVersion: profile.apiVersion,
          networkPolicy: profile.networkPolicy,
        },
      ),
    );
    const passed = assertions.every((assertion) => assertion.passed);
    const spans = trace.spans();
    const findings = risks.all();
    return {
      report: {
        runId,
        seed: profile.seed,
        startedAt: new Date(this.#startTimeMs).toISOString(),
        passed,
        spans,
        risks: findings,
        stateHash: finalState.hash,
        status: passed ? (findings.length === 0 ? 'passed' : 'warning') : 'failed',
        assertions,
        metadata: {
          scenario: scenario.name,
          mode: profile.mode,
          apiVersion: profile.apiVersion,
          networkPolicy: profile.networkPolicy,
        },
      },
      assertions,
      finalState,
      events,
    };
  }
}

export async function runScenario(
  input: string | ScenarioDefinition,
  options: ScenarioRunnerOptions & ScenarioRunOptions = {},
): Promise<ScenarioRunResult> {
  const runner = new ScenarioRunner(options);
  return runner.run(input, options);
}

function normalizeInitialState(value: unknown): readonly (Readonly<Record<string, unknown>> & {
  readonly resourceType: DiscordResourceType;
})[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((resource) => {
      if (!isRecord(resource)) throw new TypeError('Initial state resources must be objects.');
      const resourceType = requireString(resource['resourceType'], 'Initial resource type');
      return { ...normalizeResourceFields(resource), resourceType };
    });
  }
  if (!isRecord(value))
    throw new TypeError('Initial state must be an array or resource collection object.');
  const resources: (Readonly<Record<string, unknown>> & {
    readonly resourceType: DiscordResourceType;
  })[] = [];
  for (const [collection, entries] of Object.entries(value)) {
    if (!Array.isArray(entries))
      throw new TypeError(`Initial state collection ${collection} must be an array.`);
    const resourceType = collectionResourceType(collection);
    for (const entry of entries) {
      if (!isRecord(entry))
        throw new TypeError(`Initial state ${collection} entries must be objects.`);
      resources.push({ ...normalizeResourceFields(entry), resourceType });
    }
  }
  return resources;
}

function normalizeAction(
  value: unknown,
  limits: ScenarioLimits = DEFAULT_SCENARIO_LIMITS,
): ScenarioAction {
  if (!isRecord(value)) throw new TypeError('Scenario action must be an object.');
  if (value['advance'] !== undefined) {
    return { type: 'advance-time', ms: parseDuration(value['advance']) };
  }
  const type = requireString(value['type'] ?? value['action'], 'Scenario action type');
  const at = optionalNonNegativeNumber(value['at'], 'Action time');
  if (type === 'interaction') {
    return {
      type: 'timeline-interaction',
      at: at ?? 0,
      command: requireString(value['command'], 'Interaction command').replace(/^\//, ''),
      acknowledgeAfterMs: requireNonNegativeNumber(
        value['acknowledgeAfterMs'],
        'Interaction acknowledge delay',
      ),
      ...(value['followUpAfterMs'] === undefined
        ? {}
        : {
            followUpAfterMs: requireNonNegativeNumber(
              value['followUpAfterMs'],
              'Interaction follow-up delay',
            ),
          }),
    };
  }
  if (type === 'permission-check') {
    const expected = value['expected'];
    if (expected !== undefined && expected !== 'allowed' && expected !== 'denied') {
      throw new TypeError('Permission expectation must be allowed or denied.');
    }
    return {
      type: 'timeline-permission-check',
      at: at ?? 0,
      permission: requireString(value['permission'], 'Permission name'),
      ...(expected === undefined ? {} : { expected }),
    };
  }
  if (type === 'rest-request') {
    const route = requireString(value['route'], 'REST route');
    const match = /^(\S+)\s+(.+)$/.exec(route);
    if (match === null) throw new TypeError('REST route must contain method and path.');
    return {
      type: 'timeline-rest-request',
      at: at ?? 0,
      method: (match[1] as string).toUpperCase(),
      path: match[2] as string,
      ...(value['repeat'] === undefined
        ? {}
        : { repeat: requireLimitedRepeat(value['repeat'], limits) }),
    };
  }
  if (type === 'gateway-disconnect' && at !== undefined) {
    return {
      type: 'timeline-gateway-disconnect',
      at,
      ...(typeof value['resumable'] === 'boolean' ? { resumable: value['resumable'] } : {}),
    };
  }
  if (type === 'gateway-resume' && at !== undefined) return { type: 'timeline-gateway-resume', at };
  switch (type) {
    case 'timeline-interaction':
      return {
        type,
        at: requireNonNegativeNumber(value['at'], 'Action time'),
        command: requireString(value['command'], 'Interaction command').replace(/^\//, ''),
        acknowledgeAfterMs: requireNonNegativeNumber(
          value['acknowledgeAfterMs'],
          'Interaction acknowledge delay',
        ),
        ...(value['followUpAfterMs'] === undefined
          ? {}
          : {
              followUpAfterMs: requireNonNegativeNumber(
                value['followUpAfterMs'],
                'Interaction follow-up delay',
              ),
            }),
      };
    case 'timeline-gateway-disconnect':
      return {
        type,
        at: requireNonNegativeNumber(value['at'], 'Action time'),
        ...(typeof value['resumable'] === 'boolean' ? { resumable: value['resumable'] } : {}),
      };
    case 'timeline-gateway-resume':
      return { type, at: requireNonNegativeNumber(value['at'], 'Action time') };
    case 'timeline-permission-check': {
      const expected = value['expected'];
      if (expected !== undefined && expected !== 'allowed' && expected !== 'denied') {
        throw new TypeError('Permission expectation must be allowed or denied.');
      }
      return {
        type,
        at: requireNonNegativeNumber(value['at'], 'Action time'),
        permission: requireString(value['permission'], 'Permission name'),
        ...(expected === undefined ? {} : { expected }),
      };
    }
    case 'timeline-rest-request':
      return {
        type,
        at: requireNonNegativeNumber(value['at'], 'Action time'),
        method: requireString(value['method'], 'REST method').toUpperCase(),
        path: requireString(value['path'], 'REST path'),
        ...(value['repeat'] === undefined
          ? {}
          : { repeat: requireLimitedRepeat(value['repeat'], limits) }),
      };
    case 'advance-time':
      return { type, ms: requireNonNegativeNumber(value['ms'], 'Advance duration') };
    case 'create-resource':
      return {
        type,
        resourceType: requireString(value['resourceType'], 'Resource type'),
        data: requireRecord(value['data'], 'Resource data'),
        ...(typeof value['saveAs'] === 'string' ? { saveAs: value['saveAs'] } : {}),
      };
    case 'update-resource':
      return {
        type,
        resourceType: requireString(value['resourceType'], 'Resource type'),
        id: requireString(value['id'], 'Resource id'),
        changes: requireRecord(value['changes'], 'Resource changes'),
      };
    case 'delete-resource':
      return {
        type,
        resourceType: requireString(value['resourceType'], 'Resource type'),
        id: requireString(value['id'], 'Resource id'),
      };
    case 'send-message':
      return {
        type,
        channelId: requireString(value['channelId'], 'Channel id'),
        authorId: requireString(value['authorId'], 'Author id'),
        content: requireString(value['content'], 'Message content'),
        ...(typeof value['saveAs'] === 'string' ? { saveAs: value['saveAs'] } : {}),
      };
    case 'gateway-dispatch':
      return {
        type,
        event: requireString(value['event'], 'Gateway event'),
        data: structuredClone(value['data']),
      };
    case 'gateway-disconnect':
      return { type };
    case 'gateway-resume':
      return {
        type,
        ...(value['sequence'] === undefined
          ? {}
          : { sequence: requireNonNegativeNumber(value['sequence'], 'Gateway sequence') }),
      };
    case 'interaction-create':
      return {
        type,
        ...(typeof value['interactionType'] === 'string'
          ? { interactionType: value['interactionType'] }
          : {}),
        ...(isRecord(value['data']) ? { data: value['data'] } : {}),
        ...(typeof value['saveAs'] === 'string' ? { saveAs: value['saveAs'] } : {}),
      };
    case 'interaction-respond': {
      const responseType = value['responseType'];
      if (
        !['message', 'defer', 'update', 'defer-update', 'autocomplete', 'modal'].includes(
          String(responseType),
        )
      ) {
        throw new TypeError('Invalid interaction response type.');
      }
      return {
        type,
        interactionId: requireString(value['interactionId'], 'Interaction id'),
        responseType: responseType as
          'message' | 'defer' | 'update' | 'defer-update' | 'autocomplete' | 'modal',
        ...(isRecord(value['data']) ? { data: value['data'] } : {}),
      };
    }
    case 'interaction-followup':
      return {
        type,
        interactionId: requireString(value['interactionId'], 'Interaction id'),
        ...(isRecord(value['data']) ? { data: value['data'] } : {}),
      };
    case 'rate-limit-request':
      return {
        type,
        method: requireString(value['method'], 'REST method').toUpperCase(),
        path: requireString(value['path'], 'REST path'),
      };
    default:
      throw new TypeError(`Unsupported scenario action type: ${type}.`);
  }
}

function normalizeAssertions(value: unknown): readonly ScenarioAssertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Scenario assertions must be an array.');
  return value.map((raw) => {
    if (!isRecord(raw)) throw new TypeError('Scenario assertion must be an object.');
    const type = requireString(raw['type'], 'Scenario assertion type');
    switch (type) {
      case 'resource-exists':
        return {
          type,
          resourceType: requireString(raw['resourceType'], 'Resource type'),
          id: requireString(raw['id'], 'Resource id'),
        };
      case 'resource-field-equals':
        return {
          type,
          resourceType: requireString(raw['resourceType'], 'Resource type'),
          id: requireString(raw['id'], 'Resource id'),
          field: requireString(raw['field'], 'Resource field'),
          expected: structuredClone(raw['expected']),
        };
      case 'event-received':
        return {
          type,
          event: requireString(raw['event'], 'Gateway event'),
          ...(raw['count'] === undefined
            ? {}
            : { count: requireNonNegativeNumber(raw['count'], 'Event count') }),
        };
      case 'risk-present':
      case 'risk-absent':
      case 'risk-detected':
        return { type, ruleId: requireString(raw['ruleId'], 'Risk rule id') };
      case 'interaction-state':
        return {
          type,
          interactionId: requireString(raw['interactionId'], 'Interaction id'),
          state: requireString(raw['state'], 'Interaction state'),
        };
      case 'state-hash':
        return { type, expected: requireString(raw['expected'], 'Expected state hash') };
      case 'interaction-acknowledged':
        return {
          type,
          command: requireString(raw['command'], 'Interaction command').replace(/^\//, ''),
          ...(raw['withinMs'] === undefined
            ? {}
            : { withinMs: requireNonNegativeNumber(raw['withinMs'], 'Acknowledgement deadline') }),
        };
      case 'gateway-resumed':
      case 'no-secret-leak':
        return { type };
      default:
        throw new TypeError(`Unsupported scenario assertion type: ${type}.`);
    }
  });
}

function evaluateAssertion(
  rawAssertion: ScenarioAssertion,
  state: VirtualState,
  interactions: InteractionEngine,
  observations: ReadonlyMap<string, InteractionObservation>,
  events: readonly GatewayDispatch[],
  risks: RiskCollector,
  trace: TraceCollector,
  gatewayResumed: boolean,
  stateHash: string,
  variables: ReadonlyMap<string, string>,
  allAssertions: readonly ScenarioAssertion[],
  runMetadata: Readonly<Record<string, unknown>>,
): ScenarioAssertionResult {
  const assertion = resolveAssertion(rawAssertion, variables);
  let passed = false;
  let actual: unknown;
  let description: string = assertion.type;
  switch (assertion.type) {
    case 'resource-exists':
      actual = state.get(assertion.resourceType, assertion.id) !== undefined;
      passed = actual === true;
      description = `${assertion.resourceType}/${assertion.id} exists`;
      break;
    case 'resource-field-equals': {
      actual = getPath(state.get(assertion.resourceType, assertion.id), assertion.field);
      passed = deepEqual(actual, assertion.expected);
      description = `${assertion.resourceType}/${assertion.id}.${assertion.field} equals expected value`;
      break;
    }
    case 'event-received':
      actual = events.filter((event) => event.t === assertion.event).length;
      passed = actual === (assertion.count ?? 1);
      description = `${assertion.event} received ${assertion.count ?? 1} time(s)`;
      break;
    case 'risk-present':
    case 'risk-detected':
      actual = risks.has(assertion.ruleId);
      passed = actual === true;
      description = `risk ${assertion.ruleId} detected`;
      break;
    case 'risk-absent':
      actual = risks.has(assertion.ruleId);
      passed = actual === false;
      description = `risk ${assertion.ruleId} absent`;
      break;
    case 'interaction-state':
      actual = interactions.get(assertion.interactionId)?.status;
      passed = actual === assertion.state;
      description = `interaction ${assertion.interactionId} state is ${assertion.state}`;
      break;
    case 'state-hash':
      actual = stateHash;
      passed = actual === assertion.expected;
      description = 'state hash matches';
      break;
    case 'interaction-acknowledged': {
      const observation = observations.get(assertion.command);
      actual =
        observation?.acknowledgedAtMs === undefined
          ? undefined
          : observation.acknowledgedAtMs - observation.createdAtMs;
      passed = typeof actual === 'number' && actual < (assertion.withinMs ?? 3_000);
      description = `/${assertion.command} acknowledged within ${assertion.withinMs ?? 3_000} ms`;
      break;
    }
    case 'gateway-resumed':
      actual = gatewayResumed;
      passed = gatewayResumed;
      description = 'Gateway session resumed';
      break;
    case 'no-secret-leak':
      actual = containsLikelySecret({
        report: { spans: trace.spans(), risks: risks.all() },
        assertions: allAssertions,
        finalState: state.snapshot(),
        events,
        variables: Object.fromEntries(variables),
        runMetadata,
      });
      passed = actual === false;
      description = 'complete scenario result contains no secret';
      break;
  }
  return {
    assertion,
    type: assertion.type,
    description,
    passed,
    message: passed
      ? 'Assertion passed.'
      : `Assertion failed; actual value was ${displayValue(actual)}.`,
    ...(actual === undefined ? {} : { actual }),
  };
}

function requireLimitedRepeat(value: unknown, limits: ScenarioLimits): number {
  const repeat = requirePositiveInteger(value, 'REST repeat');
  if (repeat > limits.maxRepeat) throw new RangeError('REST repeat exceeds maxRepeat.');
  return repeat;
}

function resolveScenarioLimits(overrides: Partial<ScenarioLimits> = {}): ScenarioLimits {
  const limits = { ...DEFAULT_SCENARIO_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be positive.`);
  }
  return limits;
}

function validateValueBudget(value: unknown, limits: ScenarioLimits): void {
  let nodes = 0;
  let logicalBytes = 0;
  const active = new WeakSet<object>();
  const charge = (bytes: number): void => {
    logicalBytes += bytes;
    if (logicalBytes > limits.maxInputBytes) {
      throw new RangeError('Scenario value exceeds maxInputBytes after expansion.');
    }
  };
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) throw new RangeError('Scenario exceeds maxNodes.');
    if (depth > limits.maxDepth) throw new RangeError('Scenario exceeds maxDepth.');
    if (current === null) {
      charge(4);
      return;
    }
    if (typeof current === 'string') {
      charge(Buffer.byteLength(current));
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Scenario numbers must be finite.');
      charge(Buffer.byteLength(String(current)));
      return;
    }
    if (typeof current === 'boolean') {
      charge(current ? 4 : 5);
      return;
    }
    if (current === undefined) {
      charge(4);
      return;
    }
    if (typeof current !== 'object') {
      throw new TypeError('Scenario must contain only JSON-compatible values.');
    }
    if (active.has(current)) throw new TypeError('Scenario must not contain cyclic values.');
    if (!Array.isArray(current) && !isPlainObject(current)) {
      throw new TypeError('Scenario must contain only plain objects and arrays.');
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new TypeError('Scenario must not contain symbol properties.');
    }
    active.add(current);
    if (Array.isArray(current)) {
      assertDenseScenarioArray(current, limits);
      for (let index = 0; index < current.length; index += 1) {
        visit(current[index], depth + 1);
      }
    } else {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors);
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new TypeError('Scenario must not contain accessor properties.');
        }
        charge(Buffer.byteLength(key));
        visit(descriptor.value as unknown, depth + 1);
      }
    }
    active.delete(current);
  };
  visit(value, 0);
}

function assertDenseScenarioArray(value: readonly unknown[], limits: ScenarioLimits): void {
  if (value.length > limits.maxNodes) throw new RangeError('Scenario exceeds maxNodes.');
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[value.length] !== 'length') {
    throw new TypeError('Scenario arrays must be dense and must not contain custom properties.');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (names[index] !== String(index)) {
      throw new TypeError('Scenario arrays must be dense and must not contain custom properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Scenario arrays must contain only data properties.');
    }
  }
}

function appendEvents(
  target: GatewayDispatch[],
  additions: readonly GatewayDispatch[],
  maxEvents: number,
  maxEventBytes: number,
  retainedBytes: number,
): number {
  if (additions.length > maxEvents - target.length) {
    throw new RangeError(`Scenario cannot retain more than ${maxEvents} Gateway events.`);
  }
  let additionalBytes = 0;
  for (const event of additions) {
    additionalBytes += serializedBytes(event);
    if (additionalBytes > maxEventBytes - retainedBytes) {
      throw new RangeError(
        `Scenario cannot retain more than ${maxEventBytes} Gateway event bytes.`,
      );
    }
  }
  target.push(...additions);
  return retainedBytes + additionalBytes;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Gateway event is not JSON serializable.');
  return Buffer.byteLength(serialized);
}

function assertResourceCapacity(resourceCount: number, maxResources: number): void {
  if (resourceCount >= maxResources) throw new RangeError('Scenario exceeds maxResources.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

function executeRateLimit(
  method: string,
  path: string,
  rateLimits: RateLimitEngine,
  risks: RiskCollector,
  trace: TraceCollector,
  clock: VirtualClock,
): void {
  const span = trace.start('rest', `${method.toUpperCase()} ${path}`, { method, path });
  const result = rateLimits.acquire({ method, path, identity: 'scenario-bot' });
  trace.end(span, result.allowed ? 'ok' : 'warning', {
    status: result.status,
    bucket: result.bucketKey,
    remaining: result.remaining,
    retryAfterMs: result.retryAfterMs,
  });
  if (!result.allowed) {
    risks.add({
      ruleId: 'RATE_LIMIT_HOT_BUCKET',
      severity: 'medium',
      confidence: 1,
      title: 'Rate-limit bucket exhausted',
      evidence: `${method.toUpperCase()} ${path} returned 429 with retry_after ${result.retryAfterMs / 1_000}.`,
      impact: 'Requests sent before the reset will fail.',
      recommendation: 'Read the dynamic Retry-After value and queue the retry.',
      firstSeenAtMs: clock.now(),
      lastSeenAtMs: clock.now(),
    });
  }
}

function executePermissionCheck(
  permissionName: string,
  expected: 'allowed' | 'denied' | undefined,
  state: VirtualState,
  risks: RiskCollector,
  trace: TraceCollector,
  clock: VirtualClock,
): void {
  const permission = Permissions[permissionName as keyof typeof Permissions];
  if (permission === undefined) throw new TypeError(`Unknown permission: ${permissionName}.`);
  const guild = state.list('guild')[0];
  const guildId = guild?.id ?? '0';
  const bot = state.list('user').find((user) => user['bot'] === true);
  const member = state
    .list('member')
    .find(
      (candidate) =>
        candidate['user_id'] === bot?.id ||
        (isRecord(candidate['user']) && candidate['user']['id'] === bot?.id),
    );
  const roles: PermissionRole[] = state.list('role').map((role) => ({
    id: role.id,
    permissions:
      typeof role['permissions'] === 'string' || typeof role['permissions'] === 'bigint'
        ? role['permissions']
        : '0',
    position: typeof role['position'] === 'number' ? role['position'] : 0,
  }));
  const span = trace.start('state-mutation', `permission:${permissionName}`);
  const decision = calculatePermissions({
    guildId,
    ownerId: typeof guild?.['owner_id'] === 'string' ? guild['owner_id'] : 'owner',
    member: {
      id: bot?.id ?? 'bot',
      roleIds: Array.isArray(member?.['roles'])
        ? member['roles'].filter((value): value is string => typeof value === 'string')
        : [],
    },
    roles,
    requested: permission,
    nowMs: clock.now(),
  });
  trace.end(span, decision.allowed ? 'ok' : 'warning', {
    permission: permissionName,
    allowed: decision.allowed,
  });
  if (!decision.allowed) {
    risks.add({
      ruleId: 'MISSING_BOT_PERMISSION',
      severity: 'medium',
      confidence: 1,
      title: 'Bot permission is missing',
      evidence: `${permissionName} was denied: ${decision.reason}`,
      impact: 'The corresponding Discord operation would return HTTP 403.',
      recommendation: 'Grant the required role/channel permission or handle the denied result.',
    });
  }
  if (expected !== undefined && decision.allowed !== (expected === 'allowed')) {
    risks.add({
      ruleId: 'SCENARIO_EXPECTATION_MISMATCH',
      severity: 'high',
      confidence: 1,
      title: 'Permission action expectation mismatch',
      evidence: `Expected ${expected} but calculated ${decision.allowed ? 'allowed' : 'denied'}.`,
      impact: 'The scenario fixture does not produce the intended permission result.',
      recommendation: 'Correct the fixture roles and channel overwrites.',
    });
  }
}

function resolveAction(
  action: ScenarioAction,
  variables: ReadonlyMap<string, string>,
): ScenarioAction {
  return resolveValue(action, variables) as ScenarioAction;
}

function resolveAssertion(
  assertion: ScenarioAssertion,
  variables: ReadonlyMap<string, string>,
): ScenarioAssertion {
  return resolveValue(assertion, variables) as ScenarioAssertion;
}

function resolveValue(value: unknown, variables: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const exact = /^\$([A-Za-z][A-Za-z0-9_-]*)$/.exec(value);
    if (exact !== null) return variables.get(exact[1] as string) ?? value;
    return value.replace(
      /\$\{([A-Za-z][A-Za-z0-9_-]*)\}/g,
      (match, name: string) => variables.get(name) ?? match,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, variables)]),
    );
  }
  return value;
}

function actionTimelineAt(action: ScenarioAction): number | undefined {
  switch (action.type) {
    case 'timeline-interaction':
    case 'timeline-gateway-disconnect':
    case 'timeline-gateway-resume':
    case 'timeline-permission-check':
    case 'timeline-rest-request':
      return action.at;
    default:
      return undefined;
  }
}

function collectionResourceType(collection: string): DiscordResourceType {
  const mapping: Readonly<Record<string, DiscordResourceType>> = {
    applications: 'application',
    users: 'user',
    guilds: 'guild',
    members: 'member',
    roles: 'role',
    channels: 'channel',
    threads: 'thread',
    messages: 'message',
    interactions: 'interaction',
    webhooks: 'webhook',
    presences: 'presence',
    voiceStates: 'voice-state',
  };
  return mapping[collection] ?? collection.replace(/s$/, '');
}

function normalizeResourceFields(
  resource: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const aliases: Readonly<Record<string, string>> = {
    guildId: 'guild_id',
    channelId: 'channel_id',
    userId: 'user_id',
    ownerId: 'owner_id',
    parentId: 'parent_id',
  };
  return Object.fromEntries(
    Object.entries(resource).map(([key, value]) => [aliases[key] ?? key, structuredClone(value)]),
  );
}

function stripResourceType(resource: ResourceRecord): Readonly<Record<string, unknown>> {
  const data: Record<string, unknown> = { ...resource };
  delete data['resourceType'];
  return data;
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, segment) => (isRecord(current) ? current[segment] : undefined),
      value,
    );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stringifyComparable(left) === stringifyComparable(right);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return (
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === 'bigint' ? entry.toString() : entry,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

function parseDuration(value: unknown): number {
  if (typeof value === 'number') return requireNonNegativeNumber(value, 'Duration');
  if (typeof value !== 'string')
    throw new TypeError('Duration must be a number or duration string.');
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value.trim());
  if (match === null) throw new TypeError(`Invalid duration: ${value}.`);
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000;
  return Number(match[1]) * multiplier;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return structuredClone(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function optionalSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError(`${label} must be a safe integer.`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireNonNegativeNumber(value, label);
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function stringifyComparable(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry,
    ) ?? 'undefined'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function abortError(): Error {
  const error = new Error('Scenario execution was aborted.');
  error.name = 'AbortError';
  return error;
}
