import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import type * as os from 'node:os';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  list: vi.fn(),
  spawn: vi.fn(),
  platform: vi.fn(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  platform: mocks.platform,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  readFileSync: mocks.read,
  readdirSync: mocks.list,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { BotRunner } from '../../src/bot-runner.js';

const pid = 123456;
function procStat(target = pid, state = 'S', startTime = '100'): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = state;
  fields[2] = String(pid);
  fields[19] = startTime;
  return `${target} (fixture with ) parentheses) ${fields.join(' ')}`;
}
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}
let child: EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};
let killSpy: MockInstance<typeof process.kill>;
let leader: string | Error;
let member: string | Error;
let selfStat: string | Error;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue(process.platform);
  leader = procStat();
  member = errno('ENOENT');
  selfStat = procStat(process.pid);
  child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  mocks.list.mockReturnValue([String(pid), String(pid + 1)]);
  mocks.read.mockImplementation((path: string) => {
    const value =
      path === '/proc/self/stat' ? selfStat : path === `/proc/${pid}/stat` ? leader : member;
    if (value instanceof Error) throw value;
    return value;
  });
  killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    const value = target === pid ? leader : target === pid + 1 ? member : undefined;
    if (
      signal === 0 &&
      value instanceof Error &&
      (value as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw errno('ESRCH');
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function started(): Promise<BotRunner> {
  const runner = new BotRunner();
  await runner.start({
    executable: process.execPath,
    cwd: tmpdir(),
    workspaceRoot: tmpdir(),
    restBaseUrl: 'http://127.0.0.1:1/api/v10',
    gatewayUrl: 'ws://127.0.0.1:2/gateway',
  });
  return runner;
}

describe.skipIf(process.platform !== 'linux')('Linux lifecycle observation boundaries', () => {
  it('distinguishes a never-started snapshot from a started child', async () => {
    expect(new BotRunner().snapshot()).not.toHaveProperty('startedAtMs');
    expect((await started()).snapshot()).toMatchObject({ status: 'running', pid });
  });

  for (const [label, value] of [
    ['zombie', procStat(pid, 'Z')],
    ['dead', procStat(pid, 'X')],
    ['missing', errno('ENOENT')],
    ['reused identity', procStat(pid, 'S', '200')],
  ] as const) {
    it(`observes ${label} before the Node exit callback without releasing ownership`, async () => {
      const runner = await started();
      leader = value;
      expect(runner.snapshot()).toMatchObject({ status: 'running', pid });
      expect(runner.snapshot().exitCode).toBeUndefined();
      expect(runner.observeExit()).toBe('exited');
      expect(runner.snapshot().exitedAtMs).toBeUndefined();
      await expect(runner.start({} as never)).rejects.toThrow('already running');
      expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
    });
  }

  for (const [label, value] of [
    ['permission denied', errno('EACCES')],
    ['malformed', 'not a proc stat record'],
  ] as const) {
    it(`does not misclassify an unknown ${label} direct-child observation as an exit`, async () => {
      const runner = await started();
      leader = value;
      expect(runner.snapshot().status).toBe('running');
      expect(runner.observeExit()).toBe('unknown');
      await expect(runner.stop(0)).rejects.toThrow('uncertain');
      expect(killSpy).not.toHaveBeenCalled();
    });

    it(`retains group ownership after reaping if a member is ${label}, then retries`, async () => {
      const runner = await started();
      leader = procStat(pid, 'Z');
      member = value;
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await expect(runner.stop(0)).rejects.toThrow('uncertain');
      await expect(runner.start({} as never)).rejects.toThrow('already running');
      expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
      member = errno('ENOENT');
      await expect(runner.stop(0)).resolves.toMatchObject({ status: 'stopped' });
      expect(runner.snapshot().pid).toBeUndefined();
    });
  }

  for (const code of [0, 1]) {
    it(`keeps snapshot event-driven until Node classifies exit ${code}`, async () => {
      const runner = await started();
      expect(runner.observeExit()).toBe('alive');
      leader = procStat(pid, 'Z');
      expect(runner.observeExit()).toBe('exited');
      expect(runner.snapshot()).toMatchObject({ status: 'running', pid });
      expect(runner.snapshot().exitCode).toBeUndefined();
      expect(runner.snapshot().exitedAtMs).toBeUndefined();
      child.exitCode = code;
      child.emit('exit', code, null);
      expect(runner.snapshot()).toMatchObject({
        status: code === 0 ? 'stopped' : 'crashed',
        exitCode: code,
      });
      expect(runner.snapshot().pid).toBeUndefined();
      expect(runner.observeExit()).toBe('exited');
    });
  }

  for (const [label, value] of [
    ['missing mount', errno('ENOENT')],
    ['unreadable mount', errno('EACCES')],
    ['malformed self record', 'invalid'],
  ] as const) {
    it(`does not infer child death with ${label}`, async () => {
      const runner = await started();
      leader = errno('ENOENT');
      selfStat = value;
      expect(runner.observeExit()).toBe('unknown');
      expect(runner.snapshot()).toMatchObject({ status: 'running', pid });
      await expect(runner.stop(0)).rejects.toThrow('uncertain');
      expect(killSpy).not.toHaveBeenCalled();
    });
  }

  for (const probe of ['success', 'EPERM'] as const) {
    it(`keeps invisible per-PID ENOENT uncertain when the PID probe gives ${probe}`, async () => {
      const runner = await started();
      leader = errno('ENOENT');
      killSpy.mockImplementation(() => {
        if (probe === 'EPERM') throw errno('EPERM');
        return true;
      });
      expect(runner.observeExit()).toBe('unknown');
      await expect(runner.stop(0)).rejects.toThrow('uncertain');
      expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
    });
  }

  it('retains a group that exists but has no visible matching members, then releases on ESRCH', async () => {
    const runner = await started();
    leader = procStat(pid, 'Z');
    mocks.list.mockReturnValue([]);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(runner.stop(0)).rejects.toThrow('uncertain');
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
    killSpy.mockImplementation(() => {
      throw errno('ESRCH');
    });
    await expect(runner.stop(0)).resolves.toMatchObject({ status: 'stopped' });
    expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it('accepts unrelated kernel processes with process group zero while confirming emptiness', async () => {
    const runner = await started();
    leader = procStat(pid, 'Z');
    member = procStat(pid + 1).replace(` S 0 ${pid} `, ' S 0 0 ');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(runner.stop(0)).resolves.toMatchObject({ status: 'stopped' });
    expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it('does not signal a reused group leader identity', async () => {
    const runner = await started();
    leader = procStat(pid, 'S', '200');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await runner.stop(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('retains a live group with no captured identity after its leader disappears, until ESRCH', async () => {
    leader = errno('EACCES');
    const runner = await started();
    leader = errno('ENOENT');
    member = procStat(pid + 1);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(runner.stop(0)).rejects.toThrow('uncertain');
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
    killSpy.mockImplementation(() => {
      throw errno('ESRCH');
    });
    await expect(runner.stop(0)).resolves.toMatchObject({ status: 'stopped' });
    expect(killSpy.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it('does not signal a leader whose start identity could not be captured', async () => {
    leader = errno('EACCES');
    const runner = await started();
    leader = procStat();
    await expect(runner.stop(0)).rejects.toThrow('uncertain');
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('simulated Windows taskkill boundaries (not Windows tree qualification)', () => {
  let killer: EventEmitter;
  beforeEach(() => {
    mocks.platform.mockReturnValue('win32');
    killer = new EventEmitter();
    mocks.spawn.mockImplementation((executable: string) => {
      if (executable === 'taskkill') return killer;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
  });
  function exitChild(): void {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  }

  for (const failure of ['throw', 'error', 'nonzero', 'signal'] as const) {
    it(`rejects taskkill ${failure} and retains live-child ownership for retry`, async () => {
      const runner = await started();
      if (failure === 'throw')
        mocks.spawn.mockImplementationOnce(() => {
          throw errno('ENOENT');
        });
      const stopping = runner.stop(1);
      const rejected = expect(stopping).rejects.toThrow(/taskkill/i);
      if (failure === 'error') killer.emit('error', errno('ENOENT'));
      if (failure === 'nonzero') killer.emit('exit', 1, null);
      if (failure === 'signal') killer.emit('exit', null, 'SIGTERM');
      await rejected;
      await expect(runner.start({} as never)).rejects.toThrow('already running');
      const retry = runner.stop(1);
      killer.emit('exit', 0, null);
      exitChild();
      await expect(retry).resolves.toMatchObject({ status: 'stopped' });
      expect(killSpy).not.toHaveBeenCalled();
    });
  }

  it('retains an unknown tree after the child exits and never targets its potentially reused PID', async () => {
    const runner = await started();
    const stopping = runner.stop(1);
    const rejected = expect(stopping).rejects.toThrow(/taskkill/i);
    exitChild();
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    killer.emit('exit', 1, null);
    await rejected;
    await expect(runner.stop(1)).rejects.toThrow(/taskkill/i);
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    expect(mocks.spawn.mock.calls.filter(([executable]) => executable === 'taskkill')).toHaveLength(
      1,
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('awaits the owned child after taskkill succeeds', async () => {
    const runner = await started();
    let settled = false;
    const stopping = runner.stop(100).then((snapshot) => {
      settled = true;
      return snapshot;
    });
    killer.emit('exit', 0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    exitChild();
    await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
  });

  it('escalates with /F but rejects if both successful taskkill commands leave the child live', async () => {
    const runner = await started();
    vi.useFakeTimers();
    mocks.spawn.mockImplementation(() => {
      const command = new EventEmitter();
      void Promise.resolve().then(() => command.emit('exit', 0, null));
      return command;
    });
    const rejected = expect(runner.stop(1)).rejects.toThrow('termination could not be confirmed');
    await vi.runAllTimersAsync();
    await rejected;
    const commands = mocks.spawn.mock.calls.filter(([executable]) => executable === 'taskkill');
    expect(commands.map(([, args]) => args as readonly string[])).toEqual([
      ['/PID', String(pid), '/T'],
      ['/PID', String(pid), '/T', '/F'],
    ]);
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    expect(child.listenerCount('exit')).toBe(1);
    exitChild();
    await expect(runner.stop(1)).rejects.toThrow('termination could not be confirmed');
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    expect(mocks.spawn.mock.calls.filter(([executable]) => executable === 'taskkill')).toHaveLength(
      2,
    );
    expect(killSpy).not.toHaveBeenCalled();
  });
  for (const killOutcome of ['true', 'false', 'throw'] as const) {
    it(`bounds a hung taskkill helper whose kill returns ${killOutcome}, without allowing retry`, async () => {
      const runner = await started();
      vi.useFakeTimers();
      const helperKill = vi.fn(() => {
        if (killOutcome === 'throw') throw errno('EPERM');
        return killOutcome === 'true';
      });
      Object.assign(killer, { kill: helperKill });
      const rejected = expect(runner.stop(10)).rejects.toThrow(/taskkill.*timed out/i);
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(helperKill).toHaveBeenCalledOnce();
      expect(killer.listenerCount('exit')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      killer.emit('error', errno('ESRCH'));
      await expect(runner.stop(10)).rejects.toThrow(/taskkill/i);
      await expect(runner.start({} as never)).rejects.toThrow('already running');
      exitChild();
      await expect(runner.stop(10)).rejects.toThrow(/taskkill/i);
      await expect(runner.start({} as never)).rejects.toThrow('already running');
      expect(
        mocks.spawn.mock.calls.filter(([executable]) => executable === 'taskkill'),
      ).toHaveLength(1);
      expect(killSpy).not.toHaveBeenCalled();
    });
  }
});
