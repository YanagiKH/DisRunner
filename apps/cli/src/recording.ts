import { createHash } from 'node:crypto';
import {
  parseScenario,
  runScenario,
  sanitizeFixtureForExport,
  sanitizeForExport,
  sanitizeScenarioRunResult,
  type GatewayDispatch,
  type ScenarioAssertionResult,
  type ScenarioDefinition,
  type SimulationReport,
} from '@disrunner/core';

export const RECORDING_KIND = 'dev.disrunner.recording';
export const RECORDING_FORMAT_VERSION = 1;

interface RecordedTrace {
  readonly report: SimulationReport;
  readonly assertions: readonly ScenarioAssertionResult[];
  readonly events: readonly GatewayDispatch[];
  readonly finalStateHash: string;
}

export interface RecordingEnvelope {
  readonly kind: typeof RECORDING_KIND;
  readonly formatVersion: typeof RECORDING_FORMAT_VERSION;
  readonly profile: {
    readonly seed: number;
    readonly startTimeMs: number;
  };
  readonly scenario: ScenarioDefinition;
  readonly trace: RecordedTrace;
  readonly integrity: {
    readonly algorithm: 'sha256';
    readonly scenarioHash: string;
    readonly eventsHash: string;
    readonly traceHash: string;
  };
}

export interface ReplayCheck {
  readonly name:
    | 'scenario-integrity'
    | 'events-integrity'
    | 'trace-integrity'
    | 'state-hash'
    | 'events-hash'
    | 'events-exact'
    | 'trace-hash'
    | 'scenario-result';
  readonly passed: boolean;
  readonly expected: string | number | boolean;
  readonly actual: string | number | boolean;
}

export interface ReplayVerification {
  readonly kind: 'dev.disrunner.replay-verification';
  readonly formatVersion: 1;
  readonly executed: boolean;
  readonly reproduced: boolean;
  readonly scenarioPassed: boolean;
  readonly passed: boolean;
  readonly checks: readonly ReplayCheck[];
  readonly stateHash?: string;
  readonly eventsHash?: string;
  readonly eventCount?: number;
}

export async function createRecording(
  source: string,
  options: { readonly seed?: number } = {},
): Promise<RecordingEnvelope> {
  const parsedScenario = parseScenario(source);
  const scenario = parseScenario(sanitizeFixtureForExport(parsedScenario));
  const result = sanitizeScenarioRunResult(
    await runScenario(
      scenario,
      options.seed === undefined ? {} : { profile: { seed: options.seed } },
    ),
  );
  const startTimeMs = Date.parse(result.report.startedAt);
  if (!Number.isSafeInteger(startTimeMs) || startTimeMs < 0) {
    throw new RangeError('The simulation produced an invalid start timestamp.');
  }
  const trace = traceFromResult(result);
  const envelope: RecordingEnvelope = {
    kind: RECORDING_KIND,
    formatVersion: RECORDING_FORMAT_VERSION,
    profile: { seed: result.report.seed, startTimeMs },
    scenario,
    trace,
    integrity: {
      algorithm: 'sha256',
      scenarioHash: digestValue(scenario),
      eventsHash: digestValue(trace.events),
      traceHash: digestValue(trace),
    },
  };
  return sanitizeForExport(envelope);
}

export function parseRecording(source: string): RecordingEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError(
      `Recording is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = sanitizeForExport(parsed);
  if (!isRecord(value)) throw new TypeError('Recording must be a JSON object.');
  if (value['kind'] !== RECORDING_KIND) {
    throw new TypeError(`Recording kind must be ${RECORDING_KIND}.`);
  }
  if (value['formatVersion'] !== RECORDING_FORMAT_VERSION) {
    throw new RangeError(
      `Unsupported recording format version: ${String(value['formatVersion'])}.`,
    );
  }

  const profile = requireRecord(value['profile'], 'Recording profile');
  const seed = requireSafeInteger(profile['seed'], 'Recording seed');
  const startTimeMs = requireSafeInteger(profile['startTimeMs'], 'Recording start time');
  if (startTimeMs < 0) throw new RangeError('Recording start time must be non-negative.');

  const scenarioValue = requireRecord(value['scenario'], 'Recorded scenario');
  const scenario = parseScenario(scenarioValue as unknown as ScenarioDefinition);
  const traceValue = requireRecord(value['trace'], 'Recorded trace');
  const report = parseReport(traceValue['report']);
  const assertions = requireArray(
    traceValue['assertions'],
    'Recorded assertions',
  ) as unknown as readonly ScenarioAssertionResult[];
  const events = parseEvents(traceValue['events']);
  const finalStateHash = requireStateHash(
    traceValue['finalStateHash'],
    'Recorded final-state hash',
  );
  if (report.seed !== seed) {
    throw new TypeError('Recorded profile and report seeds disagree.');
  }
  if (Date.parse(report.startedAt) !== startTimeMs) {
    throw new TypeError('Recorded profile and report start timestamps disagree.');
  }
  if (report.stateHash !== finalStateHash) {
    throw new TypeError('Recorded report and final-state hashes disagree.');
  }

  const integrityValue = requireRecord(value['integrity'], 'Recording integrity');
  if (integrityValue['algorithm'] !== 'sha256') {
    throw new TypeError('Recording integrity algorithm must be sha256.');
  }
  const integrity = {
    algorithm: 'sha256' as const,
    scenarioHash: requireHash(integrityValue['scenarioHash'], 'Scenario integrity hash'),
    eventsHash: requireHash(integrityValue['eventsHash'], 'Event integrity hash'),
    traceHash: requireHash(integrityValue['traceHash'], 'Trace integrity hash'),
  };

  return {
    kind: RECORDING_KIND,
    formatVersion: RECORDING_FORMAT_VERSION,
    profile: { seed, startTimeMs },
    scenario,
    trace: { report, assertions, events, finalStateHash },
    integrity,
  };
}

export async function replayRecording(envelope: RecordingEnvelope): Promise<ReplayVerification> {
  const integrityChecks: ReplayCheck[] = [
    createCheck(
      'scenario-integrity',
      envelope.integrity.scenarioHash,
      digestValue(envelope.scenario),
    ),
    createCheck(
      'events-integrity',
      envelope.integrity.eventsHash,
      digestValue(envelope.trace.events),
    ),
    createCheck('trace-integrity', envelope.integrity.traceHash, digestValue(envelope.trace)),
  ];
  if (integrityChecks.some((check) => !check.passed)) {
    return sanitizeForExport({
      kind: 'dev.disrunner.replay-verification',
      formatVersion: 1,
      executed: false,
      reproduced: false,
      scenarioPassed: false,
      passed: false,
      checks: integrityChecks,
    });
  }

  const result = sanitizeScenarioRunResult(
    await runScenario(envelope.scenario, {
      profile: { seed: envelope.profile.seed },
      startTimeMs: envelope.profile.startTimeMs,
    }),
  );
  const actualTrace = traceFromResult(result);
  const actualEventsHash = digestValue(actualTrace.events);
  const actualTraceHash = digestValue(actualTrace);
  const checks: ReplayCheck[] = [
    ...integrityChecks,
    createCheck('state-hash', envelope.trace.finalStateHash, actualTrace.finalStateHash),
    createCheck('events-hash', envelope.integrity.eventsHash, actualEventsHash),
    createCheck(
      'events-exact',
      true,
      canonicalStringify(envelope.trace.events) === canonicalStringify(actualTrace.events),
    ),
    createCheck('trace-hash', envelope.integrity.traceHash, actualTraceHash),
    createCheck('scenario-result', envelope.trace.report.passed, result.report.passed),
  ];
  const reproduced = checks.every((check) => check.passed);
  return sanitizeForExport({
    kind: 'dev.disrunner.replay-verification',
    formatVersion: 1,
    executed: true,
    reproduced,
    scenarioPassed: result.report.passed,
    passed: reproduced && result.report.passed,
    checks,
    stateHash: result.finalState.hash,
    eventsHash: actualEventsHash,
    eventCount: result.events.length,
  });
}

function traceFromResult(result: {
  readonly report: SimulationReport;
  readonly assertions: readonly ScenarioAssertionResult[];
  readonly events: readonly GatewayDispatch[];
  readonly finalState: { readonly hash: string };
}): RecordedTrace {
  return {
    report: result.report,
    assertions: result.assertions,
    events: result.events,
    finalStateHash: result.finalState.hash,
  };
}

function parseReport(value: unknown): SimulationReport {
  const report = requireRecord(value, 'Recorded report');
  requireString(report['runId'], 'Recorded run id');
  requireSafeInteger(report['seed'], 'Recorded report seed');
  requireString(report['startedAt'], 'Recorded start timestamp');
  if (typeof report['passed'] !== 'boolean') {
    throw new TypeError('Recorded report passed flag must be boolean.');
  }
  requireArray(report['spans'], 'Recorded spans');
  requireArray(report['risks'], 'Recorded risks');
  requireStateHash(report['stateHash'], 'Recorded report state hash');
  return report as unknown as SimulationReport;
}

function parseEvents(value: unknown): readonly GatewayDispatch[] {
  const events = requireArray(value, 'Recorded events');
  return events.map((entry, index) => {
    const event = requireRecord(entry, `Recorded event ${String(index)}`);
    if (event['op'] !== 0) throw new TypeError(`Recorded event ${String(index)} must use op 0.`);
    const t = requireString(event['t'], `Recorded event ${String(index)} type`);
    const s = requireSafeInteger(event['s'], `Recorded event ${String(index)} sequence`);
    if (s < 0)
      throw new RangeError(`Recorded event ${String(index)} sequence must be non-negative.`);
    return { op: 0, t, s, d: event['d'] };
  });
}

function createCheck(
  name: ReplayCheck['name'],
  expected: string | number | boolean,
  actual: string | number | boolean,
): ReplayCheck {
  return { name, passed: expected === actual, expected, actual };
}

function digestValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForCanonicalJson(value[key])]),
    );
  }
  return value;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  }
  return value.toLowerCase();
}

function requireStateHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 state hash.`);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
