import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BotRunner, type BotProcessControl } from '../../src/bot-runner.js';

describe.skipIf(process.platform === 'win32')('real graceful shutdown control completion', () => {
  for (const balanced of [false, true]) {
    it(`${balanced ? 'accepts a delayed paired end' : 'rejects a dangling handler'} before stop returns`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'disrunner-shutdown-controls-'));
      const controls: BotProcessControl[] = [];
      const runner = new BotRunner({ onControl: (record) => controls.push(record) });
      try {
        await runner.start({
          executable: process.execPath,
          args: [
            '-e',
            `const {writeSync} = require('node:fs');
            process.on('SIGTERM', () => {
              writeSync(1, 'DISRUNNER_HANDLER {"id":"raw-9999","phase":"start"}\\n');
              ${balanced ? 'setTimeout(() => {writeSync(1, \'DISRUNNER_HANDLER {"id":"raw-9999","phase":"end"}\\n\'); process.exit(0);}, 50);' : 'process.exit(0);'}
            });
            console.log('running'); setInterval(() => {}, 1000);`,
          ],
          cwd: directory,
          workspaceRoot: directory,
          restBaseUrl: 'http://127.0.0.1:1/api/v10',
          gatewayUrl: 'ws://127.0.0.1:2/gateway',
        });
        const deadline = performance.now() + 5_000;
        while (!runner.snapshot().output.some(({ text }) => text === 'running\n')) {
          if (performance.now() > deadline)
            throw new Error('Child did not install shutdown handling.');
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        await runner.stop(1_000);
        expect(runner.snapshot()).toMatchObject({ status: 'stopped', exitCode: 0 });
        expect(runner.evidence()).toMatchObject({
          outputDrained: true,
          outputDrainErrors: 0,
          complete: balanced,
        });
        expect(controls.map(({ kind }) => kind)).toEqual(
          balanced ? ['handler', 'handler'] : ['handler', 'protocol-error'],
        );
      } finally {
        await runner.stop(100);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
