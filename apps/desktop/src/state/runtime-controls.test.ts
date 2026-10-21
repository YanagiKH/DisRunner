import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, ShutdownResult } from '@disrunner/runtime';
import { confirmsCleanup, currentStopResult, runtimeControls } from './runtime-controls';
import { cleanupConfirmed, cleanupMessage } from '../../electron/shutdown-policy.js';

const ready: SessionSnapshot = {
  schemaVersion: 1,
  sessionId: 'session',
  runId: 'run',
  revision: 4,
  disposed: false,
  contexts: [],
  phase: 'ready',
  project: {
    root: '/project',
    configPath: '/project/config.json',
    botName: 'Bot',
    executable: 'node',
    args: [],
    cwd: '/project',
    adapter: 'raw',
    mode: 'strict',
    seed: 1,
    environmentNames: [],
  },
  error: null,
  pid: null,
  endpoints: null,
  output: [],
  traces: [],
  risks: [],
};
const cleanup = { code: 'cleanup' as const, message: 'REST closure could not be confirmed.' };
const exited = { code: 'child-exited' as const, message: 'Bot process exited unexpectedly.' };

describe('handwritten shutdown outcomes shared by UI and quit policy', () => {
  const cases: [string, ShutdownResult, boolean][] = [
    ['clean ready', { ok: true, errors: [], snapshot: ready }, true],
    ['clean idle', { ok: true, errors: [], snapshot: { ...ready, phase: 'idle' } }, true],
    ['historical exit', { ok: false, errors: [exited], snapshot: ready }, true],
    [
      'unconfirmed exit',
      { ok: false, errors: [exited], snapshot: { ...ready, phase: 'error' } },
      false,
    ],
    ['empty failure', { ok: false, errors: [], snapshot: ready }, false],
    ['cleanup failure', { ok: false, errors: [cleanup], snapshot: ready }, false],
    ['contradictory success', { ok: true, errors: [cleanup], snapshot: ready }, false],
    ['still stopping', { ok: true, errors: [], snapshot: { ...ready, phase: 'stopping' } }, false],
  ];
  it.each(cases)('%s', (_label, result, expected) => {
    expect(confirmsCleanup(result)).toBe(expected);
    expect(cleanupConfirmed(result)).toBe(expected);
  });
  it('uses a nonempty, unconfirmed fallback', () => {
    expect(cleanupMessage({ ok: false, errors: [], snapshot: ready })).toBe(
      'Session cleanup did not confirm success.',
    );
  });
});

describe('conservative controls and stop correlation', () => {
  it('blocks restart in error regardless of null PID/endpoints', () => {
    expect(runtimeControls({ ...ready, phase: 'error' }, null, false)).toEqual({
      canStart: false,
      canStop: true,
      canSelect: false,
      recovery: true,
    });
  });
  it('allows recovery after an IPC failure even if the last snapshot says ready', () => {
    expect(runtimeControls(ready, null, true)).toEqual({
      canStart: false,
      canStop: true,
      canSelect: false,
      recovery: true,
    });
  });
  it('permits startup cancellation but blocks duplicate stop and disposed reuse', () => {
    expect(runtimeControls({ ...ready, phase: 'starting' }, 'start', false).canStop).toBe(true);
    expect(runtimeControls({ ...ready, phase: 'starting' }, 'stop', false).canStop).toBe(false);
    expect(runtimeControls({ ...ready, disposed: true }, null, false)).toEqual({
      canStart: false,
      canStop: false,
      canSelect: false,
      recovery: false,
    });
  });
  it('accepts same-operation intermediate revisions, rejects new session/run or newer conflicting terminal state', () => {
    const start = { ...ready, phase: 'running' as const, revision: 2 };
    const result = { ok: true, errors: [], snapshot: ready };
    expect(currentStopResult(start, { ...ready, phase: 'stopping', revision: 3 }, result)).toBe(
      true,
    );
    expect(currentStopResult(start, { ...ready, revision: 5 }, result)).toBe(true);
    expect(currentStopResult(start, { ...ready, phase: 'error', revision: 5 }, result)).toBe(false);
    expect(currentStopResult(start, { ...ready, runId: 'replacement' }, result)).toBe(false);
    expect(currentStopResult(start, { ...ready, sessionId: 'replacement' }, result)).toBe(false);
  });
});
