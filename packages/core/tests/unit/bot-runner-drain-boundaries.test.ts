import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import type * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  // Already-reaped children have no process tree to signal on this branch.
  platform: () => 'win32',
}));

import { BotRunner, type BotProcessControl } from '../../src/bot-runner.js';

function childFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 123456,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
}

function exited(child: ReturnType<typeof childFixture>): void {
  child.exitCode = 0;
  child.emit('exit', 0, null);
}

async function closeOutput(child: ReturnType<typeof childFixture>): Promise<void> {
  const ends = [once(child.stdout, 'end'), once(child.stderr, 'end')];
  child.stdout.end();
  child.stderr.end();
  child.stdin.end();
  await Promise.all(ends);
  child.emit('close', 0, null);
}

async function started() {
  const child = childFixture();
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const controls: BotProcessControl[] = [];
  const runner = new BotRunner({ onControl: (record) => controls.push(record) });
  await runner.start({
    executable: process.execPath,
    cwd: tmpdir(),
    workspaceRoot: tmpdir(),
    restBaseUrl: 'http://127.0.0.1:1/api/v10',
    gatewayUrl: 'ws://127.0.0.1:2/gateway',
  });
  return { child, controls, runner };
}

afterEach(() => vi.clearAllMocks());

describe('child exit and output drain ordering', () => {
  it('waits for already-reaped child output and accepts a frame completed after exit', async () => {
    const { child, controls, runner } = await started();
    child.stdout.write('DISRUNNER_HANDLER {"id":"raw-123","phase":"sta');
    exited(child);
    expect(controls).toEqual([]);
    expect(runner.evidence()).toMatchObject({ outputDrained: false, complete: false });
    await expect(runner.start({} as never)).rejects.toThrow('already running');
    let finished = false;
    const stopping = runner.stop(0).then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    child.stdout.write('rt"}\nDISRUNNER_HANDLER {"id":"raw-123","phase":"end"}\n');
    await closeOutput(child);
    await stopping;
    expect(controls).toEqual([
      { kind: 'handler', id: 'raw-123', phase: 'start' },
      { kind: 'handler', id: 'raw-123', phase: 'end' },
    ]);
    expect(runner.evidence()).toMatchObject({
      controlRecords: 2,
      controlErrors: 0,
      outputDrained: true,
      outputDrainErrors: 0,
      complete: true,
    });
  });

  it('keeps running in-flight capture complete and rejects an unmatched handler only at real EOF', async () => {
    const { child, controls, runner } = await started();
    child.stdout.write('DISRUNNER_HANDLER {"id":"raw-9999","phase":"start"}\n');
    expect(runner.evidence()).toMatchObject({ outputDrained: false, complete: true });
    exited(child);
    expect(controls).toHaveLength(1);
    const stopping = runner.stop(0);
    await closeOutput(child);
    await stopping;
    expect(controls.at(-1)).toEqual({
      kind: 'protocol-error',
      message: 'Invalid or incomplete Bot control record.',
    });
    expect(runner.evidence()).toMatchObject({
      controlErrors: 1,
      outputDrained: true,
      outputDrainErrors: 0,
      complete: false,
    });
  });

  it('bounds an unclosed inherited pipe and prevents late frames from changing finalized evidence', async () => {
    const { child, controls, runner } = await started();
    child.stdout.write('DISRUNNER_HANDLER {"id":"raw-123","phase":"sta');
    exited(child);
    const before = performance.now();
    await runner.stop(0);
    expect(performance.now() - before).toBeLessThan(1_500);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(controls).toEqual([
      { kind: 'protocol-error', message: 'Invalid or incomplete Bot control record.' },
    ]);
    expect(runner.evidence()).toMatchObject({
      outputDrained: false,
      outputDrainErrors: 1,
      complete: false,
    });
    expect(runner.snapshot().output).toEqual([]);
    const evidence = runner.evidence();
    child.stdout.emit('data', 'rt"}\nDISRUNNER_ADAPTER_READY\n');
    child.emit('close', 0, null);
    expect(runner.evidence()).toEqual(evidence);
  });

  it('fails closed for a stream error without exposing exception text or partial protocol data', async () => {
    const { child, controls, runner } = await started();
    child.stdout.write('DISRUNNER_DIAGNOSTIC {"code":"bot-error","message":"private-partial');
    child.stdout.emit('error', new Error('private-stream-error'));
    exited(child);
    await runner.stop(0);
    expect(controls).toEqual([
      { kind: 'protocol-error', message: 'Invalid or incomplete Bot control record.' },
    ]);
    expect(runner.snapshot().output).toEqual([]);
    expect(runner.evidence()).toMatchObject({ outputDrainErrors: 1, complete: false });
    expect(JSON.stringify(controls)).not.toContain('private');
  });
});
