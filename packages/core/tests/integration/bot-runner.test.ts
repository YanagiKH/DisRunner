import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BotRunner } from '../../src/index.js';

describe('BotRunner', () => {
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
