import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BotRunner } from '../../src/index.js';

describe('BotRunner capacity boundaries', () => {
  it('coalesces concurrent stop calls instead of retaining one exit listener per caller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-bot-stop-capacity-'));
    const runner = new BotRunner();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      await expect(
        runner.start({
          executable: process.execPath,
          args: new Array(1_000_000_000) as string[],
          cwd: directory,
          workspaceRoot: directory,
          restBaseUrl: 'http://127.0.0.1:1',
          gatewayUrl: 'ws://127.0.0.1:2',
        }),
      ).rejects.toThrow(/Bot arguments/);
      await runner.start({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1_000)'],
        cwd: directory,
        workspaceRoot: directory,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
      });
      const snapshots = await Promise.all(
        Array.from({ length: 64 }, async () => runner.stop(1_000)),
      );
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(snapshots.every((snapshot) => snapshot.status === 'stopped')).toBe(true);
      expect(warnings.some((warning) => warning.name === 'MaxListenersExceededWarning')).toBe(
        false,
      );
    } finally {
      process.off('warning', onWarning);
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('isolates a failing output observer from the child lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-bot-observer-capacity-'));
    let calls = 0;
    const runner = new BotRunner({
      onOutput: () => {
        calls += 1;
        throw new Error('observer failure');
      },
    });
    try {
      await runner.start({
        executable: process.execPath,
        args: ['-e', "console.log('one'); console.log('two')"],
        cwd: directory,
        workspaceRoot: directory,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
      });
      await waitUntilStopped(runner);
      const snapshot = runner.snapshot();
      expect(snapshot.status).toBe('stopped');
      expect(snapshot.exitCode).toBe(0);
      expect(calls).toBe(1);
      expect(snapshot.output.some((entry) => entry.text.includes('observer threw'))).toBe(true);
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitUntilStopped(runner: BotRunner): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (runner.snapshot().status === 'starting' || runner.snapshot().status === 'running') {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bot process.');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
