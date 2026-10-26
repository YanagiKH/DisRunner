// M1 runtime lifecycle oracles L01–L13 against the real shared createSession() (no fake session).
//
// Evidence rules (see docs/runtime-lifecycle.md):
// - PIDs come from the fixture bot's own reports; liveness uses /proc/<pid>/stat state and
//   starttime so zombies and PID reuse are not mistaken for live processes.
// - Endpoint closure is checked by connecting (ECONNREFUSED); port reuse by listening again.
// - Handle evidence uses process.getActiveResourcesInfo() excess over a settled baseline.
// - Listener counts on BotRunner's private child are uncovered by decision (no private access).
// - Each test has a bounded deadline. Containment that must kill a leftover PID fails the test.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSession } from '../dist/index.js';

const isLinux = process.platform === 'linux';
const project = fileURLToPath(new URL('./fixtures/lifecycle/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const CONTROL_NAME = 'disrunner-lifecycle-control.json';

// Fixture mode channel: BotRunner inherits TMPDIR, so the bot reads its control file there.
const originalTmpdir = process.env.TMPDIR;
const controlDirectory = mkdtempSync(join(originalTmpdir ?? tmpdir(), 'disrunner-lifecycle-'));
process.env.TMPDIR = controlDirectory;
after(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  rmSync(controlDirectory, { recursive: true, force: true });
});

let reportCounter = 0;
let reportPath = '';
let testReportPaths = [];
let sessions = [];

beforeEach(() => {
  sessions = [];
  testReportPaths = [];
});

afterEach(async () => {
  for (const session of sessions) await session.dispose();
  const contained = [];
  const recorded = testReportPaths.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'identity'),
  );
  for (const record of recorded) {
    if (isAlive(record)) {
      contained.push(`${record.role}:${record.pid}`);
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
  }
  if (contained.length > 0)
    throw new Error(`Watchdog containment had to kill leftover processes: ${contained.join(', ')}`);
});

function useMode(mode) {
  reportCounter += 1;
  reportPath = join(controlDirectory, `report-${reportCounter}.jsonl`);
  writeFileSync(reportPath, '');
  testReportPaths.push(reportPath);
  writeFileSync(join(controlDirectory, CONTROL_NAME), JSON.stringify({ mode, reportPath }));
}

function reports() {
  if (reportPath === '') return [];
  return readFileSync(reportPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

function identities() {
  return reports().filter((entry) => entry.event === 'identity');
}

function events(name) {
  return reports().filter((entry) => entry.event === name);
}

function readProcStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], pgid: Number(fields[2]), starttime: fields[19] };
  } catch {
    return null;
  }
}

/** E1: alive only if /proc exists, starttime matches and the state is not zombie/dead. */
function isAlive(record) {
  const stat = readProcStat(record.pid);
  if (stat === null) return false;
  if (record.starttime !== null && stat.starttime !== record.starttime) return false;
  return stat.state !== 'Z' && stat.state !== 'X';
}

async function waitFor(description, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function newSession() {
  const endpoints = [];
  const session = createSession({
    onEndpoints: (value) => {
      if (value !== null) endpoints.push(value);
    },
  });
  sessions.push(session);
  return { session, endpoints };
}

function portsOf(endpoint) {
  if (endpoint === undefined) return [];
  return [endpoint.restBaseUrl, endpoint.gatewayUrl, endpoint.interactionEndpoint]
    .filter((value) => typeof value === 'string')
    .map((value) => Number(new URL(value).port));
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

async function assertPortsClosed(ports) {
  for (const port of ports)
    assert.equal(await connectOutcome(port), 'ECONNREFUSED', `port ${port}`);
}

function listenOnce(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(port)));
  });
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    current = excess();
  }
  return current;
}

function assertTreeDead(records, label) {
  assert.ok(records.length >= 2, `${label}: parent and grandchild identities reported`);
  for (const record of records)
    assert.equal(isAlive(record), false, `${label}: ${record.role}:${record.pid}`);
}

function request(runId, requestId, input) {
  return { runId, requestId, input, context };
}

test(
  'L01 abort-before-spawn',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
  async (t) => {
    useMode('normal');
    const { session, endpoints } = newSession();
    await session.selectProject(project);
    const before = session.snapshot();
    const baseline = await settledBaseline();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(session.start({ signal: controller.signal }), { code: 'cancelled' });
    assert.deepEqual(identities(), []);
    assert.deepEqual(endpoints, []);
    const afterAbort = session.snapshot();
    assert.equal(afterAbort.pid, null);
    assert.equal(afterAbort.phase, before.phase);
    assert.deepEqual(await excessHandles(baseline), {});
    t.diagnostic(
      JSON.stringify({
        phase: afterAbort.phase,
        revisionBefore: before.revision,
        revisionAfter: afterAbort.revision,
      }),
    );
  },
);

for (const mode of ['stall-tcp', 'stall-ping']) {
  test(
    `L02 abort-readiness (${mode})`,
    { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
    async (t) => {
      useMode(mode);
      const { session, endpoints } = newSession();
      await session.selectProject(project);
      const controller = new AbortController();
      const starting = session.start({ signal: controller.signal });
      const outcome = starting.then(
        () => 'resolved',
        (error) => error,
      );
      await waitFor('parent and grandchild identities', () => identities().length >= 2);
      if (mode === 'stall-ping') await waitFor('held PING', () => events('ping-held').length > 0);
      const abortedAt = Date.now();
      controller.abort();
      const error = await outcome;
      const settleMs = Date.now() - abortedAt;
      assert.equal(error.code, 'cancelled');
      assert.ok(settleMs < 3_000, `settled in ${settleMs} ms`);
      assert.deepEqual(events('command'), []);
      assertTreeDead(identities(), 'L02');
      await assertPortsClosed(portsOf(endpoints.at(-1)));
      t.diagnostic(JSON.stringify({ mode, settleMs, identities: identities() }));
      assert.equal((await session.dispose()).ok, true);
    },
  );
}

for (const trigger of ['abort', 'timeout']) {
  test(
    `L03 abort-body (${trigger})`,
    { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
    async (t) => {
      useMode('normal');
      const { session, endpoints } = newSession();
      await session.selectProject(project);
      const started = await session.start();
      const controller = new AbortController();
      const invocation = session
        .invoke(request(started.runId, 'stall-1', '/stall-body'), {
          ...(trigger === 'abort' ? { signal: controller.signal } : { timeoutMs: 300 }),
        })
        .then(
          (value) => ({ accepted: value }),
          (error) => ({ error }),
        );
      await waitFor('stalled body headers', () => events('stall-body-headers').length > 0);
      if (trigger === 'abort') controller.abort();
      const outcome = await invocation;
      assert.equal(outcome.accepted, undefined, 'no accepted response');
      assert.equal(outcome.error.code, trigger === 'abort' ? 'cancelled' : 'timeout');
      await waitFor(
        'server observed socket close',
        () => events('stall-body-socket-closed').length > 0,
        2_000,
      );
      const stopped = await session.stop();
      assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      assertTreeDead(identities(), 'L03');
      await assertPortsClosed(portsOf(endpoints.at(-1)));
      t.diagnostic(JSON.stringify({ trigger, code: outcome.error.code, stopped: stopped.errors }));
    },
  );
}

const raceBoundaries = [
  { name: 'starting-snapshot', mode: 'normal' },
  { name: 'endpoints-listening', mode: 'normal' },
  { name: 'child-spawned-before-ping', mode: 'stall-ping' },
  { name: 'running-snapshot', mode: 'normal' },
];
for (const boundary of raceBoundaries) {
  test(
    `L04 stop-start-race (${boundary.name})`,
    { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
    async (t) => {
      useMode(boundary.mode);
      let stopping;
      let stopRequestedAt = 0;
      const requestStop = () => {
        if (stopping !== undefined) return;
        stopRequestedAt = Date.now();
        stopping = session.stop();
      };
      const endpoints = [];
      const session = createSession({
        onEndpoints: (value) => {
          if (value !== null) {
            endpoints.push(value);
            if (boundary.name === 'endpoints-listening') requestStop();
          }
        },
      });
      sessions.push(session);
      await session.selectProject(project);
      session.subscribe((event) => {
        if (boundary.name === 'starting-snapshot' && event.snapshot.phase === 'starting')
          requestStop();
        if (boundary.name === 'running-snapshot' && event.snapshot.phase === 'running')
          requestStop();
      });
      const starting = session.start().then(
        () => 'resolved',
        (error) => error,
      );
      if (boundary.name === 'child-spawned-before-ping') {
        await waitFor('held PING', () => events('ping-held').length > 0);
        requestStop();
      }
      const outcome = await starting;
      assert.notEqual(outcome, 'resolved');
      assert.equal(outcome.code, 'cancelled');
      const stopped = await stopping;
      const stopMs = Date.now() - stopRequestedAt;
      assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      assert.ok(stopMs < 3_000, `stop did not wait for readiness (${stopMs} ms)`);
      for (const record of identities())
        assert.equal(isAlive(record), false, `${record.role}:${record.pid}`);
      await assertPortsClosed(portsOf(endpoints.at(-1)));
      assert.equal(session.snapshot().pid, null);
      t.diagnostic(
        JSON.stringify({ boundary: boundary.name, stopMs, identities: identities().length }),
      );
    },
  );
}

test(
  'L05 repeat-dispose',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
  async (t) => {
    useMode('normal');
    const { session } = newSession();
    await session.selectProject(project);
    const started = await session.start();
    const results = await Promise.all([
      session.stop(),
      session.stop(),
      session.dispose(),
      session.dispose(),
    ]);
    for (const result of results) {
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.snapshot.disposed, true);
    }
    assert.equal(events('sigterm').filter((entry) => entry.role === 'parent').length, 1);
    assertTreeDead(identities(), 'L05');
    await assert.rejects(session.start(), { code: 'invalid' });
    await assert.rejects(session.invoke(request(started.runId, 'after-dispose', '/ping')), {
      code: 'invalid',
    });
    const again = await session.dispose();
    assert.equal(again.ok, true);
    assert.equal(session.snapshot().disposed, true);
    t.diagnostic(JSON.stringify({ parentSigterms: events('sigterm').length }));
  },
);

for (const [id, code] of [
  ['L06 unexpected-zero-exit', 0],
  ['L07 unexpected-nonzero-exit', 1],
]) {
  test(
    `${id} (during startup)`,
    { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
    async (t) => {
      useMode(`exit-startup-${code}`);
      const { session, endpoints } = newSession();
      await session.selectProject(project);
      await assert.rejects(session.start(), { code: 'child-exited' });
      assert.notEqual(session.snapshot().phase, 'running');
      assertTreeDead(identities(), id);
      await assertPortsClosed(portsOf(endpoints.at(-1)));
      const stopped = await session.stop();
      assert.equal(stopped.ok, false);
      assert.ok(stopped.errors.some((issue) => issue.code === 'child-exited'));
      t.diagnostic(JSON.stringify({ code, exit: events('exiting'), stopErrors: stopped.errors }));
    },
  );

  test(
    `${id} (after callback, before shutdown)`,
    { skip: !isLinux && 'Linux-only /proc evidence', timeout: 15_000 },
    async (t) => {
      useMode('normal');
      const { session, endpoints } = newSession();
      await session.selectProject(project);
      const started = await session.start();
      const result = await session.invoke(request(started.runId, 'exit-1', `/exit${code}`));
      assert.equal(result.ok, true);
      const parent = identities().find((entry) => entry.role === 'parent');
      await waitFor('unexpected parent exit', () => !isAlive(parent));
      const exitObservedAt = Date.now();
      const stopped = await session.stop();
      assert.equal(stopped.ok, false);
      assert.ok(
        stopped.errors.some((issue) => issue.code === 'child-exited'),
        JSON.stringify(stopped.errors),
      );
      assert.notEqual(stopped.snapshot.phase, 'running');
      assertTreeDead(identities(), id);
      await assertPortsClosed(portsOf(endpoints.at(-1)));
      t.diagnostic(
        JSON.stringify({
          code,
          exitObservedAt,
          exit: events('exiting'),
          stopErrors: stopped.errors,
        }),
      );
    },
  );
}

test(
  'L08 generation-isolation',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 20_000 },
  async (t) => {
    useMode('normal');
    const { session } = newSession();
    const seen = [];
    await session.selectProject(project);
    session.subscribe((event) =>
      seen.push({ sequence: event.sequence, runId: event.runId, phase: event.snapshot.phase }),
    );
    const first = await session.start();
    const slow = session.invoke(request(first.runId, 'slow-1', '/slow')).then(
      () => 'resolved',
      (error) => error.code,
    );
    await waitFor('slow command received', () => events('command').length > 0);
    const stopped = await session.stop();
    assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
    assert.equal(await slow, 'cancelled');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
    assert.equal(session.snapshot().phase, 'ready', 'late success did not overwrite stopped state');
    const second = await session.start();
    assert.notEqual(second.runId, first.runId);
    await assert.rejects(session.invoke(request(first.runId, 'stale-1', '/ping')), {
      code: 'not-running',
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
    const firstSecond = seen.findIndex((entry) => entry.runId === second.runId);
    assert.ok(firstSecond > 0);
    assert.ok(seen.slice(firstSecond).every((entry) => entry.runId === second.runId));
    for (let index = 1; index < seen.length; index += 1)
      assert.ok(seen[index].sequence > seen[index - 1].sequence, 'sequence strictly increases');
    assert.equal(session.snapshot().phase, 'running');
    assert.equal(session.snapshot().runId, second.runId);
    assert.equal((await session.stop()).ok, true);
    assertTreeDead(identities(), 'L08');
    t.diagnostic(
      JSON.stringify({ events: seen.length, firstRun: first.runId, secondRun: second.runId }),
    );
  },
);

test(
  'L09 wait-listener-balance (runtime handle balance)',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 30_000 },
  async (t) => {
    // Listener counts: not observable through the public API, reported as uncovered.
    const { session } = newSession();
    useMode('normal');
    await session.selectProject(project);
    const baseline = await settledBaseline();
    const paths = {};

    const started = await session.start();
    await session.invoke(request(started.runId, 'balance-1', '/ping'));
    assert.equal((await session.stop()).ok, true);
    paths.success = await excessHandles(baseline);

    useMode('exit-startup-1');
    await assert.rejects(session.start(), { code: 'child-exited' });
    paths.failure = await excessHandles(baseline);

    useMode('stall-ping');
    const controller = new AbortController();
    const cancelled = session.start({ signal: controller.signal }).catch((error) => error.code);
    await waitFor('held PING', () => events('ping-held').length > 0);
    controller.abort();
    assert.equal(await cancelled, 'cancelled');
    paths.cancel = await excessHandles(baseline);

    t.diagnostic(JSON.stringify({ baseline, paths }));
    assert.deepEqual(paths, { success: {}, failure: {}, cancel: {} });
  },
);

test(
  'L10 stubborn-tree',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 30_000 },
  async (t) => {
    useMode('stubborn-tree');
    const { session, endpoints } = newSession();
    await session.selectProject(project);
    await session.start();
    const tree = identities();
    assert.equal(tree.length, 2);
    for (const record of tree) assert.equal(isAlive(record), true);
    const stopStartedAt = Date.now();
    const stopped = await session.stop();
    const stopMs = Date.now() - stopStartedAt;
    if (stopped.ok) {
      assertTreeDead(tree, 'L10');
    } else {
      assert.ok(stopped.errors.some((issue) => issue.code === 'cleanup'));
    }
    assert.ok(events('sigterm').length >= 1, 'graceful signal was delivered first');
    await assertPortsClosed(portsOf(endpoints.at(-1)));
    t.diagnostic(
      JSON.stringify({
        ok: stopped.ok,
        errors: stopped.errors,
        stopMs,
        tree,
        sigterms: events('sigterm'),
      }),
    );
    assert.equal(stopped.ok, true);
  },
);

async function cycleEvidence(t, label, cycles, runCycle) {
  const { session, endpoints } = newSession();
  useMode(cycles.mode);
  await session.selectProject(project);
  const baseline = await settledBaseline();
  const records = [];
  let lastPorts = [];
  let currentCycle = 0;
  try {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      currentCycle = cycle;
      const seenBefore = identities().length;
      const endpointCount = endpoints.length;
      const detail = await runCycle(session, cycle);
      const tree = identities().slice(seenBefore);
      const ports = portsOf(endpoints.slice(endpointCount).at(-1));
      assert.ok(tree.length >= 2, `${label} cycle ${cycle}: parent and grandchild reported`);
      for (const record of tree)
        assert.equal(
          isAlive(record),
          false,
          `${label} cycle ${cycle}: ${record.role}:${record.pid}`,
        );
      await assertPortsClosed(ports);
      lastPorts = ports;
      records.push({
        cycle,
        ...detail,
        tree: tree.map(({ role, pid, pgid, starttime }) => ({ role, pid, pgid, starttime })),
        ports,
      });
    }
    const disposed = await session.dispose();
    // After a failure cycle the session keeps exposing that run's primary child-exited issue
    // (contract: stop/dispose must expose it); cleanup itself must still have succeeded.
    assert.deepEqual(
      disposed.errors.map((issue) => issue.code),
      cycles.disposeErrorCodes ?? [],
      JSON.stringify(disposed.errors),
    );
    const excess = await excessHandles(baseline);
    const reused = [];
    for (const port of lastPorts) reused.push(await listenOnce(port));
    return { records, excess, reused };
  } catch (error) {
    try {
      t.diagnostic(
        JSON.stringify({
          event: 'lifecycle-cycle-failure',
          label,
          cycle: currentCycle,
          records,
          snapshot: session.snapshot(),
          endpoints,
          fixtureDiagnostics: reports().filter((entry) =>
            ['identity', 'error', 'exit', 'sigterm'].includes(entry.event),
          ),
        }),
      );
    } catch {
      try {
        t.diagnostic(
          JSON.stringify({ event: 'lifecycle-evidence-unavailable', label, cycle: currentCycle }),
        );
      } catch {
        /* The original cycle failure remains authoritative. */
      }
    }
    throw error;
  }
}

test(
  'L11 twenty-success-cycles',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 120_000 },
  async (t) => {
    const evidence = await cycleEvidence(t, 'L11', { mode: 'normal' }, async (session, cycle) => {
      const started = await session.start();
      const result = await session.invoke(request(started.runId, `ping-${cycle}`, '/ping'));
      assert.equal(result.response.data.content, 'pong:ping');
      const stopped = await session.stop();
      assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      return { runId: started.runId, stopOk: stopped.ok };
    });
    t.diagnostic(JSON.stringify(evidence));
    assert.equal(evidence.records.length, 20);
    assert.deepEqual(evidence.excess, {});
    assert.equal(evidence.reused.length, 3);
  },
);

test(
  'L12 twenty-failure-cycles',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 120_000 },
  async (t) => {
    const evidence = await cycleEvidence(
      t,
      'L12',
      { mode: 'exit-startup-1', disposeErrorCodes: ['child-exited'] },
      async (session) => {
        const code = await session.start().then(
          () => 'resolved',
          (error) => error.code,
        );
        assert.equal(code, 'child-exited');
        return { errorCode: code };
      },
    );
    t.diagnostic(JSON.stringify(evidence));
    assert.equal(evidence.records.length, 20);
    assert.deepEqual(evidence.excess, {});
    assert.equal(evidence.reused.length, 3);
  },
);

test(
  'L13 twenty-cancel-cycles',
  { skip: !isLinux && 'Linux-only /proc evidence', timeout: 120_000 },
  async (t) => {
    const evidence = await cycleEvidence(t, 'L13', { mode: 'stall-ping' }, async (session) => {
      const heldBefore = events('ping-held').length;
      const controller = new AbortController();
      const outcome = session.start({ signal: controller.signal }).then(
        () => 'resolved',
        (error) => error.code,
      );
      await waitFor('held PING', () => events('ping-held').length > heldBefore);
      const abortedAt = Date.now();
      controller.abort();
      const code = await outcome;
      assert.equal(code, 'cancelled');
      return { errorCode: code, abortedAt, settleMs: Date.now() - abortedAt };
    });
    t.diagnostic(JSON.stringify(evidence));
    assert.equal(evidence.records.length, 20);
    assert.deepEqual(evidence.excess, {});
    assert.equal(evidence.reused.length, 3);
  },
);
