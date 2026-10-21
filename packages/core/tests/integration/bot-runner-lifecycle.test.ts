import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotRunner, type BotProcessConfig } from '../../src/index.js';

/*
 * M1 lifecycle oracles for BotRunner (core layer only).
 *
 * Evidence rules: PIDs come from the fixtures' own JSON reports, liveness is decided from
 * /proc/<pid>/stat (state and starttime, so zombies and PID reuse are not mistaken for live
 * processes), and every test owns a bounded deadline plus a containment step. Containment that
 * has to kill anything fails the test: it is never evidence that BotRunner cleaned up.
 *
 * Uncovered: listener counts on the private child are not observable through the public API; only
 * public behaviour and process.getActiveResourcesInfo() handle counts are asserted.
 */

const isLinux = process.platform === 'linux';
const fixtureDirectory = fileURLToPath(
  new URL('../fixtures/bot-runner-lifecycle/', import.meta.url),
);
const parentFixture = join(fixtureDirectory, 'parent.mjs');

interface ProcessRecord {
  readonly role: string;
  readonly pid: number;
  readonly pgid: number | null;
  readonly starttime: string | null;
}

interface ProcStat {
  readonly state: string;
  readonly pgid: number;
  readonly starttime: string;
}

function readProcStat(pid: number): ProcStat | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      state: fields[0] ?? '?',
      pgid: Number(fields[2]),
      starttime: fields[19] ?? '',
    };
  } catch {
    return null;
  }
}

/** E1: alive only if /proc entry exists, starttime matches, and state is not zombie/dead. */
function isAlive(record: ProcessRecord): boolean {
  const stat = readProcStat(record.pid);
  if (stat === null) return false;
  if (record.starttime !== null && stat.starttime !== record.starttime) return false;
  return stat.state !== 'Z' && stat.state !== 'X';
}

let directory: string;
let runner: BotRunner | undefined;
const owned: ProcessRecord[] = [];
const controls: ProcessRecord[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'disrunner-bot-lifecycle-'));
  owned.length = 0;
  controls.length = 0;
  runner = undefined;
});

afterEach(async () => {
  // Test-owned controls are always removed by the test itself; not a cleanup finding.
  for (const control of controls) stopControl(control);
  // Containment only: kill recorded, starttime-verified runner PIDs that are still alive.
  const contained: string[] = [];
  for (const record of owned) {
    if (isAlive(record)) {
      contained.push(`${record.role}:${record.pid}`);
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
  }
  await rm(directory, { recursive: true, force: true });
  if (contained.length > 0) {
    throw new Error(`Watchdog containment had to kill leftover processes: ${contained.join(', ')}`);
  }
});

function config(mode: string): BotProcessConfig {
  return {
    executable: process.execPath,
    args: [parentFixture, mode],
    cwd: directory,
    workspaceRoot: directory,
    restBaseUrl: 'http://127.0.0.1:1/api/v10',
    gatewayUrl: 'ws://127.0.0.1:2/gateway',
  };
}

function reports(target: BotRunner): Record<string, unknown>[] {
  return target
    .snapshot()
    .output.filter((entry) => entry.stream === 'stdout')
    .map((entry) => entry.text)
    .join('')
    .split('\n')
    .flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function waitFor<T>(
  description: string,
  probe: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function identity(target: BotRunner, role: string): Promise<ProcessRecord> {
  const report = await waitFor(`${role} identity report`, () =>
    reports(target).find((entry) => entry['role'] === role && typeof entry['pid'] === 'number'),
  );
  const record: ProcessRecord = {
    role,
    pid: report['pid'] as number,
    pgid: (report['pgid'] as number | null) ?? null,
    starttime: (report['starttime'] as string | null) ?? null,
  };
  owned.push(record);
  return record;
}

/** A test-owned process in its own process group; BotRunner must never signal it. */
async function startUnownedControl(): Promise<ProcessRecord> {
  const control = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolvePromise, reject) => {
    control.once('spawn', resolvePromise);
    control.once('error', reject);
  });
  control.unref();
  const pid = control.pid as number;
  const stat = await waitFor('control /proc entry', () => readProcStat(pid) ?? undefined);
  const record: ProcessRecord = {
    role: 'unowned-control',
    pid,
    pgid: stat.pgid,
    starttime: stat.starttime,
  };
  controls.push(record);
  return record;
}

function stopControl(record: ProcessRecord): void {
  if (!isAlive(record)) return;
  process.kill(record.pid, 'SIGKILL');
}

function handleCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

async function settledBaseline(): Promise<Record<string, number>> {
  let previous = trackedHandles();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const current = trackedHandles();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

function trackedHandles(): Record<string, number> {
  const counts = handleCounts();
  return Object.fromEntries(
    ['Timeout', 'ChildProcess', 'PipeWrap', 'TCPServerWrap', 'TCPSocketWrap'].map((type) => [
      type,
      counts[type] ?? 0,
    ]),
  );
}

/**
 * Handle types whose count stays above the settled baseline. Counts below baseline are not
 * leaks (an unrelated runner timer present at baseline may finish meanwhile), so only excess
 * over baseline is reported.
 */
async function excessHandles(baseline: Record<string, number>): Promise<Record<string, number>> {
  const deadline = Date.now() + 2_000;
  const excess = (): Record<string, number> =>
    Object.fromEntries(
      Object.entries(trackedHandles()).filter(([type, count]) => count > (baseline[type] ?? 0)),
    );
  let current = excess();
  while (Object.keys(current).length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    current = excess();
  }
  return current;
}

describe.runIf(isLinux)('BotRunner M1 owned process-tree lifecycle (Linux)', () => {
  it(
    'D4-A unexpected-clean-parent-exit: stop terminates the surviving owned same-pgid grandchild',
    { timeout: 15_000 },
    async () => {
      const control = await startUnownedControl();
      runner = new BotRunner();
      await runner.start(config('tree-clean-exit'));
      const parent = await identity(runner, 'parent');
      const grandchild = await identity(runner, 'grandchild');
      expect(grandchild.pgid).toBe(parent.pid);
      await waitFor('unexpected parent exit 0', () =>
        runner?.snapshot().exitCode === 0 ? true : undefined,
      );
      expect(isAlive(parent)).toBe(false);
      expect(isAlive(grandchild)).toBe(true);
      // Ownership of the surviving group is retained: a new run cannot replace it.
      await expect(runner.start(config('stubborn'))).rejects.toThrow(/already running/);

      await runner.stop(200);

      expect(isAlive(grandchild)).toBe(false);
      expect(isAlive(control)).toBe(true);
      stopControl(control);
    },
  );

  it(
    'D2/D4-B graceful-parent-exit: stop does not resolve while an owned grandchild ignores SIGTERM',
    { timeout: 15_000 },
    async () => {
      const control = await startUnownedControl();
      runner = new BotRunner();
      await runner.start(config('tree-term-exit'));
      const parent = await identity(runner, 'parent');
      const grandchild = await identity(runner, 'grandchild');
      await waitFor('tree ready', () =>
        runner === undefined
          ? undefined
          : reports(runner).find((entry) => entry['event'] === 'tree-ready'),
      );
      expect(grandchild.pgid).toBe(parent.pid);

      await runner.stop(200);

      expect(isAlive(parent)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
      expect(isAlive(control)).toBe(true);
      expect(runner.snapshot().pid).toBeUndefined();
      stopControl(control);
    },
  );

  it(
    'L10 stubborn-tree (core): parent and grandchild ignoring SIGTERM are both dead when stop resolves',
    { timeout: 15_000 },
    async () => {
      runner = new BotRunner();
      await runner.start(config('stubborn-tree'));
      const parent = await identity(runner, 'parent');
      const grandchild = await identity(runner, 'grandchild');
      await waitFor('tree ready', () =>
        runner === undefined
          ? undefined
          : reports(runner).find((entry) => entry['event'] === 'tree-ready'),
      );
      const stopped = await runner.stop(100);
      expect(stopped.status).toBe('stopped');
      expect(stopped.signal).toBe('SIGKILL');
      expect(isAlive(parent)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
    },
  );

  it(
    'D2 graceMs=0 keeps immediate-force semantics and confirms termination',
    { timeout: 15_000 },
    async () => {
      runner = new BotRunner();
      await runner.start(config('stubborn'));
      const parent = await identity(runner, 'parent');
      const stopped = await runner.stop(0);
      expect(stopped.status).toBe('stopped');
      expect(isAlive(parent)).toBe(false);
    },
  );

  it(
    'D4 ownership release: a confirmed-empty group is forgotten, repeated stop is harmless, restart works',
    { timeout: 15_000 },
    async () => {
      runner = new BotRunner();
      await runner.start(config('tree-term-exit'));
      const firstParent = await identity(runner, 'parent');
      await identity(runner, 'grandchild');
      await waitFor('tree ready', () =>
        runner === undefined
          ? undefined
          : reports(runner).find((entry) => entry['event'] === 'tree-ready'),
      );
      await runner.stop(200);
      const repeated = await runner.stop(200);
      expect(repeated.pid).toBeUndefined();
      expect(repeated.status).toBe('stopped');

      const restarted = await runner.start(config('stubborn'));
      expect(restarted.status).toBe('running');
      expect(restarted.pid).not.toBe(firstParent.pid);
      const secondParent = await identity(runner, 'parent');
      await runner.stop(100);
      expect(isAlive(secondParent)).toBe(false);
    },
  );

  it(
    'L09 wait-listener-balance (behavioural): spawn/error/exit/timer paths return handle counts to baseline',
    { timeout: 20_000 },
    async () => {
      // Listener counts: not observable through the public API, reported as uncovered.
      const baseline = await settledBaseline();

      // error wins waitForSpawn.
      const failing = new BotRunner();
      await expect(
        failing.start({ ...config('stubborn'), executable: join(directory, 'missing-binary') }),
      ).rejects.toThrow();
      expect(await excessHandles(baseline)).toEqual({});

      // spawn wins waitForSpawn, exit wins the graceful waitForExit.
      runner = new BotRunner();
      await runner.start(config('tree-term-exit'));
      await identity(runner, 'parent');
      await identity(runner, 'grandchild');
      await waitFor('tree ready', () =>
        runner === undefined
          ? undefined
          : reports(runner).find((entry) => entry['event'] === 'tree-ready'),
      );
      await runner.stop(200);
      expect(await excessHandles(baseline)).toEqual({});

      // timer wins the graceful waitForExit, then a late exit arrives after SIGKILL.
      const stubborn = new BotRunner();
      runner = stubborn;
      await stubborn.start(config('stubborn'));
      await identity(stubborn, 'parent');
      const warnings: Error[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(warning);
      };
      process.on('warning', onWarning);
      try {
        await stubborn.stop(50);
        expect(await excessHandles(baseline)).toEqual({});
      } finally {
        process.off('warning', onWarning);
      }
      expect(warnings.map((warning) => warning.name)).not.toContain('MaxListenersExceededWarning');
    },
  );
});

describe('BotRunner M1 platform-conditional oracles', () => {
  it.runIf(process.platform === 'win32')(
    'D3 windows-taskkill: stop observes taskkill completion and confirms owned child termination',
    { timeout: 20_000 },
    async () => {
      runner = new BotRunner();
      const started = await runner.start({
        ...config('stubborn'),
        args: ['-e', 'setInterval(() => undefined, 1_000)'],
      });
      const pid = started.pid as number;
      const stopped = await runner.stop(200);
      expect(stopped.pid).toBeUndefined();
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.runIf(!isLinux)(
    'pending: /proc-based process-tree oracles are Linux-only and were not executed on this platform',
    () => {
      expect(isLinux).toBe(false);
    },
  );
});
