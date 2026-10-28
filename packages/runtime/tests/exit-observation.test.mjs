import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DesktopRuntimeManager } from '../dist/runtime-manager.js';

const fixture = fileURLToPath(
  new URL('../../../apps/cli/tests/fixtures/bot-test/', import.meta.url),
);

for (const platform of ['win32', 'darwin']) {
  test(`an observed exit survives stop intent before the ${platform} snapshot catches up`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-exit-observation-'));
    await cp(fixture, directory, { recursive: true });
    let exited = false;
    let bot;
    const manager = new DesktopRuntimeManager(
      () => {},
      () => {},
      {
        wrapBot(original) {
          bot = original;
          return {
            start: (...args) => original.start(...args),
            stop: (...args) => original.stop(...args),
            snapshot: () => original.snapshot(),
            evidence: () => original.evidence(),
            // Model the OS observation arriving before the event-driven snapshot.
            observeExit: () => (exited ? 'exited' : original.observeExit()),
          };
        },
      },
    );
    try {
      await manager.selectProject(directory);
      assert.equal((await manager.start()).phase, 'running');
      assert.equal(bot.snapshot().status, 'running');
      exited = true;
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      let stopping;
      try {
        // Only the synchronous stop-intent boundary uses the simulated platform.
        // Real cleanup runs on the host after the descriptor is restored.
        Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
        stopping = manager.stop();
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
      await stopping;
      assert.deepEqual(
        manager.shutdownIssues.map((issue) => issue.code),
        ['child-exited'],
      );
      assert.equal(bot.snapshot().pid, undefined);
      assert.equal(bot.evidence().outputDrained, true);
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
