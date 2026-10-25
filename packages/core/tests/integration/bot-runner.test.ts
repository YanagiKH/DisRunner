import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BotRunner } from '../../src/index.js';

describe('BotRunner', () => {
  it('allows immediate valid-process retry after a failed spawn without requiring stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-spawn-retry-'));
    const controls: { readonly kind: string }[] = [];
    const runner = new BotRunner({ onControl: (record) => controls.push(record) });
    const common = {
      cwd: directory,
      workspaceRoot: directory,
      restBaseUrl: 'http://127.0.0.1:1/api/v10',
      gatewayUrl: 'ws://127.0.0.1:2/gateway',
    };
    try {
      await expect(
        runner.start({ ...common, executable: join(directory, 'does-not-exist') }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(runner.snapshot()).toMatchObject({ status: 'crashed' });
      expect(runner.snapshot().pid).toBeUndefined();
      const previousControls = controls.length;
      await runner.start({
        ...common,
        executable: process.execPath,
        args: ['-e', "console.log('DISRUNNER_ADAPTER_READY'); console.log('retry completed');"],
      });
      await waitUntil(
        () => runner.snapshot().status !== 'running' && runner.snapshot().status !== 'starting',
      );
      await runner.stop(100);
      expect(runner.snapshot()).toMatchObject({ status: 'stopped', exitCode: 0 });
      expect(controls.slice(previousControls)).toEqual([{ kind: 'ready' }]);
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual(['retry completed\n']);
      expect(runner.evidence()).toMatchObject({
        controlRecords: 1,
        controlErrors: 0,
        outputDrainErrors: 0,
        outputDrained: true,
        complete: true,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts without a real token, captures redacted output, and observes exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-core-test-'));
    const runner = new BotRunner();
    const interactionPeerSecret = 'cd'.repeat(32);
    try {
      await runner.start({
        executable: process.execPath,
        args: [
          '-e',
          'console.log(`Authorization: Bot real-looking-secret-123456789`); console.log(process.env.DISRUNNER_OFFLINE); console.log(`peer=${process.env.DISRUNNER_WEBHOOK_PEER_SECRET}`)',
        ],
        cwd: directory,
        workspaceRoot: directory,
        env: { BOT_TOKEN: 'must-not-leak', UNRELATED: 'kept' },
        restBaseUrl: 'http://127.0.0.1:1/api/v10',
        gatewayUrl: 'ws://127.0.0.1:2/gateway',
        interactionEndpoint: 'http://127.0.0.1:3/interactions',
        interactionPeerSecret,
      });
      await waitUntil(
        () => runner.snapshot().status !== 'running' && runner.snapshot().status !== 'starting',
      );
      const snapshot = runner.snapshot();
      expect(snapshot).toMatchObject({ status: 'stopped', exitCode: 0 });
      const output = snapshot.output.map((entry) => entry.text).join('');
      expect(output).toContain('Bot [REDACTED]');
      expect(output).not.toContain('real-looking-secret');
      expect(output).toContain('1');
      expect(output).toContain('peer=[REDACTED]');
      expect(output).not.toContain(interactionPeerSecret);
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bot process.');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
