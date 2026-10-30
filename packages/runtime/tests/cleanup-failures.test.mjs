// Failure-safe runtime cleanup oracles against the real shared Session/manager orchestration.
//
// Injection uses only the internal, instance-scoped resource dependency seam
// (createSessionWithDependencies / third RuntimeManager constructor argument). Wrappers are
// test-owned and record two append-only logs:
// - journal: {resource, operation, attempt, phase} for every wrapper method call
//   (invoke, then resolve or reject). It says nothing about whether the real method ran.
// - delegations: {resource, operation, attempt}, recorded only when the wrapper actually calls
//   the original resource method.
// Injection points: "pre" rejects before delegating (the real method never ran); "post"
// delegates, waits for the real method to settle, then rejects (the real method ran).
// Real effects are proven separately: /proc identity (state, starttime) for processes reported
// by the fixture itself, ECONNREFUSED plus re-listen for ports, and handle counts. A pid of null
// in a snapshot only means no active PID is published; it is never used as proof of exit.
// Expected journals below are literal tables, not snapshots produced by a run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as core from '@disrunner/core';
import * as publicIndex from '../dist/index.js';
import * as sessionModule from '../dist/session.js';

const isLinux = process.platform === 'linux';
const linuxOnly = !isLinux && 'Linux-only /proc evidence';
const project = fileURLToPath(new URL('./fixtures/lifecycle/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const CONTROL_NAME = 'disrunner-lifecycle-control.json';
const SENTINEL = `SENTINEL-${randomUUID()}`;
const TOKEN_SHAPED = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;
const INJECTED_SUFFIX = `Bot ${TOKEN_SHAPED} Authorization: Bot ${'D'.repeat(32)}`;

// Fixture mode channel (same as lifecycle.test.mjs): BotRunner inherits TMPDIR.
const originalTmpdir = process.env.TMPDIR;
const controlDirectory = mkdtempSync(join(originalTmpdir ?? tmpdir(), 'disrunner-cleanup-'));
process.env.TMPDIR = controlDirectory;
after(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  rmSync(controlDirectory, { recursive: true, force: true });
});

let reportCounter = 0;
let reportPath = '';
let testReportPaths = [];
let harnesses = [];
let sessions = [];
let managers = [];
let controls = [];

beforeEach(() => {
  harnesses = [];
  sessions = [];
  managers = [];
  controls = [];
  testReportPaths = [];
});

afterEach(async () => {
  // Remove injected faults so teardown uses the real runtime cleanup, never a kill.
  for (const harness of harnesses) harness.healAll();
  for (const session of sessions) await session.dispose();
  for (const manager of managers) await manager.stop();
  const contained = [];
  const unverified = [];
  const recorded = testReportPaths.flatMap((path) =>
    readReport(path).filter((entry) => entry.event === 'identity'),
  );
  for (const record of recorded) {
    // Never signal a recorded PID without its original identity and a fresh exact match.
    if (typeof record.starttime !== 'string' || !/^\d+$/u.test(record.starttime)) {
      unverified.push(`${record.role}:${record.pid}`);
      continue;
    }
    let current;
    try {
      current = readProcStat(record.pid);
    } catch {
      unverified.push(`${record.role}:${record.pid}`);
      continue;
    }
    if (current?.starttime === record.starttime && current.state !== 'Z' && current.state !== 'X') {
      contained.push(`${record.role}:${record.pid}`);
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
  }
  for (const control of controls) await control.release();
  if (unverified.length > 0)
    throw new Error(`Containment refused unverified process identities: ${unverified.join(', ')}`);
  if (contained.length > 0)
    throw new Error(`Watchdog containment had to kill leftover processes: ${contained.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// Observation helpers (independent of the runtime under test)

function useMode(mode) {
  reportCounter += 1;
  reportPath = join(controlDirectory, `report-${reportCounter}.jsonl`);
  writeFileSync(reportPath, '');
  testReportPaths.push(reportPath);
  writeFileSync(join(controlDirectory, CONTROL_NAME), JSON.stringify({ mode, reportPath }));
}

function readReport(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

function reports() {
  return reportPath === '' ? [] : readReport(reportPath);
}

function identities() {
  return reports().filter((entry) => entry.event === 'identity');
}

function fixtureEvents(name) {
  return reports().filter((entry) => entry.event === name);
}

function readProcStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], pgid: Number(fields[2]), starttime: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error; // Unreadable identity is unknown, never evidence that the process died.
  }
}

/** Alive only if /proc exists, starttime matches and the state is not zombie/dead. */
function isAlive(record) {
  const stat = readProcStat(record.pid);
  if (stat === null) return false;
  if (record.starttime !== null && stat.starttime !== record.starttime) return false;
  return stat.state !== 'Z' && stat.state !== 'X';
}

function assertTreeAlive(records, label) {
  assert.ok(records.length >= 2, `${label}: parent and grandchild identities reported`);
  for (const record of records)
    assert.equal(isAlive(record), true, `${label}: ${record.role}:${record.pid} alive`);
}

function assertTreeDead(records, label) {
  assert.ok(records.length >= 2, `${label}: parent and grandchild identities reported`);
  for (const record of records)
    assert.equal(isAlive(record), false, `${label}: ${record.role}:${record.pid} ended`);
}

async function waitFor(description, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await sleep(10);
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function connectOutcome(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise('open');
    });
    socket.once('error', (error) => resolvePromise(error.code));
  });
}

function listenOnce(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(port)));
  });
}

async function assertClosed(port, label) {
  assert.equal(await connectOutcome(port), 'ECONNREFUSED', `${label}: port ${port} closed`);
  assert.equal(await listenOnce(port), port, `${label}: port ${port} reusable`);
}

async function assertListening(port, label) {
  assert.equal(await connectOutcome(port), 'open', `${label}: port ${port} still listening`);
}

function trackedHandles() {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return Object.fromEntries(
    ['Timeout', 'ChildProcess', 'PipeWrap', 'TCPServerWrap', 'TCPSocketWrap'].map((type) => [
      type,
      counts[type] ?? 0,
    ]),
  );
}

async function settledBaseline() {
  let previous = trackedHandles();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(20);
    const current = trackedHandles();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

async function excessHandles(baseline) {
  const deadline = Date.now() + 3_000;
  const excess = () =>
    Object.fromEntries(
      Object.entries(trackedHandles()).filter(([type, count]) => count > (baseline[type] ?? 0)),
    );
  let current = excess();
  while (Object.keys(current).length > 0 && Date.now() < deadline) {
    await sleep(25);
    current = excess();
  }
  return current;
}

/** Unrelated test-owned control process outside the runner's group; it must survive. */
async function startControl() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  const stat = readProcStat(child.pid);
  const record = { role: 'control', pid: child.pid, starttime: stat?.starttime ?? null };
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  const control = {
    record,
    assertAlive(label) {
      assert.equal(isAlive(record), true, `${label}: unrelated control process survived`);
    },
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
  controls.push(control);
  return control;
}

function portOf(url) {
  return Number(new URL(url).port);
}

function request(runId, requestId, input) {
  return { runId, requestId, input, context };
}

// ---------------------------------------------------------------------------------------------
// Test-owned wrapper harness

const J = (resource, operation, attempt, phase) => ({ resource, operation, attempt, phase });
const D = (resource, operation, attempt) => ({ resource, operation, attempt });
const ok = (resource, operation, attempt) => [
  J(resource, operation, attempt, 'invoke'),
  J(resource, operation, attempt, 'resolve'),
];
const fail = (resource, operation, attempt) => [
  J(resource, operation, attempt, 'invoke'),
  J(resource, operation, attempt, 'reject'),
];

// Literal journal of a healthy start: Gateway, then REST, then Bot.
const HEALTHY_START = [
  ...ok('gateway', 'wrap', 1),
  ...ok('gateway', 'start', 1),
  ...ok('rest', 'wrap', 1),
  ...ok('rest', 'start', 1),
  ...ok('bot', 'wrap', 1),
  ...ok('bot', 'start', 1),
];
const HEALTHY_START_DELEGATIONS = [
  D('gateway', 'start', 1),
  D('rest', 'start', 1),
  D('bot', 'start', 1),
];

let sequence = 0;

function createHarness(initialFaults = {}) {
  const journal = [];
  const delegations = [];
  const timeline = [];
  const endpointLog = [];
  const counts = new Map();
  const faults = { ...initialFaults };
  const hooks = {};
  const originals = { bot: [], rest: [], gateway: [] };
  const wrappers = { bot: [], rest: [], gateway: [] };
  const wrapArgumentCounts = { bot: [], rest: [], gateway: [] };
  const captured = {};
  const overrides = {};

  const record = (resource, operation, attempt, phase) => {
    journal.push(J(resource, operation, attempt, phase));
    timeline.push({ seq: ++sequence, kind: 'journal', resource, operation, attempt, phase });
  };
  const next = (resource, operation) => {
    const key = `${resource}.${operation}`;
    const attempt = (counts.get(key) ?? 0) + 1;
    counts.set(key, attempt);
    return attempt;
  };
  const faultFor = (resource, operation, attempt) =>
    faults[`${resource}.${operation}.${attempt}`] ?? faults[`${resource}.${operation}.*`];
  const injected = (resource, operation) =>
    new Error(`${SENTINEL} injected ${resource}.${operation} failure ${INJECTED_SUFFIX}`);

  async function call(resource, operation, delegate) {
    const attempt = next(resource, operation);
    record(resource, operation, attempt, 'invoke');
    await hooks[`${resource}.${operation}.${attempt}.invoke`]?.();
    const mode = faultFor(resource, operation, attempt);
    if (mode === 'pre') {
      record(resource, operation, attempt, 'reject');
      throw injected(resource, operation);
    }
    delegations.push(D(resource, operation, attempt));
    let value;
    try {
      value = await delegate();
    } catch (error) {
      record(resource, operation, attempt, 'reject');
      throw error;
    }
    await hooks[`${resource}.${operation}.${attempt}.delegated`]?.(value);
    if (mode === 'post') {
      record(resource, operation, attempt, 'reject');
      throw injected(resource, operation);
    }
    record(resource, operation, attempt, 'resolve');
    return value;
  }

  function wrapEntry(resource, args, build) {
    const attempt = next(resource, 'wrap');
    record(resource, 'wrap', attempt, 'invoke');
    wrapArgumentCounts[resource].push(args.length);
    originals[resource].push(args[0]);
    if (faultFor(resource, 'wrap', attempt) === 'throw') {
      record(resource, 'wrap', attempt, 'reject');
      throw injected(resource, 'wrap');
    }
    const wrapper = build(args[0]);
    wrappers[resource].push(wrapper);
    record(resource, 'wrap', attempt, 'resolve');
    return wrapper;
  }

  const buildBot = (original) => {
    const wrapper = {
      start: (config) => call('bot', 'start', () => original.start(config)),
      stop: (...stopArgs) =>
        overrides.botStop
          ? overrides.botStop(...stopArgs)
          : call('bot', 'stop', () => original.stop(...stopArgs)),
      snapshot: () => original.snapshot(),
    };
    if ('observeExit' in original)
      wrapper.observeExit = () => overrides.observeExit?.() ?? original.observeExit();
    return wrapper;
  };
  const buildRest = (original) => ({
    start: (port) =>
      call('rest', 'start', async () => {
        const address = await original.start(port);
        captured.restPort = address?.port;
        return address;
      }),
    stop: () => call('rest', 'stop', () => original.stop()),
  });
  const buildGateway = (original) => {
    const wrapper = {
      start: (port) => {
        captured.gatewayPort = port;
        return call('gateway', 'start', () => original.start(port));
      },
      stop: () => call('gateway', 'stop', () => original.stop()),
    };
    Object.defineProperty(wrapper, 'address', {
      enumerable: true,
      get: () => original.address,
    });
    return wrapper;
  };

  const harness = {
    journal,
    delegations,
    timeline,
    endpointLog,
    faults,
    hooks,
    originals,
    wrappers,
    wrapArgumentCounts,
    captured,
    overrides,
    events: [],
    results: [],
    onEndpoints: (value) => {
      const entry = { seq: ++sequence, endpoints: value === null ? null : 'present', value };
      endpointLog.push(entry);
      timeline.push({ seq: entry.seq, kind: 'endpoints', endpoints: entry.endpoints });
    },
    dependencies: {
      wrapBot: (...args) => wrapEntry('bot', args, buildBot),
      wrapRest: (...args) => wrapEntry('rest', args, buildRest),
      wrapGateway: (...args) => wrapEntry('gateway', args, buildGateway),
    },
    healAll() {
      for (const key of Object.keys(faults)) delete faults[key];
      for (const key of Object.keys(hooks)) delete hooks[key];
    },
    stopsFrom(index = 0) {
      return journal.slice(index).filter((entry) => entry.operation === 'stop');
    },
    lastEndpoints() {
      return endpointLog.filter((entry) => entry.value !== null).at(-1)?.value;
    },
  };
  harnesses.push(harness);
  return harness;
}

function requireFactory() {
  const factory = sessionModule.createSessionWithDependencies;
  assert.equal(
    typeof factory,
    'function',
    'internal createSessionWithDependencies factory is available from the built module',
  );
  return factory;
}

function newSession(harness) {
  const factory = requireFactory();
  const session = factory({ onEndpoints: harness.onEndpoints }, harness.dependencies);
  sessions.push(session);
  session.subscribe((event) => harness.events.push(event));
  return session;
}

function newManager(harness) {
  const manager = new publicIndex.DesktopRuntimeManager(
    () => undefined,
    harness.onEndpoints,
    harness.dependencies,
  );
  managers.push(manager);
  return manager;
}

async function recorded(harness, operation) {
  const result = await operation;
  harness.results.push(result);
  return result;
}

function endpointPorts(harness) {
  const endpoints = harness.lastEndpoints();
  assert.ok(endpoints !== undefined, 'endpoints were published by the healthy start');
  return {
    rest: portOf(endpoints.restBaseUrl),
    gateway: portOf(endpoints.gatewayUrl),
    bot: endpoints.interactionEndpoint === undefined ? null : portOf(endpoints.interactionEndpoint),
  };
}

/** Injected sentinel text, and credential-shaped text, must not reach public surfaces. */
function assertNoLeak(harness, session, { allowPlainSentinel = false } = {}) {
  const surface = JSON.stringify({
    events: harness.events,
    results: harness.results,
    snapshot: session?.snapshot(),
  });
  assert.equal(surface.includes(TOKEN_SHAPED), false, 'credential-shaped text is not exposed');
  assert.equal(surface.includes('D'.repeat(32)), false, 'authorization-shaped text is not exposed');
  if (!allowPlainSentinel)
    assert.equal(surface.includes(SENTINEL), false, 'injected sentinel is not exposed');
  return surface.includes(SENTINEL);
}

function assertNeverRunning(harness, label) {
  assert.equal(
    harness.events.some((event) => event.snapshot.phase === 'running'),
    false,
    `${label}: no event ever reported phase running`,
  );
}

function issueMatches(issue, resource) {
  const pattern = { bot: /\bbot\b/iu, rest: /\bREST\b/u, gateway: /\bgateway\b/iu }[resource];
  return issue.code === 'cleanup' && pattern.test(issue.message);
}

function assertCleanupIssues(result, resources, label) {
  const cleanup = result.errors.filter((issue) => issue.code === 'cleanup');
  assert.equal(cleanup.length, resources.length, `${label}: ${JSON.stringify(result.errors)}`);
  resources.forEach((resource, index) =>
    assert.ok(issueMatches(cleanup[index], resource), `${label}: issue ${index} names ${resource}`),
  );
}

function assertRetainedSnapshot(snapshot, label) {
  assert.ok(!['ready', 'idle', 'running'].includes(snapshot.phase), `${label}: ${snapshot.phase}`);
  assert.equal(snapshot.endpoints, null, `${label}: endpoints revoked`);
  // pid:null only means no active PID is published; it is not evidence of exit.
  assert.equal(snapshot.pid, null, `${label}: no active PID published`);
}

async function healthyStart(harness, session) {
  await session.selectProject(project);
  const started = await session.start();
  assert.equal(started.phase, 'running');
  assert.deepEqual(harness.journal, HEALTHY_START);
  assert.deepEqual(harness.delegations, HEALTHY_START_DELEGATIONS);
  return started;
}

async function finish(harness, session, baseline, control, label) {
  const disposed = await recorded(harness, session.dispose());
  assert.equal(disposed.ok, true, `${label}: final dispose ${JSON.stringify(disposed.errors)}`);
  control.assertAlive(label);
  assert.deepEqual(await excessHandles(baseline), {}, `${label}: handles back to baseline`);
}

async function prepare(mode = 'normal', faults = {}) {
  useMode(mode);
  const harness = createHarness(faults);
  const session = newSession(harness);
  const control = await startControl();
  const baseline = await settledBaseline();
  return { harness, session, control, baseline };
}

function missingDirectory() {
  return join(controlDirectory, `missing-project-${randomUUID()}`);
}

async function rejection(promise) {
  return promise.then(
    () => null,
    (error) => error,
  );
}

// ---------------------------------------------------------------------------------------------
// CLOSE: healthy start, then inject at stop (pre: the real close never ran).

const closeCases = [
  {
    id: 'C01',
    retryId: 'R02',
    faults: { 'bot.stop.1': 'pre' },
    stops: [...fail('bot', 'stop', 1), ...ok('rest', 'stop', 1), ...ok('gateway', 'stop', 1)],
    delegations: [D('rest', 'stop', 1), D('gateway', 'stop', 1)],
    failed: ['bot'],
    retryStops: [...ok('bot', 'stop', 2)],
    retryDelegations: [D('bot', 'stop', 2)],
  },
  {
    id: 'C02',
    retryId: 'R03',
    faults: { 'rest.stop.1': 'pre' },
    stops: [...ok('bot', 'stop', 1), ...fail('rest', 'stop', 1), ...ok('gateway', 'stop', 1)],
    delegations: [D('bot', 'stop', 1), D('gateway', 'stop', 1)],
    failed: ['rest'],
    retryStops: [...ok('rest', 'stop', 2)],
    retryDelegations: [D('rest', 'stop', 2)],
  },
  {
    id: 'C03',
    retryId: 'R03',
    faults: { 'gateway.stop.1': 'pre' },
    stops: [...ok('bot', 'stop', 1), ...ok('rest', 'stop', 1), ...fail('gateway', 'stop', 1)],
    delegations: [D('bot', 'stop', 1), D('rest', 'stop', 1)],
    failed: ['gateway'],
    retryStops: [...ok('gateway', 'stop', 2)],
    retryDelegations: [D('gateway', 'stop', 2)],
  },
  {
    id: 'C04',
    retryId: 'R03',
    faults: { 'bot.stop.1': 'pre', 'rest.stop.1': 'pre' },
    stops: [...fail('bot', 'stop', 1), ...fail('rest', 'stop', 1), ...ok('gateway', 'stop', 1)],
    delegations: [D('gateway', 'stop', 1)],
    failed: ['bot', 'rest'],
    retryStops: [...ok('bot', 'stop', 2), ...ok('rest', 'stop', 2)],
    retryDelegations: [D('bot', 'stop', 2), D('rest', 'stop', 2)],
  },
  {
    id: 'C05',
    retryId: 'R03',
    faults: { 'bot.stop.1': 'pre', 'rest.stop.1': 'pre', 'gateway.stop.1': 'pre' },
    stops: [...fail('bot', 'stop', 1), ...fail('rest', 'stop', 1), ...fail('gateway', 'stop', 1)],
    delegations: [],
    failed: ['bot', 'rest', 'gateway'],
    retryStops: [...ok('bot', 'stop', 2), ...ok('rest', 'stop', 2), ...ok('gateway', 'stop', 2)],
    retryDelegations: [D('bot', 'stop', 2), D('rest', 'stop', 2), D('gateway', 'stop', 2)],
  },
];

for (const item of closeCases) {
  test(
    `${item.id} close failure (pre) attempts every resource; ${item.retryId} healthy retry`,
    { skip: linuxOnly, timeout: 30_000 },
    async (t) => {
      const { harness, session, control, baseline } = await prepare('normal', item.faults);
      await healthyStart(harness, session);
      const tree = identities();
      const ports = endpointPorts(harness);
      const journalMark = harness.journal.length;
      const delegationMark = harness.delegations.length;

      const stopped = await recorded(harness, session.stop());
      assert.equal(stopped.ok, false);
      assert.deepEqual(harness.journal.slice(journalMark), item.stops);
      assert.deepEqual(harness.delegations.slice(delegationMark), item.delegations);
      assertCleanupIssues(stopped, item.failed, item.id);
      assertRetainedSnapshot(stopped.snapshot, item.id);
      assertRetainedSnapshot(session.snapshot(), item.id);

      // Independent observation: succeeded siblings truly closed, failed ones still held.
      if (item.failed.includes('bot')) assertTreeAlive(tree, `${item.id} bot retained`);
      else assertTreeDead(tree, `${item.id} bot closed`);
      if (item.failed.includes('rest')) await assertListening(ports.rest, `${item.id} REST`);
      else await assertClosed(ports.rest, `${item.id} REST`);
      if (item.failed.includes('gateway'))
        await assertListening(ports.gateway, `${item.id} Gateway`);
      else await assertClosed(ports.gateway, `${item.id} Gateway`);
      control.assertAlive(item.id);

      // Ownership retained: restart is blocked and causes no wrapper call.
      const blockedMark = harness.journal.length;
      await assert.rejects(session.start(), { code: 'invalid' });
      assert.equal(harness.journal.length, blockedMark);

      // Healthy retry: only retained resources get a second attempt.
      harness.healAll();
      const retryMark = harness.journal.length;
      const retryDelegationMark = harness.delegations.length;
      const retried = await recorded(harness, session.stop());
      assert.equal(retried.ok, true, JSON.stringify(retried.errors));
      assert.deepEqual(retried.errors, []);
      assert.deepEqual(harness.journal.slice(retryMark), item.retryStops);
      assert.deepEqual(harness.delegations.slice(retryDelegationMark), item.retryDelegations);
      assertTreeDead(tree, `${item.id} after retry`);
      await assertClosed(ports.rest, `${item.id} REST after retry`);
      await assertClosed(ports.gateway, `${item.id} Gateway after retry`);
      if (ports.bot !== null) await assertClosed(ports.bot, `${item.id} bot port after retry`);
      assert.equal(session.snapshot().phase, 'ready');

      // Released: a later start succeeds with healthy wrappers.
      let again;
      try {
        again = await session.start();
      } catch (error) {
        try {
          const failed = session.snapshot();
          t.diagnostic(
            JSON.stringify({
              caseId: item.id,
              phase: failed.phase,
              interactionEndpoint: harness.lastEndpoints()?.interactionEndpoint ?? null,
              botOutput: failed.output.slice(-32),
              fixtureEvents: reports().slice(-64),
            }),
          );
        } catch {
          // Diagnostic collection must not replace the original startup failure.
        }
        throw error;
      }
      assert.equal(again.phase, 'running');
      assertNoLeak(harness, session);
      await finish(harness, session, baseline, control, item.id);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// RETRY

test(
  'R01 after a bot close failure, start and selectProject reject without reading config',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare('normal', {
      'bot.stop.1': 'pre',
    });
    await healthyStart(harness, session);
    const stopped = await recorded(harness, session.stop());
    assert.equal(stopped.ok, false);
    const before = session.snapshot();
    const journalMark = harness.journal.length;
    const delegationMark = harness.delegations.length;
    const identityCount = identities().length;

    await assert.rejects(session.start(), { code: 'invalid' });
    const selection = await rejection(session.selectProject(missingDirectory()));
    assert.ok(selection !== null, 'selectProject rejected');
    assert.equal(selection.code, 'invalid');
    assert.doesNotMatch(selection.message, /configuration could not be validated/iu);
    assert.deepEqual(session.snapshot().project, before.project, 'project not replaced');
    assert.equal(session.snapshot().error, before.error, 'failure text preserved');
    assert.equal(harness.journal.length, journalMark, 'no wrapper call');
    assert.equal(harness.delegations.length, delegationMark, 'no delegation');
    assert.equal(identities().length, identityCount, 'nothing spawned');
    harness.healAll();
    assert.equal((await recorded(harness, session.stop())).ok, true);
    assertNoLeak(harness, session);
    await finish(harness, session, baseline, control, 'R01');
  },
);

test(
  'R04 concurrent stop/stop share one close attempt per resource',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare();
    await healthyStart(harness, session);
    const tree = identities();
    const mark = harness.journal.length;
    const delegationMark = harness.delegations.length;
    const [first, second] = await Promise.all([session.stop(), session.stop()]);
    harness.results.push(first, second);
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    assert.deepEqual(harness.journal.slice(mark), [
      ...ok('bot', 'stop', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ]);
    assert.deepEqual(harness.delegations.slice(delegationMark), [
      D('bot', 'stop', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ]);
    assertTreeDead(tree, 'R04');
    await finish(harness, session, baseline, control, 'R04');
  },
);

for (const variant of ['dispose', 'stop']) {
  test(
    `R05-R07 concurrent stop/dispose with bot close failure; retry via ${variant}`,
    { skip: linuxOnly, timeout: 30_000 },
    async () => {
      const { harness, session, control, baseline } = await prepare('normal', {
        'bot.stop.1': 'pre',
      });
      const started = await healthyStart(harness, session);
      const tree = identities();
      const listenerEvents = [];
      session.subscribe((event) => listenerEvents.push(event));
      const mark = harness.journal.length;
      const delegationMark = harness.delegations.length;

      // R05
      const [stopped, disposed] = await Promise.all([session.stop(), session.dispose()]);
      harness.results.push(stopped, disposed);
      assert.deepEqual(harness.journal.slice(mark), [
        ...fail('bot', 'stop', 1),
        ...ok('rest', 'stop', 1),
        ...ok('gateway', 'stop', 1),
      ]);
      assert.deepEqual(harness.delegations.slice(delegationMark), [
        D('rest', 'stop', 1),
        D('gateway', 'stop', 1),
      ]);
      assert.equal(disposed.ok, false);
      assert.equal(disposed.snapshot.disposed, true);
      assertCleanupIssues(disposed, ['bot'], 'R05');
      assertRetainedSnapshot(disposed.snapshot, 'R05');
      assertTreeAlive(tree, 'R05 bot retained');

      // R06
      assert.equal(listenerEvents.at(-1).snapshot.disposed, true);
      const listenerCount = listenerEvents.length;
      const blockedMark = harness.journal.length;
      await assert.rejects(session.start(), { code: 'invalid' });
      await assert.rejects(session.invoke(request(started.runId, 'after-dispose', '/ping')), {
        code: 'invalid',
      });
      await assert.rejects(session.selectProject(missingDirectory()), { code: 'invalid' });
      assert.equal(session.snapshot().disposed, true);
      assert.equal(harness.journal.length, blockedMark);
      assert.deepEqual(session.snapshot().project, disposed.snapshot.project);

      // R07
      harness.healAll();
      const retryMark = harness.journal.length;
      const retryDelegationMark = harness.delegations.length;
      const retried = await recorded(
        harness,
        variant === 'dispose' ? session.dispose() : session.stop(),
      );
      assert.equal(retried.ok, true, JSON.stringify(retried.errors));
      assert.deepEqual(harness.journal.slice(retryMark), ok('bot', 'stop', 2));
      assert.deepEqual(harness.delegations.slice(retryDelegationMark), [D('bot', 'stop', 2)]);
      assert.equal(session.snapshot().disposed, true);
      assert.equal(retried.snapshot.disposed, true);
      await assert.rejects(session.start(), { code: 'invalid' });
      assertTreeDead(tree, 'R07');
      assert.equal(listenerEvents.length, listenerCount, 'R06: no event after the disposed one');
      assertNoLeak(harness, session);
      await finish(harness, session, baseline, control, 'R07');
    },
  );
}

test(
  'R08 unexpected exit plus REST close failure keeps both issues; retry clears only cleanup',
  { skip: linuxOnly, timeout: 30_000 },
  async (t) => {
    const { harness, session, control, baseline } = await prepare('normal', {
      'rest.stop.*': 'pre',
    });
    const started = await healthyStart(harness, session);
    const tree = identities();
    const ports = endpointPorts(harness);
    const exited = await session.invoke(request(started.runId, 'exit-1', '/exit1'));
    assert.equal(exited.ok, true);
    // Wait for the existing supervision path to observe the exit and finish its cleanup.
    await waitFor(
      'supervised cleanup after unexpected exit',
      () =>
        harness.journal.some(
          (entry) =>
            entry.resource === 'rest' && entry.operation === 'stop' && entry.phase === 'reject',
        ) && session.snapshot().phase === 'error',
    );
    const supervisedError = session.snapshot().error;
    const first = await recorded(harness, session.stop());
    assert.equal(first.ok, false);
    assert.deepEqual(
      first.errors.map((issue) => issue.code),
      ['child-exited', 'cleanup'],
    );
    assert.ok(issueMatches(first.errors[1], 'rest'));
    await assertListening(ports.rest, 'R08 REST retained');

    harness.healAll();
    const retried = await recorded(harness, session.stop());
    assert.deepEqual(
      retried.errors.map((issue) => issue.code),
      ['child-exited'],
    );
    assert.equal(retried.ok, false);
    await assertClosed(ports.rest, 'R08 REST after retry');
    assertTreeDead(tree, 'R08');

    const next = await session.start();
    assert.equal(next.phase, 'running');
    const nextStop = await recorded(harness, session.stop());
    assert.deepEqual(nextStop.errors, [], 'next start clears child-exited evidence');
    t.diagnostic(
      JSON.stringify({
        supervisedError,
        firstStopError: first.snapshot.error,
        restStops: harness.stopsFrom().filter((entry) => entry.resource === 'rest'),
      }),
    );
    assertNoLeak(harness, session);
    await finish(harness, session, baseline, control, 'R08');
  },
);

test(
  'R09 + S09 manager: retained resources reject selectProject before config is read',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    useMode('normal');
    const harness = createHarness({ 'bot.start.1': 'post', 'bot.stop.*': 'pre' });
    harness.hooks['bot.start.1.delegated'] = () =>
      waitFor('parent and grandchild identities', () => identities().length >= 2);
    const manager = newManager(harness);
    const control = await startControl();
    const selected = await manager.selectProject(project);
    assert.equal(selected.phase, 'ready');
    const failed = await manager.start();
    assert.equal(failed.phase, 'error');
    assert.equal(manager.hasResources, true);
    const tree = identities();
    assertTreeAlive(tree, 'R09 bot retained');

    const before = manager.snapshot();
    const failureBefore = manager.failure;
    const issuesBefore = manager.shutdownIssues;
    const journalMark = harness.journal.length;
    const delegationMark = harness.delegations.length;

    const selection = await rejection(manager.selectProject(missingDirectory()));
    assert.ok(selection !== null, 'manager.selectProject rejected');
    assert.ok(selection instanceof publicIndex.SessionError);
    assert.equal(selection.code, 'invalid');
    assert.doesNotMatch(selection.message, /configuration could not be validated/iu);
    assert.match(selection.message, /cleanup/iu);
    assert.deepEqual(manager.snapshot(), before, 'state, project and failure text unchanged');
    assert.equal(manager.failure, failureBefore, 'primary failure retained');
    assert.deepEqual(manager.shutdownIssues, issuesBefore, 'cleanup issue retained');
    assert.equal(manager.hasResources, true);
    assert.equal(harness.journal.length, journalMark, 'no silent cleanup');
    assert.equal(harness.delegations.length, delegationMark);

    const restarted = await manager.start();
    assert.notEqual(restarted.phase, 'running');
    assert.notEqual(restarted.phase, 'ready');
    assert.equal(harness.journal.length, journalMark, 'start caused no wrapper call');
    assert.equal(identities().length, tree.length, 'nothing spawned');
    assert.equal(manager.hasResources, true);
    assert.deepEqual(manager.shutdownIssues, issuesBefore);
    assertTreeAlive(tree, 'R09 still retained');

    // S09: after successful cleanup, selectProject works again.
    harness.healAll();
    const stopped = await manager.stop();
    assert.equal(stopped.phase, 'ready');
    assert.equal(manager.hasResources, false);
    assertTreeDead(tree, 'R09 after retry');
    const copy = mkdtempSync(join(controlDirectory, 'project-copy-'));
    cpSync(project, copy, { recursive: true });
    const reselected = await manager.selectProject(copy);
    assert.equal(reselected.phase, 'ready');
    assert.equal(reselected.project.root, realpathSync(copy));
    control.assertAlive('R09');
  },
);

// R10-R13: stop requested while start is in progress. The stop is issued at the startup
// cleanup boundary, after the primary startup failure has been classified. Startup cleanup
// runs first (attempt 1); the issued stop then handles only what is still owned (attempt 2).
const stopDuringStart = [
  { id: 'R10', stopFault: 'pre', concurrentDispose: false, realChild: false },
  { id: 'R11', stopFault: 'post', concurrentDispose: false, realChild: false },
  { id: 'R11 (real child)', stopFault: 'post', concurrentDispose: false, realChild: true },
  { id: 'R12', stopFault: 'pre', concurrentDispose: true, realChild: false },
];
for (const item of stopDuringStart) {
  test(
    `${item.id} stop during start: startup cleanup then the issued stop; R13 siblings once`,
    { skip: linuxOnly, timeout: 30_000 },
    async () => {
      const { harness, session, control, baseline } = await prepare('normal', {
        'bot.start.1': item.realChild ? 'post' : 'pre',
        'bot.stop.1': item.stopFault,
      });
      let stopping;
      let disposing;
      let treeAfterFirstStop = null;
      if (item.realChild)
        harness.hooks['bot.start.1.delegated'] = () =>
          waitFor('parent and grandchild identities', () => identities().length >= 2);
      harness.hooks['bot.stop.1.invoke'] = () => {
        stopping = session.stop();
        if (item.concurrentDispose) disposing = session.dispose();
      };
      if (item.stopFault === 'post')
        harness.hooks['bot.stop.1.delegated'] = () => {
          treeAfterFirstStop = identities().map((entry) => ({ ...entry, alive: isAlive(entry) }));
        };
      await session.selectProject(project);
      await assert.rejects(session.start(), { code: 'start-failed' });
      const stopped = await recorded(harness, stopping);
      const disposed = disposing === undefined ? null : await recorded(harness, disposing);

      assert.deepEqual(harness.journal, [
        ...ok('gateway', 'wrap', 1),
        ...ok('gateway', 'start', 1),
        ...ok('rest', 'wrap', 1),
        ...ok('rest', 'start', 1),
        ...ok('bot', 'wrap', 1),
        ...fail('bot', 'start', 1),
        ...fail('bot', 'stop', 1),
        ...ok('rest', 'stop', 1),
        ...ok('gateway', 'stop', 1),
        ...ok('bot', 'stop', 2),
      ]);
      assert.deepEqual(harness.delegations, [
        D('gateway', 'start', 1),
        D('rest', 'start', 1),
        ...(item.realChild ? [D('bot', 'start', 1)] : []),
        ...(item.stopFault === 'post' ? [D('bot', 'stop', 1)] : []),
        D('rest', 'stop', 1),
        D('gateway', 'stop', 1),
        D('bot', 'stop', 2),
      ]);
      const botStopCalls = harness.journal.filter(
        (entry) =>
          entry.resource === 'bot' && entry.operation === 'stop' && entry.phase === 'invoke',
      );
      assert.equal(botStopCalls.length, 2, 'bot stop method called exactly twice, no third');
      // R13: already released siblings were stopped exactly once.
      for (const resource of ['rest', 'gateway']) {
        assert.deepEqual(
          harness.journal.filter(
            (entry) => entry.resource === resource && entry.operation === 'stop',
          ),
          ok(resource, 'stop', 1),
        );
        assert.equal(
          harness.delegations.filter(
            (entry) => entry.resource === resource && entry.operation === 'stop',
          ).length,
          1,
        );
      }
      assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      assert.deepEqual(stopped.errors, []);
      if (disposed !== null) {
        assert.deepEqual(stopped, disposed);
        assert.equal(disposed.snapshot.disposed, true);
      }
      const ports = endpointPorts(harness);
      await assertClosed(ports.rest, `${item.id} REST`);
      await assertClosed(ports.gateway, `${item.id} Gateway`);
      if (item.realChild) {
        assert.ok(treeAfterFirstStop !== null && treeAfterFirstStop.length >= 2);
        for (const entry of treeAfterFirstStop)
          assert.equal(entry.alive, false, `${item.id}: tree ended after attempt 1`);
        assertTreeDead(identities(), item.id);
        assert.equal(
          fixtureEvents('sigterm').filter((entry) => entry.role === 'parent').length,
          1,
          'the second stop sent no new signal',
        );
      } else {
        assert.deepEqual(identities(), [], `${item.id}: no child was spawned`);
      }
      control.assertAlive(item.id);
      assertNeverRunning(harness, item.id);
      if (disposed === null) {
        const again = await session.start();
        assert.equal(again.phase, 'running');
      } else {
        await assert.rejects(session.start(), { code: 'invalid' });
      }
      assertNoLeak(harness, session);
      await finish(harness, session, baseline, control, item.id);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// ACQUIRE. A wrapper that throws leaves the original owned; that original's own stop is not
// wrapped and so is not journaled. Its release is proven by the later successful start.

const acquireCases = [
  {
    id: 'A01 (S05)',
    faults: { 'gateway.wrap.1': 'throw' },
    journal: [...fail('gateway', 'wrap', 1)],
    delegations: [],
    gateway: 'unstarted',
  },
  {
    id: 'A02',
    faults: { 'gateway.start.1': 'pre' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...fail('gateway', 'start', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [D('gateway', 'stop', 1)],
    gateway: 'unstarted',
  },
  {
    id: 'A03',
    faults: { 'gateway.start.1': 'post' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...fail('gateway', 'start', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [D('gateway', 'start', 1), D('gateway', 'stop', 1)],
    gateway: 'listening',
  },
  {
    id: 'A04 (S05)',
    faults: { 'rest.wrap.1': 'throw' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...fail('rest', 'wrap', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [D('gateway', 'start', 1), D('gateway', 'stop', 1)],
    gateway: 'listening',
    rest: 'unstarted',
  },
  {
    id: 'A05',
    faults: { 'rest.start.1': 'pre' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...ok('rest', 'wrap', 1),
      ...fail('rest', 'start', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [D('gateway', 'start', 1), D('rest', 'stop', 1), D('gateway', 'stop', 1)],
    gateway: 'listening',
    rest: 'unstarted',
  },
  {
    id: 'A06',
    faults: { 'rest.start.1': 'post' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...ok('rest', 'wrap', 1),
      ...fail('rest', 'start', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [
      D('gateway', 'start', 1),
      D('rest', 'start', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ],
    gateway: 'listening',
    rest: 'listening',
  },
  {
    id: 'A07 (S05)',
    faults: { 'bot.wrap.1': 'throw' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...ok('rest', 'wrap', 1),
      ...ok('rest', 'start', 1),
      ...fail('bot', 'wrap', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [
      D('gateway', 'start', 1),
      D('rest', 'start', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ],
    gateway: 'listening',
    rest: 'listening',
    bot: 'unstarted',
  },
  {
    id: 'A08',
    faults: { 'bot.start.1': 'pre' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...ok('rest', 'wrap', 1),
      ...ok('rest', 'start', 1),
      ...ok('bot', 'wrap', 1),
      ...fail('bot', 'start', 1),
      ...ok('bot', 'stop', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [
      D('gateway', 'start', 1),
      D('rest', 'start', 1),
      D('bot', 'stop', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ],
    gateway: 'listening',
    rest: 'listening',
    bot: 'unstarted',
  },
  {
    id: 'A09',
    faults: { 'bot.start.1': 'post' },
    journal: [
      ...ok('gateway', 'wrap', 1),
      ...ok('gateway', 'start', 1),
      ...ok('rest', 'wrap', 1),
      ...ok('rest', 'start', 1),
      ...ok('bot', 'wrap', 1),
      ...fail('bot', 'start', 1),
      ...ok('bot', 'stop', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ],
    delegations: [
      D('gateway', 'start', 1),
      D('rest', 'start', 1),
      D('bot', 'start', 1),
      D('bot', 'stop', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ],
    gateway: 'listening',
    rest: 'listening',
    bot: 'spawned',
  },
];

for (const item of acquireCases) {
  test(
    `${item.id} acquisition failure cleans every acquired original`,
    { skip: linuxOnly, timeout: 30_000 },
    async (t) => {
      const { harness, session, control, baseline } = await prepare('normal', item.faults);
      const atFailure = {};
      if (item.faults['gateway.start.1'] === 'post')
        harness.hooks['gateway.start.1.delegated'] = async () => {
          atFailure.gateway = await connectOutcome(harness.captured.gatewayPort);
        };
      if (item.faults['rest.start.1'] === 'post')
        harness.hooks['rest.start.1.delegated'] = async () => {
          atFailure.rest = await connectOutcome(harness.captured.restPort);
        };
      if (item.bot === 'spawned')
        harness.hooks['bot.start.1.delegated'] = async () => {
          await waitFor('parent and grandchild identities', () => identities().length >= 2);
          atFailure.tree = identities().map((entry) => ({ ...entry, alive: isAlive(entry) }));
        };
      await session.selectProject(project);
      const outcome = await rejection(session.start());
      assert.ok(outcome !== null, 'start did not resolve');
      assert.equal(outcome.code, 'start-failed');
      assert.deepEqual(harness.journal, item.journal);
      assert.deepEqual(harness.delegations, item.delegations);
      assertNeverRunning(harness, item.id);
      assert.equal(session.snapshot().phase, 'error');
      assert.equal(session.snapshot().endpoints, null);

      // S03: wrappers receive exactly one argument, the real core resource instance.
      for (const resource of ['gateway', 'rest', 'bot'])
        for (const count of harness.wrapArgumentCounts[resource]) assert.equal(count, 1);
      for (const original of harness.originals.gateway)
        assert.ok(original instanceof core.LocalGatewayServer);
      for (const original of harness.originals.rest)
        assert.ok(original instanceof core.LocalRestEmulator);
      for (const original of harness.originals.bot) assert.ok(original instanceof core.BotRunner);

      // Independent observation of unstarted versus listening/spawned resources.
      if (item.faults['gateway.start.1'] === 'post') assert.equal(atFailure.gateway, 'open');
      if (harness.captured.gatewayPort !== undefined)
        await assertClosed(harness.captured.gatewayPort, `${item.id} Gateway`);
      if (item.faults['rest.start.1'] === 'post') assert.equal(atFailure.rest, 'open');
      if (harness.captured.restPort !== undefined)
        await assertClosed(harness.captured.restPort, `${item.id} REST`);
      const published = harness.endpointLog.findIndex((entry) => entry.value !== null);
      if (item.bot !== undefined) {
        assert.ok(published >= 0, 'endpoints had been published before the bot boundary');
        const withdrawn = harness.endpointLog.findIndex(
          (entry, index) => index > published && entry.value === null,
        );
        assert.ok(withdrawn > published, 'endpoints withdrawn when cleanup began');
        assert.ok(
          harness.endpointLog.slice(withdrawn).every((entry) => entry.value === null),
          'no endpoints republished after withdrawal',
        );
      } else {
        assert.equal(published, -1, 'no endpoints were ever published');
      }
      if (item.bot === 'spawned') {
        assert.ok(
          atFailure.tree.every((entry) => entry.alive),
          'child tree was running',
        );
        assertTreeDead(identities(), item.id);
      } else {
        assert.deepEqual(identities(), [], `${item.id}: no PID reported`);
      }
      control.assertAlive(item.id);

      // Ownership released: a later start succeeds (attempt 2 is healthy).
      const again = await session.start();
      assert.equal(again.phase, 'running');
      const plainSentinelVisible = assertNoLeak(harness, session, { allowPlainSentinel: true });
      t.diagnostic(JSON.stringify({ id: item.id, plainSentinelVisible }));
      await finish(harness, session, baseline, control, item.id);
    },
  );
}

test(
  'A10 bot start delegate-then-reject plus cleanup failure keeps primary and cleanup apart',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare('normal', {
      'bot.start.1': 'post',
      'bot.stop.1': 'pre',
      'bot.stop.2': 'pre',
    });
    harness.hooks['bot.start.1.delegated'] = () =>
      waitFor('parent and grandchild identities', () => identities().length >= 2);
    await session.selectProject(project);
    await assert.rejects(session.start(), { code: 'start-failed' });
    const failedState = session.snapshot();
    assert.match(failedState.error, /Bot startup failed\./u);
    assert.match(failedState.error, /Cleanup also failed/u);
    assert.deepEqual(harness.stopsFrom(), [
      ...fail('bot', 'stop', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ]);
    const tree = identities();
    assertTreeAlive(tree, 'A10 child retained');
    const mark = harness.journal.length;
    const stopped = await recorded(harness, session.stop());
    assert.equal(stopped.ok, false);
    assertCleanupIssues(stopped, ['bot'], 'A10');
    assert.deepEqual(harness.journal.slice(mark), fail('bot', 'stop', 2));
    assertTreeAlive(tree, 'A10 still retained');
    harness.healAll();
    const retryMark = harness.journal.length;
    const retried = await recorded(harness, session.stop());
    assert.equal(retried.ok, true, JSON.stringify(retried.errors));
    assert.deepEqual(harness.journal.slice(retryMark), ok('bot', 'stop', 3));
    assertTreeDead(tree, 'A10 after retry');
    assertNeverRunning(harness, 'A10');
    assertNoLeak(harness, session);
    await finish(harness, session, baseline, control, 'A10');
  },
);

const abortBoundaries = [
  { name: 'gateway-start-before', hook: 'gateway.start.1.invoke', acquired: ['gateway'] },
  { name: 'gateway-start-after', hook: 'gateway.start.1.delegated', acquired: ['gateway'] },
  { name: 'rest-start-before', hook: 'rest.start.1.invoke', acquired: ['rest', 'gateway'] },
  { name: 'rest-start-after', hook: 'rest.start.1.delegated', acquired: ['rest', 'gateway'] },
  { name: 'bot-start-before', hook: 'bot.start.1.invoke', acquired: ['bot', 'rest', 'gateway'] },
  {
    name: 'bot-start-after',
    hook: 'bot.start.1.delegated',
    acquired: ['bot', 'rest', 'gateway'],
  },
  { name: 'ping', mode: 'stall-ping', acquired: ['bot', 'rest', 'gateway'] },
  { name: 'deadline', mode: 'stall-ping', timeout: true, acquired: ['bot', 'rest', 'gateway'] },
];
for (const boundary of abortBoundaries) {
  test(
    `A11 cancellation at ${boundary.name} cleans each acquired resource exactly once`,
    { skip: linuxOnly, timeout: 30_000 },
    async () => {
      const { harness, session, control, baseline } = await prepare(boundary.mode ?? 'normal');
      const controller = new AbortController();
      if (boundary.hook !== undefined)
        harness.hooks[boundary.hook] = async () => {
          if (boundary.hook === 'bot.start.1.delegated')
            await waitFor('parent and grandchild identities', () => identities().length >= 2);
          controller.abort();
        };
      await session.selectProject(project);
      const outcome = rejection(
        session.start(boundary.timeout ? { timeoutMs: 1_500 } : { signal: controller.signal }),
      );
      if (boundary.name === 'ping') {
        await waitFor('held PING', () => fixtureEvents('ping-held').length > 0);
        controller.abort();
      }
      const error = await outcome;
      assert.ok(error !== null, 'start did not resolve');
      assert.equal(error.code, boundary.timeout ? 'timeout' : 'cancelled');
      assert.deepEqual(
        harness.stopsFrom(),
        boundary.acquired.flatMap((resource) => ok(resource, 'stop', 1)),
      );
      assertNeverRunning(harness, boundary.name);
      await assertClosed(harness.captured.gatewayPort, `${boundary.name} Gateway`);
      if (harness.captured.restPort !== undefined)
        await assertClosed(harness.captured.restPort, `${boundary.name} REST`);
      if (boundary.name === 'bot-start-before') {
        // The child may be terminated before it reports itself; whatever it reported must be gone.
        for (const entry of identities())
          assert.equal(isAlive(entry), false, `${boundary.name}: ${entry.role}:${entry.pid}`);
      } else if (boundary.acquired.includes('bot')) {
        assertTreeDead(identities(), boundary.name);
      }
      control.assertAlive(boundary.name);
      await finish(harness, session, baseline, control, boundary.name);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// UNCERTAINTY: delegate-then-reject and latched outcomes keep ownership with no automatic
// retry. Only a caller stop/dispose may issue a further attempt, and only through the
// resource's existing idempotent stop.

test(
  'U01 bot stop delegate-then-reject retains ownership until a caller stop confirms closure',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare('normal', {
      'bot.stop.1': 'post',
    });
    await healthyStart(harness, session);
    const tree = identities();
    const mark = harness.journal.length;
    const delegationMark = harness.delegations.length;
    const stopped = await recorded(harness, session.stop());
    assert.equal(stopped.ok, false);
    assertCleanupIssues(stopped, ['bot'], 'U01');
    assert.deepEqual(harness.journal.slice(mark), [
      ...fail('bot', 'stop', 1),
      ...ok('rest', 'stop', 1),
      ...ok('gateway', 'stop', 1),
    ]);
    assert.deepEqual(harness.delegations.slice(delegationMark), [
      D('bot', 'stop', 1),
      D('rest', 'stop', 1),
      D('gateway', 'stop', 1),
    ]);
    assertRetainedSnapshot(session.snapshot(), 'U01');
    assertTreeDead(tree, 'U01 real stop executed');
    await assert.rejects(session.start(), { code: 'invalid' });
    await assert.rejects(session.selectProject(missingDirectory()), { code: 'invalid' });
    const quietMark = harness.journal.length;
    const quietDelegations = harness.delegations.length;
    await sleep(1_100);
    assert.equal(harness.journal.length, quietMark, 'no automatic retry');
    assert.equal(harness.delegations.length, quietDelegations, 'no automatic delegation');

    const retried = await recorded(harness, session.stop());
    assert.equal(retried.ok, true, JSON.stringify(retried.errors));
    assert.deepEqual(harness.journal.slice(quietMark), ok('bot', 'stop', 2));
    assert.deepEqual(harness.delegations.slice(quietDelegations), [D('bot', 'stop', 2)]);
    control.assertAlive('U01');
    assertNoLeak(harness, session);
    await finish(harness, session, baseline, control, 'U01');
  },
);

for (const resource of ['rest', 'gateway']) {
  test(
    `U02 ${resource} stop delegate-then-reject; the real second stop is idempotent`,
    { skip: linuxOnly, timeout: 30_000 },
    async () => {
      const { harness, session, control, baseline } = await prepare('normal', {
        [`${resource}.stop.1`]: 'post',
      });
      await healthyStart(harness, session);
      const ports = endpointPorts(harness);
      const stopped = await recorded(harness, session.stop());
      assert.equal(stopped.ok, false);
      assertCleanupIssues(stopped, [resource], 'U02');
      await assertClosed(ports[resource], `U02 ${resource} real stop executed`);
      await assert.rejects(session.start(), { code: 'invalid' });
      const quietMark = harness.journal.length;
      await sleep(1_100);
      assert.equal(harness.journal.length, quietMark, 'no automatic retry');
      const retried = await recorded(harness, session.stop());
      assert.equal(retried.ok, true, `second real stop: ${JSON.stringify(retried.errors)}`);
      assert.deepEqual(harness.journal.slice(quietMark), ok(resource, 'stop', 2));
      assert.deepEqual(
        harness.delegations.filter(
          (entry) => entry.resource === resource && entry.operation === 'stop',
        ),
        [D(resource, 'stop', 1), D(resource, 'stop', 2)],
      );
      control.assertAlive('U02');
      assertNoLeak(harness, session);
      await finish(harness, session, baseline, control, `U02 ${resource}`);
    },
  );
}

test(
  'U03 mocked latched helper timeout: helper launched once, ownership never reset',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    // Mocked control-flow evidence only; this is not a Windows process-tree test.
    const { harness, session, control } = await prepare('normal', { 'bot.start.1': 'pre' });
    let helperLaunches = 0;
    let latched = null;
    let botStopAttempt = 0;
    harness.overrides.botStop = () => {
      botStopAttempt += 1;
      harness.journal.push(J('bot', 'stop', botStopAttempt, 'invoke'));
      if (latched === null) {
        helperLaunches += 1;
        latched = new Error(`${SENTINEL} helper timed out; outcome unknown ${INJECTED_SUFFIX}`);
      }
      harness.journal.push(J('bot', 'stop', botStopAttempt, 'reject'));
      return Promise.reject(latched);
    };
    await session.selectProject(project);
    await assert.rejects(session.start(), { code: 'start-failed' });
    assert.equal(helperLaunches, 1);
    for (let round = 2; round <= 4; round += 1) {
      const mark = harness.journal.length;
      const result = await recorded(harness, session.stop());
      assert.equal(result.ok, false);
      assertCleanupIssues(result, ['bot'], `U03 round ${round}`);
      assert.deepEqual(harness.journal.slice(mark), fail('bot', 'stop', round));
      assert.equal(helperLaunches, 1, 'helper is never launched again');
      await assert.rejects(session.start(), { code: 'invalid' });
    }
    const quietMark = harness.journal.length;
    await sleep(1_100);
    assert.equal(harness.journal.length, quietMark, 'no automatic retry');
    assert.equal(
      harness.delegations.some((entry) => entry.resource === 'bot' && entry.operation === 'stop'),
      false,
      'no delegation to a real bot stop',
    );
    assert.deepEqual(identities(), []);
    control.assertAlive('U03');
    assertNoLeak(harness, session);
  },
);

test(
  'U04 unknown liveness rejects as transport, not child-exited, and keeps ownership',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare();
    const started = await healthyStart(harness, session);
    assert.ok('observeExit' in harness.wrappers.bot[0]);
    harness.overrides.observeExit = () => 'unknown';
    const mark = harness.journal.length;
    await assert.rejects(session.invoke(request(started.runId, 'unknown-1', '/ping')), {
      code: 'transport',
    });
    assert.equal(harness.journal.length, mark, 'no cleanup or release triggered');
    assert.equal(session.snapshot().phase, 'running');
    delete harness.overrides.observeExit;
    const stopped = await recorded(harness, session.stop());
    assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
    assert.equal(
      stopped.errors.some((issue) => issue.code === 'child-exited'),
      false,
    );
    assertTreeDead(identities(), 'U04');
    await finish(harness, session, baseline, control, 'U04');
  },
);

// ---------------------------------------------------------------------------------------------
// REVOKE

test(
  'V01-V04 endpoints withdrawn before the first close settles; invoke blocked; fresh run',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare('normal', {
      'bot.stop.1': 'pre',
    });
    const started = await healthyStart(harness, session);
    const commandsBefore = fixtureEvents('command').length;
    let invokeDuringStop = null;
    harness.hooks['bot.stop.1.invoke'] = async () => {
      const error = await rejection(session.invoke(request(started.runId, 'during-stop', '/ping')));
      invokeDuringStop = error === null ? 'resolved' : error.code;
    };
    const stopped = await recorded(harness, session.stop());
    assert.equal(stopped.ok, false);

    // V01
    const firstSettle = harness.timeline.find(
      (entry) => entry.kind === 'journal' && entry.operation === 'stop' && entry.phase !== 'invoke',
    );
    const withdrawn = harness.timeline.find(
      (entry) => entry.kind === 'endpoints' && entry.endpoints === null,
    );
    assert.ok(withdrawn !== undefined && firstSettle !== undefined);
    assert.ok(
      withdrawn.seq < firstSettle.seq,
      'endpoints withdrawn before the first close settled',
    );

    // V02
    assert.equal(invokeDuringStop, 'not-running');
    await assert.rejects(session.invoke(request(started.runId, 'after-failure', '/ping')), {
      code: 'not-running',
    });
    assert.equal(fixtureEvents('command').length, commandsBefore, 'no request reached the bot');

    // V03
    const eventMark = harness.events.length;
    await sleep(1_100);
    assert.equal(
      harness.endpointLog.some((entry) => entry.seq > withdrawn.seq && entry.value !== null),
      false,
      'endpoints never republished',
    );
    const later = harness.events.slice(eventMark);
    assert.equal(
      later.some((event) => event.runId === started.runId && event.snapshot.endpoints !== null),
      false,
    );
    assert.equal(
      later.some((event) => event.snapshot.pid !== null),
      false,
      'no possibly stale PID republished',
    );
    assert.equal(session.snapshot().pid, null);

    // V04
    harness.healAll();
    assert.equal((await recorded(harness, session.stop())).ok, true);
    const next = await session.start();
    assert.notEqual(next.runId, started.runId);
    const fresh = await session.invoke(request(next.runId, 'fresh-1', '/ping'));
    assert.equal(fresh.response.data.content, 'pong:ping');
    control.assertAlive('V01-V04');
    assertNoLeak(harness, session);
    await finish(harness, session, baseline, control, 'V01-V04');
  },
);

// ---------------------------------------------------------------------------------------------
// SEAM

test('S02 internal factory is absent from the public entry point', () => {
  assert.equal('createSessionWithDependencies' in publicIndex, false);
  assert.equal(typeof publicIndex.createSession, 'function');
  assert.equal(publicIndex.createSession.length, 0);
});

test(
  'S01 + S03 + S04 seam copies callbacks at construction and delegates to the real instance',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    useMode('normal');
    const harness = createHarness();
    const replacement = [];
    const dependencies = { ...harness.dependencies };
    const session = requireFactory()({ onEndpoints: harness.onEndpoints }, dependencies);
    sessions.push(session);
    session.subscribe((event) => harness.events.push(event));
    for (const key of ['wrapBot', 'wrapRest', 'wrapGateway'])
      dependencies[key] = (resource) => {
        replacement.push(key);
        return resource;
      };
    await healthyStart(harness, session);
    assert.deepEqual(replacement, [], 'later mutation did not change the seam');
    for (const resource of ['gateway', 'rest', 'bot'])
      assert.deepEqual(harness.wrapArgumentCounts[resource], [1]);
    assert.ok(harness.originals.gateway[0] instanceof core.LocalGatewayServer);
    assert.ok(harness.originals.rest[0] instanceof core.LocalRestEmulator);
    assert.ok(harness.originals.bot[0] instanceof core.BotRunner);
    const [gatewayOriginal] = harness.originals.gateway;
    const [gatewayWrapper] = harness.wrappers.gateway;
    assert.notEqual(gatewayOriginal.address, undefined);
    assert.deepEqual(gatewayWrapper.address, gatewayOriginal.address, 'address is a live getter');
    assert.equal(
      'observeExit' in harness.wrappers.bot[0],
      'observeExit' in harness.originals.bot[0],
    );
    assert.equal(
      'observeExit' in harness.wrappers.rest[0],
      'observeExit' in harness.originals.rest[0],
    );
    assert.equal((await recorded(harness, session.stop())).ok, true);
    assert.equal(gatewayWrapper.address, gatewayOriginal.address);
    assertTreeDead(identities(), 'S01');
  },
);

test(
  'S07 dependencies are instance-scoped across two sessions in one process',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    useMode('normal');
    const first = createHarness();
    const second = createHarness();
    const a = newSession(first);
    const b = newSession(second);
    await healthyStart(first, a);
    await healthyStart(second, b);
    assert.equal((await a.stop()).ok, true);
    assert.equal((await b.stop()).ok, true);
    const stops = [...ok('bot', 'stop', 1), ...ok('rest', 'stop', 1), ...ok('gateway', 'stop', 1)];
    assert.deepEqual(first.journal, [...HEALTHY_START, ...stops]);
    assert.deepEqual(second.journal, [...HEALTHY_START, ...stops]);
    assert.equal(identities().length, 4);
    for (const entry of identities()) assert.equal(isAlive(entry), false);
  },
);

test(
  'S08 production createSession behaves like an identity-wrapped session',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    useMode('normal');
    const outcomes = [];
    for (const kind of ['production', 'identity']) {
      let session;
      if (kind === 'production') {
        session = publicIndex.createSession();
        sessions.push(session);
      } else {
        session = newSession(createHarness());
      }
      await session.selectProject(project);
      const started = await session.start();
      const result = await session.invoke(request(started.runId, `${kind}-1`, '/ping'));
      const stopped = await session.stop();
      outcomes.push({
        phase: started.phase,
        ok: result.ok,
        content: result.response.data.content,
        stopOk: stopped.ok,
        errors: stopped.errors,
        after: stopped.snapshot.phase,
        pid: stopped.snapshot.pid,
      });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(identities().length, 4);
    for (const entry of identities()) assert.equal(isAlive(entry), false);
  },
);

test(
  'S10 a disposed Session keeps rejecting selectProject without reading config',
  { skip: linuxOnly, timeout: 30_000 },
  async () => {
    const { harness, session, control, baseline } = await prepare();
    await healthyStart(harness, session);
    const disposed = await recorded(harness, session.dispose());
    assert.equal(disposed.ok, true);
    const projectBefore = session.snapshot().project;
    const copy = mkdtempSync(join(controlDirectory, 'project-copy-'));
    cpSync(project, copy, { recursive: true });
    for (const directory of [missingDirectory(), copy]) {
      const error = await rejection(session.selectProject(directory));
      assert.ok(error !== null);
      assert.equal(error.code, 'invalid');
      assert.doesNotMatch(error.message, /configuration could not be validated/iu);
    }
    assert.equal(session.snapshot().disposed, true);
    assert.deepEqual(session.snapshot().project, projectBefore);
    await finish(harness, session, baseline, control, 'S10');
  },
);
