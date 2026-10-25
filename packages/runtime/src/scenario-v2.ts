import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument } from 'yaml';
import {
  sanitizeForExport,
  parseFaultPlans,
  type FaultPlan,
  type FaultEvidence,
} from '@disrunner/core';
import { createSession } from './session.js';
import {
  SessionError,
  type InvocationContext,
  type RuntimeAction,
  type Session,
  type SessionInvocationResult,
  type SessionIssue,
  type SessionSnapshot,
} from './contracts.js';

export type BotScenarioV2Status = 'passed' | 'failed' | 'invalid' | 'runner-error' | 'cancelled';
export type BotScenarioV2Format = 'json' | 'junit' | 'html' | 'sarif';

interface ScenarioContext {
  readonly actor: string;
  readonly guild?: string;
  readonly channel: string;
}

export interface BotScenarioV2Step {
  readonly action:
    | 'invoke-command'
    | 'autocomplete'
    | 'invoke-component'
    | 'submit-modal'
    | 'send-message'
    | 'edit-message'
    | 'delete-message'
    | 'await-response'
    | 'await-message';
  readonly actor?: string;
  readonly guild?: string;
  readonly channel?: string;
  readonly command?: string;
  readonly commandType?: 1 | 2 | 3;
  readonly targetId?: string;
  readonly options?: readonly Readonly<Record<string, unknown>>[];
  readonly customId?: string;
  readonly componentType?: number;
  readonly values?: readonly string[];
  readonly fields?: Readonly<Record<string, string>>;
  readonly message?: string;
  readonly interaction?: string;
  readonly content?: string;
  readonly saveAs?: string;
  readonly timeoutMs?: number;
}

export interface BotScenarioV2Assertion {
  readonly type:
    | 'message-content'
    | 'message-count'
    | 'response-type'
    | 'interaction-status'
    | 'visibility'
    | 'error'
    | 'trace'
    | 'no-unexpected-error';
  readonly interaction?: string;
  readonly request?: string;
  readonly channel?: string;
  readonly guild?: string;
  readonly actor?: string;
  readonly equals?: string | number;
  readonly contains?: string;
  readonly count?: number;
  readonly code?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly description?: string;
}

export interface BotScenarioV2 {
  readonly version: 2;
  readonly name: string;
  readonly execution: {
    readonly kind: 'bot';
    readonly project: string;
    readonly clock: 'realtime';
    readonly timeoutMs: number;
  };
  readonly context?: ScenarioContext;
  readonly steps: readonly BotScenarioV2Step[];
  readonly assertions: readonly BotScenarioV2Assertion[];
  readonly faults: readonly FaultPlan[];
  readonly policy: { readonly failOnSeverity: 'none' | 'low' | 'medium' | 'high' | 'critical' };
}

export interface BotScenarioV2AssertionResult {
  readonly type:
    | BotScenarioV2Assertion['type']
    | 'unexpected-error'
    | 'evidence-complete'
    | 'risk-policy'
    | 'fault-applied'
    | 'runtime-diagnostics';
  readonly passed: boolean;
  readonly description: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface BotScenarioV2Observation {
  readonly requestId: string;
  readonly action: BotScenarioV2Step['action'];
  readonly context: InvocationContext;
  readonly result: SessionInvocationResult | null;
  readonly error: SessionIssue | null;
  readonly messageId: string | null;
}

export interface BotScenarioV2Result {
  readonly version: 2;
  readonly execution: 'bot';
  readonly name: string;
  readonly runId: string | null;
  readonly status: BotScenarioV2Status;
  readonly exitCode: number;
  readonly assertions: readonly BotScenarioV2AssertionResult[];
  readonly issues: readonly SessionIssue[];
  readonly cleanupErrors: readonly SessionIssue[];
  readonly observations: readonly BotScenarioV2Observation[];
  readonly snapshot: SessionSnapshot | null;
  readonly metadata: {
    readonly schemaVersion: 2;
    readonly clock: 'realtime';
    readonly replay: 'bot-rerun';
    readonly scenarioHash: string;
    readonly inputs: NonNullable<SessionSnapshot['inputs']> | null;
    readonly adapter: string | null;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly evidenceComplete: boolean;
    readonly faultEvidence: FaultEvidence | null;
  };
}

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_STEPS = 200;
const MAX_ASSERTIONS = 200;
const ACTIONS = [
  'invoke-command',
  'autocomplete',
  'invoke-component',
  'submit-modal',
  'send-message',
  'edit-message',
  'delete-message',
  'await-response',
  'await-message',
] as const;
const ASSERTIONS = [
  'message-content',
  'message-count',
  'response-type',
  'interaction-status',
  'visibility',
  'error',
  'trace',
  'no-unexpected-error',
] as const;
const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const;

/** Version detection preserves bounded v1 aliases; each version then applies its own parser. */
export function scenarioVersion(source: string): unknown {
  return sourceObject(source, 16 * MAX_SOURCE_BYTES, 100)['version'];
}

export function parseBotScenarioV2(input: unknown): BotScenarioV2 {
  const root = record(
    typeof input === 'string' ? sourceObject(input) : copyScenarioData(input),
    'scenario',
    ['version', 'name', 'execution', 'context', 'steps', 'assertions', 'policy', 'faults'],
  );
  if (root['version'] !== 2) throw new TypeError('Bot scenario version must be 2.');
  const name = text(root['name'], 'name', 1, 100);
  const execution = record(root['execution'], 'execution', [
    'kind',
    'project',
    'clock',
    'timeoutMs',
  ]);
  if (execution['kind'] !== 'bot' || execution['clock'] !== 'realtime')
    throw new TypeError('Version 2 requires execution.kind bot and execution.clock realtime.');
  const project = text(execution['project'], 'execution.project', 1, 4096);
  const timeoutMs = integer(execution['timeoutMs'] ?? 30_000, 'execution.timeoutMs', 1, 300_000);
  const context =
    root['context'] === undefined ? undefined : parseContext(root['context'], 'context');
  const saved = new Set<string>();
  const steps = array(root['steps'], 'steps', 1, MAX_STEPS).map((value, index) => {
    const step = record(value, `steps[${index}]`, [
      'action',
      'actor',
      'guild',
      'channel',
      'command',
      'commandType',
      'targetId',
      'options',
      'customId',
      'componentType',
      'values',
      'fields',
      'message',
      'interaction',
      'content',
      'saveAs',
      'timeoutMs',
    ]);
    const action = member(step['action'], ACTIONS, 'step.action');
    const allowed: readonly string[] = {
      'invoke-command': ['command', 'commandType', 'targetId', 'options'],
      autocomplete: ['command', 'options'],
      'invoke-component': ['customId', 'componentType', 'values', 'message'],
      'submit-modal': ['customId', 'fields', 'message'],
      'send-message': ['content'],
      'edit-message': ['message', 'content'],
      'delete-message': ['message'],
      'await-response': ['interaction'],
      'await-message': ['content'],
    }[action];
    for (const key of Object.keys(step)) {
      if (!['action', 'actor', 'guild', 'channel', 'saveAs', 'timeoutMs', ...allowed].includes(key))
        throw new TypeError(`steps[${index}].${key} does not apply to ${action}.`);
    }
    const ownContext = ['actor', 'guild', 'channel'].some((key) => step[key] !== undefined);
    if (ownContext || context === undefined) {
      for (const key of ['actor', 'channel']) id(step[key], `step.${key}`);
      if (step['guild'] !== undefined) id(step['guild'], 'step.guild');
    }
    if (
      (action === 'invoke-command' || action === 'autocomplete') &&
      (ownContext || context === undefined ? step['guild'] : context.guild) === undefined
    )
      throw new TypeError('Application commands require a guild context.');
    const saveAs =
      step['saveAs'] === undefined ? `step-${index + 1}` : alias(step['saveAs'], 'saveAs');
    if (saved.has(saveAs)) throw new TypeError('Every saveAs must be unique.');
    if (['invoke-command', 'autocomplete'].includes(action)) {
      const command = text(step['command'], 'command', 1, 32);
      if (!/^[a-z0-9_-]{1,32}$/u.test(command))
        throw new TypeError('command must be a command name.');
    }
    if (step['commandType'] !== undefined) integer(step['commandType'], 'commandType', 1, 3);
    if (step['targetId'] !== undefined) id(step['targetId'], 'targetId');
    if (action === 'invoke-component' || action === 'submit-modal')
      text(step['customId'], 'customId', 1, 100);
    if (action === 'invoke-component') integer(step['componentType'], 'componentType', 2, 8);
    if (action === 'submit-modal') {
      const fields = record(step['fields'], 'fields');
      if (Object.keys(fields).length > 5)
        throw new TypeError('Modal fields may contain at most five inputs.');
      for (const [key, value] of Object.entries(fields)) {
        text(key, 'field custom ID', 1, 100);
        text(value, 'field value', 0, 4000);
      }
    }
    if (['send-message', 'edit-message'].includes(action))
      text(step['content'], 'content', 0, 2000);
    if (step['content'] !== undefined) text(step['content'], 'content', 0, 2000);
    if (step['timeoutMs'] !== undefined) integer(step['timeoutMs'], 'timeoutMs', 1, 30_000);
    if (step['options'] !== undefined) {
      const options = array(step['options'], 'options', 0, 25);
      for (const option of options) record(option, 'option');
      if (Buffer.byteLength(JSON.stringify(options)) > 16_384)
        throw new TypeError('Command options are too large.');
    }
    if (step['values'] !== undefined) {
      for (const value of array(step['values'], 'values', 0, 25))
        text(value, 'select value', 1, 100);
    }
    for (const key of ['message', 'interaction']) {
      if (step[key] !== undefined) {
        const reference = text(step[key], key, 1, 128);
        const variable = referenceAlias(reference);
        if (variable !== undefined && !saved.has(variable))
          throw new TypeError(`${key} references an unknown or future step.`);
        if (variable === undefined && key === 'interaction' && !saved.has(reference))
          throw new TypeError('interaction must reference a preceding saved step.');
        if (variable === undefined && key === 'message') id(reference, 'message');
      }
    }
    if (
      ['edit-message', 'delete-message', 'invoke-component'].includes(action) &&
      step['message'] === undefined
    )
      throw new TypeError(`${action} requires message.`);
    if (action === 'await-response' && step['interaction'] === undefined)
      throw new TypeError('await-response requires interaction.');
    saved.add(saveAs);
    return { ...step, action, saveAs };
  });
  const assertions = array(root['assertions'], 'assertions', 1, MAX_ASSERTIONS).map(
    (value, index) => {
      const item = record(value, `assertions[${index}]`, [
        'type',
        'interaction',
        'request',
        'channel',
        'guild',
        'actor',
        'equals',
        'contains',
        'count',
        'code',
        'name',
        'kind',
        'description',
      ]);
      const type = member(item['type'], ASSERTIONS, 'assertion.type');
      const allowed: readonly string[] = {
        'message-content': ['interaction', 'channel', 'guild', 'actor', 'equals', 'contains'],
        'message-count': ['channel', 'guild', 'actor', 'equals'],
        'response-type': ['interaction', 'equals'],
        'interaction-status': ['interaction', 'equals'],
        visibility: ['interaction', 'actor', 'equals'],
        error: ['request', 'code', 'contains'],
        trace: ['name', 'kind', 'count'],
        'no-unexpected-error': [],
      }[type];
      for (const key of Object.keys(item))
        if (!['type', 'description', ...allowed].includes(key))
          throw new TypeError(`Assertion ${type} does not accept ${key}.`);
      for (const key of ['interaction', 'request']) {
        if (item[key] !== undefined) {
          const reference = text(item[key], key, 1, 128);
          const variable = referenceAlias(reference) ?? reference;
          if (!saved.has(variable))
            throw new TypeError(`${key} assertion must reference a saved step.`);
        }
      }
      if (item['channel'] !== undefined) id(item['channel'], 'assertion.channel');
      if (item['guild'] !== undefined) id(item['guild'], 'assertion.guild');
      if (item['actor'] !== undefined) id(item['actor'], 'assertion.actor');
      if (item['description'] !== undefined) text(item['description'], 'description', 1, 500);
      if (type === 'message-content') {
        if ((item['equals'] === undefined) === (item['contains'] === undefined))
          throw new TypeError('message-content requires exactly one of equals or contains.');
        text(item['equals'] ?? item['contains'], 'expected content', 0, 2000);
      } else if (type === 'message-count')
        integer(item['equals'], 'message-count.equals', 0, 10_000);
      else if (type === 'response-type') {
        member(
          item['equals'],
          ['message', 'defer', 'update', 'defer-update', 'autocomplete', 'modal', 'pong'],
          'response-type.equals',
        );
        if (item['interaction'] === undefined)
          throw new TypeError('response-type requires interaction.');
      } else if (type === 'interaction-status') {
        member(
          item['equals'],
          ['pending', 'deferred', 'responded', 'deleted', 'expired'],
          'interaction-status.equals',
        );
        if (item['interaction'] === undefined)
          throw new TypeError('interaction-status requires interaction.');
      } else if (type === 'visibility') {
        member(item['equals'], ['channel', 'ephemeral', 'absent'], 'visibility.equals');
        if (item['interaction'] === undefined)
          throw new TypeError('visibility requires interaction.');
      } else if (type === 'error') {
        if (item['request'] === undefined) throw new TypeError('error requires request.');
        if (item['code'] !== undefined) text(item['code'], 'error.code', 1, 100);
        if (item['contains'] !== undefined) text(item['contains'], 'error.contains', 1, 500);
      } else if (type === 'trace') {
        text(item['name'], 'trace.name', 1, 256);
        if (item['kind'] !== undefined) text(item['kind'], 'trace.kind', 1, 64);
        if (item['count'] !== undefined) integer(item['count'], 'trace.count', 0, 1000);
      }
      return { ...item, type };
    },
  );
  if (!assertions.some((assertion) => assertion.type !== 'no-unexpected-error'))
    throw new TypeError('A Bot scenario requires at least one behavior assertion.');
  const policy =
    root['policy'] === undefined ? {} : record(root['policy'], 'policy', ['failOnSeverity']);
  const failOnSeverity = member(
    policy['failOnSeverity'] ?? 'high',
    SEVERITIES,
    'policy.failOnSeverity',
  );
  return structuredClone({
    version: 2,
    name,
    execution: { kind: 'bot', project, clock: 'realtime', timeoutMs },
    ...(context === undefined ? {} : { context }),
    steps,
    assertions,
    faults: parseFaultPlans(root['faults'] ?? []),
    policy: { failOnSeverity },
  });
}

export async function runBotScenarioV2(
  input: unknown,
  options: {
    readonly baseDirectory: string;
    readonly signal?: AbortSignal;
    readonly onSnapshot?: (snapshot: SessionSnapshot) => void;
    readonly createSession?: () => Session;
    readonly cancellationExitCode?: 130 | 143;
  },
): Promise<BotScenarioV2Result> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const issues: SessionIssue[] = [];
  const cleanupErrors: SessionIssue[] = [];
  const diagnostics: SessionIssue[] = [];
  const diagnosticKeys = new Set<string>();
  let droppedDiagnostics = false;
  const collectDiagnostics = (value: SessionSnapshot): void => {
    for (const diagnostic of value.diagnostics ?? []) {
      const key = JSON.stringify([diagnostic.code, diagnostic.message]);
      if (diagnosticKeys.has(key)) continue;
      if (diagnostics.length >= 100) {
        droppedDiagnostics = true;
        continue;
      }
      diagnosticKeys.add(key);
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message });
    }
  };
  const observations: BotScenarioV2Observation[] = [];
  const assertions: BotScenarioV2AssertionResult[] = [];
  let status: BotScenarioV2Status = 'invalid';
  let name = 'Invalid scenario';
  let scenarioHash = '';
  let runId: string | null = null;
  let initialInputs: NonNullable<SessionSnapshot['inputs']> | null = null;
  let snapshot: SessionSnapshot | null = null;
  let session: Session | undefined;
  let unsubscribe: (() => void) | undefined;
  let retainRunSnapshot = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage: 'parse' | 'start' | 'run' = 'parse';
  const deadline = new AbortController();
  const cancelled = new AbortController();
  const abort = (): void => cancelled.abort(new SessionError('cancelled', 'Scenario cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = AbortSignal.any([deadline.signal, cancelled.signal]);
  let evidenceComplete = false;
  try {
    const scenario = parseBotScenarioV2(input);
    name = scenario.name;
    scenarioHash = createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
    if (typeof options.baseDirectory !== 'string' || options.baseDirectory.length === 0)
      throw new TypeError('A scenario baseDirectory is required.');
    const project = resolve(options.baseDirectory, scenario.execution.project);
    const projectDirectory =
      basename(project) === 'discord-simulator.config.json' ? dirname(project) : project;
    timer = setTimeout(
      () => deadline.abort(new SessionError('timeout', 'Scenario overall deadline exceeded.')),
      scenario.execution.timeoutMs,
    );
    signal.throwIfAborted();
    stage = 'start';
    session = (options.createSession ?? createSession)();
    unsubscribe = session.subscribe((event) => {
      collectDiagnostics(event.snapshot);
      if (retainRunSnapshot) {
        snapshot = event.snapshot;
        options.onSnapshot?.(event.snapshot);
      }
    });
    await abortable(session.selectProject(projectDirectory), signal);
    const initial = await abortable(
      session.start({ signal, timeoutMs: Math.min(60_000, scenario.execution.timeoutMs) }),
      signal,
    );
    if (initial.runId === null)
      throw new SessionError('transport', 'Runtime did not return an active run.');
    runId = initial.runId;
    initialInputs = structuredClone(initial.inputs ?? null);
    snapshot = initial;
    stage = 'run';
    session.setFaults(scenario.faults);
    const saved = new Map<string, BotScenarioV2Observation>();
    for (const [index, step] of scenario.steps.entries()) {
      signal.throwIfAborted();
      const sourceContext = step.actor === undefined ? scenario.context : step;
      if (sourceContext?.actor === undefined || sourceContext.channel === undefined)
        throw new TypeError('Step context is missing.');
      const context = session.validateContext({
        actorId: sourceContext.actor,
        ...(sourceContext.guild === undefined ? {} : { guildId: sourceContext.guild }),
        channelId: sourceContext.channel,
      });
      const requestId = step.saveAs ?? `step-${index + 1}`;
      const beforeMessageIds = new Set(
        session
          .snapshotForActor(context.actorId)
          .coreState?.resources.filter((resource) => resource.resourceType === 'message')
          .map((resource) => resource.id) ?? [],
      );
      let result: SessionInvocationResult | null = null;
      let error: SessionIssue | null = null;
      try {
        if (step.action === 'await-response' || step.action === 'await-message') {
          const origin =
            step.interaction === undefined
              ? undefined
              : saved.get(referenceAlias(step.interaction) ?? step.interaction);
          await waitFor(
            () => {
              const current = session!.snapshotForActor(context.actorId);
              if (current.phase !== 'running')
                throw new SessionError(
                  'child-exited',
                  'Bot stopped while waiting for an observation.',
                );
              const candidates = messages(current, context.channelId);
              if (step.action === 'await-message')
                return candidates.some((message) => message['content'] === step.content);
              if (origin?.result?.response?.type === 'message') return true;
              return candidates.some(
                (message) =>
                  associated(message, origin?.result?.interactionId ?? null) &&
                  message['loading'] !== true &&
                  (typeof message['flags'] !== 'number' || (message['flags'] & 128) === 0),
              );
            },
            step.timeoutMs ?? 3000,
            signal,
          );
          result = origin?.result ?? null;
        } else {
          const requestOptions = { signal, timeoutMs: step.timeoutMs ?? 30_000 };
          result = await abortable(
            dispatch(
              session,
              { runId, requestId, context, action: actionFor(step, saved) },
              requestOptions,
            ),
            signal,
          );
          if (
            result.runId !== runId ||
            result.requestId !== requestId ||
            !sameContext(result.context, context)
          )
            throw new SessionError(
              'transport',
              'Observed result belongs to a different request context.',
            );
          if (!result.ok || result.error !== null)
            error = {
              code: 'transport',
              message: result.error ?? 'Bot operation did not succeed.',
            };
        }
      } catch (caught) {
        signal.throwIfAborted();
        error = issue(caught);
        if (error.code === 'child-exited' || error.code === 'cleanup' || error.code === 'invalid')
          throw caught;
      }
      const after = session.snapshotForActor(context.actorId);
      const observedMessage = after.coreState?.resources.find(
        (resource) =>
          resource.resourceType === 'message' &&
          (result?.interactionId !== null && result?.interactionId !== undefined
            ? resource.interaction_id === result.interactionId
            : step.action === 'send-message' &&
              resource.author?.id === context.actorId &&
              !beforeMessageIds.has(resource.id)),
      );
      const observation = {
        requestId,
        action: step.action,
        context,
        result,
        error,
        messageId: observedMessage?.id ?? null,
      };
      observations.push(observation);
      saved.set(requestId, observation);
      snapshot = session.snapshot();
    }
    await waitForHandlers(session, signal);
    signal.throwIfAborted();
    snapshot = session.snapshot();
    collectDiagnostics(snapshot);
    evidenceComplete = complete(snapshot);
    const consumed = new Set<string>();
    for (const assertion of scenario.assertions) {
      const reference =
        assertion.interaction === undefined
          ? undefined
          : saved.get(referenceAlias(assertion.interaction) ?? assertion.interaction);
      const actorId = assertion.actor ?? reference?.context.actorId;
      const actorSnapshot = actorId === undefined ? snapshot : session.snapshotForActor(actorId);
      const evaluated = evaluate(assertion, saved, actorSnapshot);
      assertions.push(evaluated);
      if (assertion.type === 'error' && evaluated.passed)
        consumed.add(referenceAlias(assertion.request!) ?? assertion.request!);
    }
    const unexpected = observations.filter(
      (observation) => observation.error !== null && !consumed.has(observation.requestId),
    );
    assertions.push({
      type: 'unexpected-error',
      passed: unexpected.length === 0,
      description: 'No unconsumed operation errors',
      message:
        unexpected.length === 0
          ? 'Every operation error was explicitly expected.'
          : `${unexpected.length} unexpected operation error(s).`,
    });
    assertions.push({
      type: 'evidence-complete',
      passed: evidenceComplete,
      description: 'Complete observation evidence',
      message: evidenceComplete
        ? 'The retained run evidence is complete.'
        : 'Run evidence was truncated or dropped; a passing result cannot be established.',
    });
    const threshold = SEVERITIES.indexOf(scenario.policy.failOnSeverity);
    const findings =
      threshold === 0
        ? []
        : snapshot.risks.filter(
            (risk) => SEVERITIES.indexOf(risk.severity as (typeof SEVERITIES)[number]) >= threshold,
          );
    assertions.push({
      type: 'risk-policy',
      passed: findings.length === 0,
      description: 'Risk severity policy',
      message:
        findings.length === 0
          ? 'No finding exceeds the selected severity policy.'
          : `${findings.length} finding(s) meet the failure threshold.`,
    });
    for (const plan of scenario.faults) {
      const selected =
        snapshot.faults?.events.some(
          (event) => event.planId === plan.id && event.phase === 'selected',
        ) ?? false;
      assertions.push({
        type: 'fault-applied',
        passed: selected,
        description: `Fault ${plan.id}`,
        message: selected
          ? 'The configured fault was selected by the live transport.'
          : 'The configured fault did not affect an observed transport operation.',
      });
    }
    status = assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed';
  } catch (caught) {
    const failure = signal.aborted ? issue(signal.reason) : issue(caught);
    issues.push(failure);
    status =
      failure.code === 'cancelled'
        ? 'cancelled'
        : stage === 'parse' || failure.code === 'invalid'
          ? 'invalid'
          : stage === 'run' && failure.code === 'timeout'
            ? 'failed'
            : 'runner-error';
  } finally {
    retainRunSnapshot = false;
    if (session !== undefined) {
      snapshot = session.snapshot();
      collectDiagnostics(snapshot);
      try {
        const disposed = await session.dispose();
        collectDiagnostics(disposed.snapshot);
        if (!complete(disposed.snapshot)) evidenceComplete = false;
        cleanupErrors.push(
          ...disposed.errors.map((error) => ({ code: error.code, message: error.message })),
        );
        if (!disposed.ok && disposed.errors.length === 0)
          cleanupErrors.push({
            code: 'cleanup',
            message: 'Runtime cleanup could not be confirmed.',
          });
      } catch {
        cleanupErrors.push({ code: 'cleanup', message: 'Runtime cleanup failed.' });
      }
      const stoppedSnapshot = session.snapshot();
      collectDiagnostics(stoppedSnapshot);
      if (!complete(stoppedSnapshot)) evidenceComplete = false;
      if (snapshot !== null)
        snapshot = {
          ...snapshot,
          activeHandlers: stoppedSnapshot.activeHandlers ?? 0,
          evidenceComplete: snapshot.evidenceComplete !== false && complete(stoppedSnapshot),
          output: stoppedSnapshot.output,
        };
      if (cleanupErrors.length > 0 && status !== 'cancelled') status = 'runner-error';
    }
    unsubscribe?.();
    if (signal.aborted && !issues.some((entry) => entry.code === issue(signal.reason).code)) {
      const failure = issue(signal.reason);
      issues.push(failure);
      status =
        failure.code === 'cancelled' ? 'cancelled' : stage === 'run' ? 'failed' : 'runner-error';
    }
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (runId !== null) {
    const passed = diagnostics.length === 0 && !droppedDiagnostics;
    assertions.push({
      type: 'runtime-diagnostics',
      passed,
      description: 'No unhandled Bot errors',
      message: passed
        ? 'No structured Bot error diagnostic was observed through shutdown.'
        : `${diagnostics.length} unhandled Bot error diagnostic(s) were observed.`,
      expected: 0,
      actual: diagnostics.length,
    });
    issues.push(...diagnostics);
    if (!passed && status === 'passed') status = 'failed';
    if (droppedDiagnostics) evidenceComplete = false;
    if (!evidenceComplete) {
      const index = assertions.findIndex((assertion) => assertion.type === 'evidence-complete');
      if (index >= 0)
        assertions[index] = {
          ...assertions[index]!,
          passed: false,
          message:
            (snapshot?.activeHandlers ?? 0) > 0
              ? 'Tracked handlers did not finish before shutdown.'
              : 'Run evidence was dropped or truncated before shutdown completed.',
        };
      if (status === 'passed') status = 'failed';
    }
    if (snapshot !== null) snapshot = { ...snapshot, diagnostics: structuredClone(diagnostics) };
  }
  const exitCode =
    status === 'passed'
      ? 0
      : status === 'failed'
        ? 1
        : status === 'invalid'
          ? 2
          : status === 'cancelled'
            ? (options.cancellationExitCode ?? 130)
            : 3;
  return sanitizeForExport({
    version: 2,
    execution: 'bot',
    name,
    runId,
    status,
    exitCode,
    assertions,
    issues,
    cleanupErrors,
    observations,
    snapshot,
    metadata: {
      schemaVersion: 2,
      clock: 'realtime',
      replay: 'bot-rerun',
      scenarioHash,
      inputs: initialInputs,
      adapter: snapshot?.project?.adapter ?? null,
      startedAt,
      durationMs: performance.now() - started,
      evidenceComplete,
      faultEvidence: snapshot?.faults ?? null,
    },
  });
}

function evaluate(
  assertion: BotScenarioV2Assertion,
  saved: ReadonlyMap<string, BotScenarioV2Observation>,
  snapshot: SessionSnapshot,
): BotScenarioV2AssertionResult {
  const reference = assertion.interaction ?? assertion.request;
  const observation =
    reference === undefined ? undefined : saved.get(referenceAlias(reference) ?? reference);
  const response = observation?.result?.response;
  const interactionId = observation?.result?.interactionId ?? null;
  const channel = assertion.channel ?? observation?.context.channelId;
  const candidates = messages(snapshot, channel, assertion.guild).filter(
    (message) => reference === undefined || associated(message, interactionId),
  );
  const content = candidates
    .map((message) => message['content'])
    .filter((value): value is string => typeof value === 'string');
  let passed = false;
  let actual: unknown;
  let expected: unknown = assertion.equals ?? assertion.contains ?? assertion.count;
  switch (assertion.type) {
    case 'message-content':
      actual = content;
      passed = content.some((value) =>
        assertion.equals === undefined
          ? value.includes(assertion.contains!)
          : value === assertion.equals,
      );
      break;
    case 'message-count':
      actual = messages(snapshot, channel, assertion.guild).length;
      passed = actual === assertion.equals;
      break;
    case 'response-type':
      actual = response?.type ?? null;
      passed = actual === assertion.equals;
      break;
    case 'interaction-status': {
      actual =
        snapshot.interactions?.find((interaction) => interaction.id === interactionId)?.status ??
        null;
      passed = actual === assertion.equals;
      break;
    }
    case 'visibility': {
      actual =
        candidates.length === 0
          ? 'absent'
          : candidates.some((message) => message['visibility'] === 'ephemeral')
            ? 'ephemeral'
            : 'channel';
      passed = actual === assertion.equals;
      break;
    }
    case 'error': {
      actual = observation?.error ?? null;
      expected = {
        ...(assertion.code === undefined ? {} : { code: assertion.code }),
        ...(assertion.contains === undefined ? {} : { contains: assertion.contains }),
      };
      passed =
        observation?.error !== null &&
        observation?.error !== undefined &&
        (assertion.code === undefined || observation.error.code === assertion.code) &&
        (assertion.contains === undefined ||
          observation.error.message.includes(assertion.contains));
      break;
    }
    case 'trace':
      actual = snapshot.traces.filter(
        (trace) =>
          trace.name === assertion.name &&
          (assertion.kind === undefined || trace.kind === assertion.kind),
      ).length;
      passed = assertion.count === undefined ? (actual as number) > 0 : actual === assertion.count;
      break;
    case 'no-unexpected-error':
      actual = snapshot.phase;
      passed =
        snapshot.phase === 'running' &&
        snapshot.error === null &&
        (snapshot.diagnostics?.length ?? 0) === 0;
      break;
  }
  return {
    type: assertion.type,
    passed,
    description: assertion.description ?? assertion.type,
    message: passed
      ? 'Observed behavior matches the assertion.'
      : 'Observed behavior does not match the assertion.',
    ...(expected === undefined ? {} : { expected }),
    actual,
  };
}

type DispatchAction = RuntimeAction;
function actionFor(
  step: BotScenarioV2Step,
  saved: ReadonlyMap<string, BotScenarioV2Observation>,
): DispatchAction {
  const messageId = step.message === undefined ? undefined : resolveReference(step.message, saved);
  const common = {
    ...(messageId === undefined ? {} : { messageId }),
    ...(step.content === undefined ? {} : { content: step.content }),
  };
  switch (step.action) {
    case 'invoke-command':
      return {
        type: 'command',
        name: step.command!,
        ...(step.commandType === undefined ? {} : { commandType: step.commandType }),
        ...(step.targetId === undefined ? {} : { targetId: step.targetId }),
        ...(step.options === undefined ? {} : { options: step.options }),
      };
    case 'autocomplete':
      return { type: 'autocomplete', name: step.command!, options: step.options ?? [] };
    case 'invoke-component':
      return {
        type: 'component',
        customId: step.customId!,
        componentType: step.componentType!,
        values: step.values ?? [],
        ...common,
      };
    case 'submit-modal':
      return { type: 'modal-submit', customId: step.customId!, fields: step.fields!, ...common };
    case 'send-message':
      return { type: 'message', ...common };
    case 'edit-message':
      return { type: 'message-edit', ...common };
    case 'delete-message':
      return { type: 'message-delete', ...common };
    default:
      throw new TypeError('Await actions do not dispatch Bot operations.');
  }
}

function resolveReference(
  value: string,
  saved: ReadonlyMap<string, BotScenarioV2Observation>,
): string {
  const reference = referenceAlias(value);
  if (reference === undefined) return id(value, 'message');
  const result = saved.get(reference)?.result;
  const messageId = saved.get(reference)?.messageId;
  if (messageId !== null && messageId !== undefined) return messageId;
  const responseId = result?.response?.data['id'];
  if (typeof responseId === 'string') return responseId;
  throw new TypeError(
    'The saved response does not provide a message ID. Use an observed message ID.',
  );
}

async function dispatch(
  session: Session,
  request: { runId: string; requestId: string; context: InvocationContext; action: DispatchAction },
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<SessionInvocationResult> {
  return session.dispatch(request, options);
}

function messages(
  snapshot: SessionSnapshot,
  channel?: string,
  guild?: string,
): Readonly<Record<string, unknown>>[] {
  return (snapshot.coreState?.resources ?? []).filter(
    (resource) =>
      resource.resourceType === 'message' &&
      resource.author?.bot === true &&
      (channel === undefined || resource.channel_id === channel) &&
      (guild === undefined || resource.guild_id === guild),
  ) as unknown as Readonly<Record<string, unknown>>[];
}
function associated(
  message: Readonly<Record<string, unknown>>,
  interactionId: string | null,
): boolean {
  if (interactionId === null) return false;
  if (message['interaction_id'] === interactionId) return true;
  const interaction = message['interaction'] ?? message['interaction_metadata'];
  return (
    typeof interaction === 'object' &&
    interaction !== null &&
    'id' in interaction &&
    interaction.id === interactionId
  );
}
function complete(snapshot: SessionSnapshot): boolean {
  const evidence = snapshot as unknown as Record<string, unknown>;
  const active = snapshot.activeHandlers ?? 0;
  if (!Number.isSafeInteger(active) || active < 0 || (snapshot.phase !== 'running' && active !== 0))
    return false;
  if (
    (snapshot.coreState?.evidenceComplete === undefined
      ? snapshot.coreState?.truncated === true
      : snapshot.coreState.evidenceComplete === false) ||
    evidence['evidenceComplete'] === false
  )
    return false;
  if (snapshot.faults?.complete === false || (snapshot.faults?.droppedEvents ?? 0) > 0)
    return false;
  for (const key of ['droppedOutput', 'droppedTraces', 'droppedEvents', 'droppedRisks'])
    if (typeof evidence[key] === 'number' && evidence[key] > 0) return false;
  return true;
}
function sameContext(a: InvocationContext, b: InvocationContext): boolean {
  return a.actorId === b.actorId && a.guildId === b.guildId && a.channelId === b.channelId;
}
function issue(error: unknown): SessionIssue {
  if (error instanceof SessionError) return { code: error.code, message: error.message };
  if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)
    return { code: 'invalid', message: sanitizeForExport(error.message) };
  return { code: 'transport', message: 'Scenario operation failed.' };
}
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const until = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    if (predicate()) return;
    if (performance.now() >= until)
      throw new SessionError(
        'timeout',
        'Expected Bot observation did not arrive before the deadline.',
      );
    await delay(Math.min(20, Math.max(1, until - performance.now())), undefined, { signal });
  }
}
async function waitForHandlers(session: Session, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const snapshot = session.snapshot();
    if (snapshot.phase !== 'running')
      throw new SessionError('child-exited', 'The Bot stopped before its handlers completed.');
    const active = snapshot.activeHandlers ?? 0;
    if (!Number.isSafeInteger(active) || active < 0)
      throw new SessionError('transport', 'Handler completion evidence is invalid.');
    if (active === 0) {
      await delay(100, undefined, { signal });
      const afterGrace = session.snapshot();
      if (afterGrace.phase !== 'running')
        throw new SessionError('child-exited', 'The Bot stopped before its handlers completed.');
      if ((afterGrace.activeHandlers ?? 0) === 0) return;
    } else {
      await delay(10, undefined, { signal });
    }
  }
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new SessionError('cancelled', 'Scenario cancelled.'),
      );
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (cancel !== undefined) signal.removeEventListener('abort', cancel);
  }
}

function sourceObject(
  source: string,
  maximumBytes = MAX_SOURCE_BYTES,
  maxAliasCount = 0,
): Record<string, unknown> {
  if (Buffer.byteLength(source) > maximumBytes)
    throw new TypeError('Scenario exceeds the 1 MiB size limit.');
  const document = parseDocument(source, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new TypeError('Scenario is not valid JSON or YAML.');
  return record(document.toJS({ maxAliasCount }), 'scenario');
}
function copyScenarioData(input: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 50_000 || depth > 32)
      throw new TypeError('Scenario data exceeds its structural limit.');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      if (bytes > MAX_SOURCE_BYTES) throw new TypeError('Scenario exceeds the 1 MiB size limit.');
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value))
      throw new TypeError('Scenario must contain finite, acyclic JSON data.');
    const prototype: unknown = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (
      isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new TypeError('Scenario must contain plain JSON data.');
    ancestors.add(value);
    try {
      const result: Record<string, unknown> | unknown[] = isArray
        ? []
        : (Object.create(null) as Record<string, unknown>);
      const keys = Reflect.ownKeys(value);
      if (isArray && (value.length > 2000 || keys.length !== value.length + 1))
        throw new TypeError('Scenario arrays must be dense and bounded.');
      for (const key of keys) {
        if (isArray && key === 'length') continue;
        if (typeof key !== 'string') throw new TypeError('Scenario keys must be strings.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          throw new TypeError('Scenario fields must be data properties.');
        if (isArray && !/^(?:0|[1-9][0-9]*)$/u.test(key))
          throw new TypeError('Scenario arrays cannot have custom properties.');
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(input, 0);
}
function record(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be a plain object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (keys !== undefined && !keys.includes(key)))
      throw new TypeError(`${label} contains an unknown field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new TypeError(`${label} fields must be plain data.`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, min: number, max: number): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value) < min ||
    Buffer.byteLength(value) > max
  )
    throw new TypeError(`${label} must contain ${min}–${max} UTF-8 bytes.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 1, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(result) || BigInt(result) > 18_446_744_073_709_551_615n)
    throw new TypeError(`${label} must be a canonical Discord ID.`);
  return result;
}
function alias(value: unknown, label: string): string {
  const result = text(value, label, 1, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(result))
    throw new TypeError(
      `${label} must begin with a letter and contain only letters, digits, hyphens and underscores.`,
    );
  return result;
}
function referenceAlias(value: string): string | undefined {
  return /^\$\{([A-Za-z][A-Za-z0-9_-]{0,63})\.id\}$/u.exec(value)?.[1];
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`${label} must be an integer from ${min} through ${max}.`);
  return value;
}
function array(value: unknown, label: string, min: number, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    Object.keys(value).length !== value.length
  )
    throw new TypeError(`${label} must be a dense array of ${min}–${max} entries.`);
  return value as unknown[];
}
function member<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new TypeError(`${label} has an unsupported value.`);
  return value;
}
function parseContext(value: unknown, label: string): ScenarioContext {
  const source = record(value, label, ['actor', 'guild', 'channel']);
  return {
    actor: id(source['actor'], `${label}.actor`),
    ...(source['guild'] === undefined ? {} : { guild: id(source['guild'], `${label}.guild`) }),
    channel: id(source['channel'], `${label}.channel`),
  };
}

export function renderBotScenarioV2Report(
  result: BotScenarioV2Result,
  format: BotScenarioV2Format,
): string {
  const safe = sanitizeForExport(result);
  if (format === 'json') return `${JSON.stringify(safe, null, 2)}\n`;
  const failures = safe.assertions.filter((assertion) => !assertion.passed);
  const issues = [...safe.issues, ...safe.cleanupErrors];
  if (format === 'junit') {
    const cases = safe.assertions.map(
      (assertion) =>
        `<testcase name="${xml(assertion.description)}">${assertion.passed ? '' : `<failure message="${xml(assertion.message)}">${xml(JSON.stringify({ expected: assertion.expected, actual: assertion.actual }))}</failure>`}</testcase>`,
    );
    if (safe.status !== 'passed' && failures.length === 0)
      cases.push(
        `<testcase name="Run lifecycle"><error message="${xml(safe.status)}">${xml(issues.map((item) => item.message).join('\n'))}</error></testcase>`,
      );
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(safe.name)}" tests="${cases.length}" failures="${failures.length}" errors="${safe.status !== 'passed' && failures.length === 0 ? 1 : 0}" time="${(safe.metadata.durationMs / 1000).toFixed(3)}">\n<properties><property name="disrunner" value="${xml(JSON.stringify(safe.metadata))}"/></properties>\n${cases.join('\n')}\n<system-err>${xml(issues.map((item) => `${item.code}: ${item.message}`).join('\n'))}</system-err>\n</testsuite>\n`;
  }
  if (format === 'html')
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(safe.name)}</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#14161b;color:#f3f5fa}td,th{padding:10px;text-align:left;border-bottom:1px solid #343a48}table{width:100%;border-collapse:collapse}.passed{color:#42d392}.failed{color:#f06470}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${xml(safe.name)}</h1><p class="${safe.status === 'passed' ? 'passed' : 'failed'}">${xml(safe.status.toUpperCase())} · real Bot · ${xml(safe.metadata.adapter ?? 'unavailable')}</p><p>Run ${xml(safe.runId ?? 'not started')} · ${safe.metadata.durationMs.toFixed(1)} ms · evidence ${safe.metadata.evidenceComplete ? 'complete' : 'incomplete'}</p><table><thead><tr><th>Status</th><th>Assertion</th><th>Evidence</th></tr></thead><tbody>${safe.assertions.map((assertion) => `<tr><td>${assertion.passed ? 'PASS' : 'FAIL'}</td><td>${xml(assertion.description)}</td><td>${xml(assertion.message)}</td></tr>`).join('')}</tbody></table><pre>${xml(issues.map((item) => `${item.code}: ${item.message}`).join('\n'))}</pre><details><summary>Run metadata</summary><pre>${xml(JSON.stringify(safe.metadata, null, 2))}</pre></details></body></html>\n`;
  if (format !== 'sarif') throw new TypeError('Unsupported report format.');
  const findings = [
    ...failures.map((assertion) => ({
      ruleId: `scenario/${assertion.type}`,
      level: 'error',
      message: { text: `${assertion.description}: ${assertion.message}` },
    })),
    ...issues.map((item) => ({
      ruleId: `runtime/${item.code}`,
      level: 'error',
      message: { text: item.message },
    })),
  ];
  if (safe.status !== 'passed' && findings.length === 0)
    findings.push({
      ruleId: 'scenario/run-status',
      level: 'error',
      message: { text: `Run ended with ${safe.status}.` },
    });
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))];
  return `${JSON.stringify({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'DisRunner', informationUri: 'https://github.com/YanagiKH/DisRunner', rules: ruleIds.map((id) => ({ id, shortDescription: { text: id } })) } }, invocations: [{ executionSuccessful: safe.status === 'passed' || safe.status === 'failed', exitCode: safe.exitCode }], results: findings, properties: { execution: 'bot', status: safe.status, runId: safe.runId, evidenceComplete: safe.metadata.evidenceComplete, faultEvidence: safe.metadata.faultEvidence } }] }, null, 2)}\n`;
}
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export { runBotScenarioV2 as runScenarioV2, renderBotScenarioV2Report as renderScenarioV2Report };
