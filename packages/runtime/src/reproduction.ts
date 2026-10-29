import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sanitizeForExport } from '@disrunner/core';

import { loadProjectConfiguration } from './project-config.js';
import { parseBotScenarioV2, type BotScenarioV2, type BotScenarioV2Result } from './scenario-v2.js';
import { openWorkspace } from './workspace.js';
import { hashRegularFile } from './file-read.js';

interface RunInputs {
  readonly schemaVersion: 1;
  readonly fixtureHash: string;
  readonly profileHash: string;
  readonly sourceHash: string | null;
}

export interface ReproductionBundle {
  readonly version: 1;
  readonly kind: 'bot-rerun';
  readonly manifest: {
    readonly engineVersion: string;
    readonly adapter: string;
    readonly sdkPins: Readonly<Record<string, string>>;
    readonly clock: 'realtime';
    readonly seed: number;
    readonly workspaceVersion: 1 | null;
    readonly profile: Readonly<Record<string, unknown>>;
    readonly scenarioHash: string;
    readonly fixtureHash: string;
    readonly reportHash: string;
    readonly originalScenarioHash: string;
    readonly inputFixtureHash: string;
    readonly inputProfileHash: string;
    readonly fixtureCapture: 'run-verified-at-export' | 'project-at-export';
    readonly sourceHashes: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly matchesRun: boolean | null;
    }[];
    readonly redacted: boolean;
    readonly evidenceComplete: boolean;
  };
  readonly scenario: BotScenarioV2;
  readonly fixtures: readonly Readonly<Record<string, unknown>>[];
  readonly report: Readonly<Record<string, unknown>>;
  readonly replayable: false;
  readonly requiresOriginalProject: true;
  readonly reasons: readonly string[];
  readonly integrity: { readonly algorithm: 'sha256'; readonly sha256: string };
}

const MAX_BYTES = 8 * 1_048_576;
const MAX_SOURCE_BYTES = 16 * 1_048_576;
const HASH = /^[0-9a-f]{64}$/u;
const RESOURCE_TYPES = new Set(['guild', 'channel', 'role', 'user', 'member', 'message']);
const ADAPTERS = new Set(['raw-interaction-webhook', 'discord.js', 'discord.py']);
const REPORT_KEYS = [
  'version',
  'execution',
  'name',
  'runId',
  'status',
  'exitCode',
  'assertions',
  'issues',
  'cleanupErrors',
  'observations',
  'snapshot',
  'metadata',
];
const MANIFEST_KEYS = [
  'engineVersion',
  'adapter',
  'sdkPins',
  'clock',
  'seed',
  'workspaceVersion',
  'profile',
  'scenarioHash',
  'fixtureHash',
  'reportHash',
  'originalScenarioHash',
  'inputFixtureHash',
  'inputProfileHash',
  'fixtureCapture',
  'sourceHashes',
  'redacted',
  'evidenceComplete',
];
const BASE_REASONS = [
  'Bot source code, dependencies, environment values and attachment file bytes are omitted. The original project is required.',
  'This bundle is a diagnostic snapshot for a fresh Bot rerun; it does not restore process memory or a session checkpoint.',
];

/** Export diagnostics only. Reading a project never starts its Bot or installs dependencies. */
export async function createReproductionBundle(
  projectRoot: string,
  scenarioSource: unknown,
  result: BotScenarioV2Result,
): Promise<ReproductionBundle> {
  const scenario = parseBotScenarioV2(scenarioSource);
  const originalScenarioHash = rawHash(scenario);
  const reportInput = jsonCopy(result);
  const reportRecord = strictRecord(reportInput, REPORT_KEYS, 'Bot report');
  const metadata = object(reportRecord['metadata'], 'Bot report metadata');
  if (metadata['scenarioHash'] !== originalScenarioHash)
    throw new TypeError('Scenario does not match the supplied Bot report.');
  const configuration = await loadProjectConfiguration(projectRoot);
  if (metadata['adapter'] !== null && metadata['adapter'] !== configuration.adapter.type)
    throw new TypeError('Project adapter does not match the supplied Bot report.');
  const resources = configuration.resources.filter((resource) =>
    RESOURCE_TYPES.has(String(resource['resourceType'])),
  );
  if (resources.length !== configuration.resources.length)
    throw new TypeError('Project contains resources outside the reproduction fixture profile.');
  const workspace = await openWorkspace(configuration.summary.root);
  const inputFixtureHash = rawHash(configuration.resources);
  const inputProfileHash = rawHash(configuration.profile);
  const initialInputs = readRunInputs(metadata['inputs']);
  const fixtureCapture =
    initialInputs?.fixtureHash === inputFixtureHash &&
    initialInputs.profileHash === inputProfileHash
      ? 'run-verified-at-export'
      : 'project-at-export';
  const reasons = [...BASE_REASONS];
  if (fixtureCapture === 'project-at-export')
    reasons.push(
      initialInputs === null
        ? 'The report has no initial input digests. Project fixtures and profile were captured at export.'
        : 'Project fixtures or profile changed after the run. Exported project data is not the original run input.',
    );
  const sourceHashes: { path: string; sha256: string; matchesRun: boolean | null }[] = [];
  if (configuration.entryPoint !== null) {
    const relative = path
      .relative(configuration.summary.root, configuration.entryPoint)
      .split(path.sep)
      .join('/');
    relativeSourcePath(relative);
    const digest = await hashSource(configuration.summary.root, configuration.entryPoint);
    if (digest !== null) {
      const matchesRun =
        initialInputs?.sourceHash == null ? null : initialInputs.sourceHash === digest;
      sourceHashes.push({ path: relative, sha256: digest, matchesRun });
      if (matchesRun !== true)
        reasons.push(
          matchesRun === false
            ? 'The Bot entry file changed after the run.'
            : 'The report has no launch-time Bot source digest.',
        );
    } else
      reasons.push('The Bot entry file digest could not be captured within the source file limit.');
  } else reasons.push('The project has no configured Bot entry file to identify.');

  const privateValues = [
    ...Object.entries(configuration.environment)
      .filter(
        ([key, value]) =>
          value.length >= 4 || /token|secret|password|passwd|credential|api.?key/iu.test(key),
      )
      .map(([, value]) => value),
    configuration.summary.root,
    configuration.summary.cwd,
    configuration.summary.configPath,
    ...(configuration.entryPoint === null ? [] : [configuration.entryPoint]),
  ]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
  const normalizedScenario = { ...scenario, execution: { ...scenario.execution, project: '.' } };
  const initial = {
    scenario: normalizedScenario,
    fixtures: resources,
    profile: { ...configuration.profile },
    report: reportRecord,
    sourceHashes,
  };
  const scrubbed = scrubPrivatePaths(jsonCopy(initial), privateValues);
  const exported = sanitizeForExport(scrubbed, {
    sensitiveValues: privateValues,
    redactPii: true,
    maxDepth: 32,
    maxNodes: 100_000,
    maxEntriesPerContainer: 10_000,
    maxStringLength: 1_000_000,
    maxTotalStringBytes: MAX_BYTES,
  }) as typeof initial;
  const redacted = JSON.stringify(initial) !== JSON.stringify(exported);
  const truncated = JSON.stringify(exported).includes('[REDACTION_');
  if (redacted)
    reasons.push(
      'Secrets, private paths or personal data were redacted. Exported values may differ from the original inputs.',
    );
  if (truncated)
    reasons.push('Export limits shortened diagnostic content. The retained report is incomplete.');
  if (scenario.execution.project !== '.')
    reasons.push(
      'The exported scenario project reference was changed to ".". Use the original project when preparing a rerun.',
    );
  const engine = await packageRoot('@disrunner/runtime');
  const sdkPins: Record<string, string> = {};
  if (configuration.adapter.type !== 'raw-interaction-webhook') {
    const name =
      configuration.adapter.type === 'discord.js'
        ? '@disrunner/adapter-discordjs'
        : '@disrunner/adapter-discordpy';
    const adapter = await packageRoot(name);
    const manifest = object(
      await readSmallJson(path.join(adapter.root, 'manifest.json')),
      'Adapter manifest',
    );
    if (manifest['id'] !== configuration.adapter.type || typeof manifest['sdkVersion'] !== 'string')
      throw new TypeError('Adapter manifest is invalid.');
    sdkPins[configuration.adapter.type] = manifest['sdkVersion'];
  }
  const document: Omit<ReproductionBundle, 'integrity'> = {
    version: 1,
    kind: 'bot-rerun',
    manifest: {
      engineVersion: engine.version,
      adapter: configuration.adapter.type,
      sdkPins,
      clock: 'realtime',
      seed: configuration.profile.seed,
      workspaceVersion: workspace.document?.version ?? null,
      profile: exported.profile,
      scenarioHash: contentHash(exported.scenario),
      fixtureHash: contentHash(exported.fixtures),
      reportHash: contentHash(exported.report),
      originalScenarioHash,
      inputFixtureHash,
      inputProfileHash,
      fixtureCapture,
      sourceHashes: exported.sourceHashes,
      redacted,
      evidenceComplete: metadata['evidenceComplete'] === true && !truncated,
    },
    scenario: exported.scenario,
    fixtures: exported.fixtures,
    report: exported.report,
    replayable: false,
    requiresOriginalProject: true,
    reasons,
  };
  const bundle = {
    ...document,
    integrity: { algorithm: 'sha256' as const, sha256: contentHash(document) },
  };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BYTES)
    throw new RangeError('Reproduction bundle exceeds the 8 MiB limit.');
  return parseReproductionBundle(bundle);
}

/** Validate a diagnostic bundle without writing files, changing a project, or executing code. */
export function parseReproductionBundle(input: unknown): ReproductionBundle {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_BYTES)
      throw new RangeError('Reproduction bundle exceeds the 8 MiB limit.');
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new TypeError('Reproduction bundle is not valid JSON.');
    }
  }
  const copied = jsonCopy(value);
  const bundle = strictRecord(
    copied,
    [
      'version',
      'kind',
      'manifest',
      'scenario',
      'fixtures',
      'report',
      'replayable',
      'requiresOriginalProject',
      'reasons',
      'integrity',
    ],
    'Reproduction bundle',
  );
  if (
    bundle['version'] !== 1 ||
    bundle['kind'] !== 'bot-rerun' ||
    bundle['replayable'] !== false ||
    bundle['requiresOriginalProject'] !== true
  )
    throw new TypeError('Unsupported reproduction bundle version or replay contract.');
  const manifest = strictRecord(bundle['manifest'], MANIFEST_KEYS, 'Reproduction manifest');
  if (
    typeof manifest['engineVersion'] !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest['engineVersion']) ||
    typeof manifest['adapter'] !== 'string' ||
    !ADAPTERS.has(manifest['adapter']) ||
    manifest['clock'] !== 'realtime' ||
    !Number.isInteger(manifest['seed']) ||
    (manifest['seed'] as number) < 0 ||
    (manifest['seed'] as number) > 0xffff_ffff ||
    ![1, null].includes(manifest['workspaceVersion'] as number | null) ||
    typeof manifest['redacted'] !== 'boolean' ||
    typeof manifest['evidenceComplete'] !== 'boolean' ||
    !['run-verified-at-export', 'project-at-export'].includes(String(manifest['fixtureCapture']))
  )
    throw new TypeError('Reproduction manifest metadata is invalid.');
  const pins = object(manifest['sdkPins'], 'SDK pins');
  const pinKeys = Object.keys(pins);
  if (
    manifest['adapter'] === 'raw-interaction-webhook'
      ? pinKeys.length !== 0
      : pinKeys.length !== 1 ||
        pinKeys[0] !== manifest['adapter'] ||
        typeof pins[pinKeys[0]] !== 'string' ||
        !/^\d+\.\d+\.\d+$/u.test(pins[pinKeys[0]] as string)
  )
    throw new TypeError('Reproduction SDK pins are invalid.');
  const profile = object(manifest['profile'], 'Reproduction profile');
  const profileKeys = [
    'mode',
    'seed',
    'intents',
    'networkPolicy',
    'hotReload',
    'ordinaryMessagePermissions',
    ...(Object.hasOwn(profile, 'commandRegistry') ? ['commandRegistry'] : []),
  ];
  strictRecord(profile, profileKeys, 'Reproduction profile');
  if (profile['networkPolicy'] !== 'offline' || profile['seed'] !== manifest['seed'])
    throw new TypeError('Reproduction profile does not match its manifest.');
  const scenario = parseBotScenarioV2(bundle['scenario']);
  if (scenario.execution.project !== '.')
    throw new TypeError('Reproduction scenario must use the local project reference ".".');
  if (!Array.isArray(bundle['fixtures']) || bundle['fixtures'].length > 10_000)
    throw new TypeError('Reproduction fixtures exceed their resource limit.');
  for (const fixture of bundle['fixtures']) {
    const resource = object(fixture, 'Reproduction fixture');
    if (!RESOURCE_TYPES.has(String(resource['resourceType'])) || typeof resource['id'] !== 'string')
      throw new TypeError('Reproduction fixture is outside the supported resource profile.');
  }
  const report = strictRecord(bundle['report'], REPORT_KEYS, 'Reproduction report');
  if (
    report['version'] !== 2 ||
    report['execution'] !== 'bot' ||
    typeof report['status'] !== 'string' ||
    !['passed', 'failed', 'invalid', 'runner-error', 'cancelled'].includes(report['status']) ||
    !Number.isSafeInteger(report['exitCode']) ||
    typeof report['name'] !== 'string' ||
    (report['runId'] !== null && typeof report['runId'] !== 'string')
  )
    throw new TypeError('Reproduction report must describe a Bot run.');
  for (const key of ['assertions', 'issues', 'cleanupErrors', 'observations'])
    if (!Array.isArray(report[key]) || report[key].length > 1000)
      throw new TypeError('Reproduction report collection is invalid.');
  const reportMetadata = object(report['metadata'], 'Reproduction report metadata');
  if (
    reportMetadata['schemaVersion'] !== 2 ||
    reportMetadata['clock'] !== 'realtime' ||
    reportMetadata['replay'] !== 'bot-rerun' ||
    typeof reportMetadata['evidenceComplete'] !== 'boolean'
  )
    throw new TypeError('Reproduction report metadata is invalid.');
  if (reportMetadata['scenarioHash'] !== manifest['originalScenarioHash'])
    throw new TypeError('Reproduction report scenario identity does not match.');
  for (const key of [
    'scenarioHash',
    'fixtureHash',
    'reportHash',
    'originalScenarioHash',
    'inputFixtureHash',
    'inputProfileHash',
  ])
    if (typeof manifest[key] !== 'string' || !HASH.test(manifest[key]))
      throw new TypeError('Reproduction digest is invalid.');
  if (
    contentHash(bundle['scenario']) !== manifest['scenarioHash'] ||
    contentHash(bundle['fixtures']) !== manifest['fixtureHash'] ||
    contentHash(report) !== manifest['reportHash']
  )
    throw new TypeError('Reproduction content digest does not match.');
  if (!Array.isArray(manifest['sourceHashes']) || manifest['sourceHashes'].length > 1)
    throw new TypeError('Reproduction source metadata is invalid.');
  for (const source of manifest['sourceHashes']) {
    const item = strictRecord(source, ['path', 'sha256', 'matchesRun'], 'Source metadata');
    relativeSourcePath(item['path']);
    if (
      typeof item['sha256'] !== 'string' ||
      !HASH.test(item['sha256']) ||
      ![true, false, null].includes(item['matchesRun'] as boolean | null)
    )
      throw new TypeError('Reproduction source digest is invalid.');
  }
  if (
    !Array.isArray(bundle['reasons']) ||
    bundle['reasons'].length < 2 ||
    bundle['reasons'].length > 20 ||
    bundle['reasons'].some((reason) => typeof reason !== 'string' || reason.length > 1000)
  )
    throw new TypeError('Reproduction limitations are invalid.');
  if (JSON.stringify(scrubPrivatePaths(copied, [])) !== JSON.stringify(copied))
    throw new TypeError('Reproduction bundle contains an absolute private path.');
  const integrity = strictRecord(
    bundle['integrity'],
    ['algorithm', 'sha256'],
    'Reproduction integrity',
  );
  if (
    integrity['algorithm'] !== 'sha256' ||
    typeof integrity['sha256'] !== 'string' ||
    !HASH.test(integrity['sha256'])
  )
    throw new TypeError('Reproduction integrity metadata is invalid.');
  const { integrity: ignored, ...content } = bundle;
  void ignored;
  if (contentHash(content) !== integrity['sha256'])
    throw new TypeError('Reproduction bundle integrity check failed.');
  return copied as ReproductionBundle;
}

function jsonCopy(value: unknown): unknown {
  let bytes = 0;
  let nodes = 0;
  const active = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32)
      throw new RangeError('Reproduction data exceeds its structure limit.');
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current);
      if (bytes > MAX_BYTES) throw new RangeError('Reproduction data exceeds the 8 MiB limit.');
      return current;
    }
    if (
      current === null ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    )
      return current;
    if (typeof current !== 'object' || current === null || active.has(current))
      throw new TypeError('Reproduction data must be a JSON tree.');
    const array = Array.isArray(current);
    if (
      Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(current) !== null
    )
      throw new TypeError('Reproduction data must use plain JSON objects.');
    active.add(current);
    const output: unknown[] | Record<string, unknown> = array ? [] : {};
    const keys = Reflect.ownKeys(current);
    if (array && (current.length > 100_000 || keys.length !== current.length + 1))
      throw new TypeError('Reproduction arrays must be dense.');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw new TypeError('Reproduction data contains an unsupported property.');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
        throw new TypeError('Reproduction data must not contain accessors.');
      bytes += Buffer.byteLength(key);
      if (bytes > MAX_BYTES) throw new RangeError('Reproduction data exceeds the 8 MiB limit.');
      if (array) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length)
          throw new TypeError('Reproduction arrays must contain indexed data only.');
        (output as unknown[])[Number(key)] = visit(descriptor.value, depth + 1);
      } else (output as Record<string, unknown>)[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(current);
    return output;
  };
  const copied = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copied)) > MAX_BYTES)
    throw new RangeError('Reproduction bundle exceeds the 8 MiB limit.');
  return copied;
}

function scrubPrivatePaths(value: unknown, privateValues: readonly string[]): unknown {
  const scrub = (source: string): string => {
    let text = source;
    for (const secret of privateValues) text = text.split(secret).join('[REDACTED]');
    if (path.posix.isAbsolute(text) || path.win32.isAbsolute(text)) return '[PRIVATE_PATH]';
    return text
      .replace(/file:\/\/[^\s"'<>]+/giu, '[PRIVATE_PATH]')
      .replace(/(^|[\s("'=:[])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"'<>]*/gu, '$1[PRIVATE_PATH]');
  };
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return scrub(current);
    if (Array.isArray(current)) return current.map(visit);
    if (current !== null && typeof current === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        let safeKey = scrub(key);
        while (Object.hasOwn(output, safeKey)) safeKey += '#';
        output[safeKey] = visit(entry);
      }
      return output;
    }
    return current;
  };
  return visit(value);
}

function readRunInputs(value: unknown): RunInputs | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input['schemaVersion'] !== 1 ||
    typeof input['fixtureHash'] !== 'string' ||
    !HASH.test(input['fixtureHash']) ||
    typeof input['profileHash'] !== 'string' ||
    !HASH.test(input['profileHash']) ||
    (input['sourceHash'] !== null &&
      (typeof input['sourceHash'] !== 'string' || !HASH.test(input['sourceHash'])))
  )
    return null;
  return input as unknown as RunInputs;
}

function rawHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function contentHash(value: unknown): string {
  const canonical = (current: unknown): unknown =>
    Array.isArray(current)
      ? current.map(canonical)
      : current !== null && typeof current === 'object'
        ? Object.fromEntries(
            Object.keys(current)
              .sort()
              .map((key) => [key, canonical((current as Record<string, unknown>)[key])]),
          )
        : current;
  return rawHash(canonical(value));
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = object(value, label);
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new TypeError(`${label} has missing or unknown fields.`);
  return record;
}
function relativeSourcePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > 4096 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes(':') ||
    value.split('/').some((segment) => segment === '' || segment === '..')
  )
    throw new TypeError('Source metadata must use a project-relative file path.');
}

async function hashSource(root: string, filename: string): Promise<string | null> {
  try {
    const canonical = await realpath(filename);
    const relative = path.relative(root, canonical);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new TypeError('Bot source must remain within the project.');
    return await hashRegularFile(canonical, MAX_SOURCE_BYTES);
  } catch {
    return null;
  }
}
async function packageRoot(name: string): Promise<{ root: string; version: string }> {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    try {
      const manifest = object(
        await readSmallJson(path.join(directory, 'package.json')),
        'Package manifest',
      );
      if (manifest['name'] === name && typeof manifest['version'] === 'string')
        return { root: directory, version: manifest['version'] };
    } catch {
      /* Continue through the resolved package's parent directories. */
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new TypeError('Runtime package version metadata is unavailable.');
    directory = parent;
  }
}
async function readSmallJson(filename: string): Promise<unknown> {
  const source = await readFile(filename);
  if (source.byteLength > 16_384) throw new RangeError('Package metadata exceeds its size limit.');
  return JSON.parse(source.toString('utf8')) as unknown;
}
