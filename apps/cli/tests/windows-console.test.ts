import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { launchWindowsConsole } from './helpers/windows-console.js';

describe.runIf(process.platform === 'win32')('native console driver failure containment', () => {
  it.each([
    ['leaked Bot after CLI exit', true, true, /owned process tree/u],
    ['unexpected attached console client', false, false, /unexpected attached clients/u],
  ] as const)(
    '%s cannot produce a successful cleanup receipt',
    async (_name, windowsHide, delivered, error) => {
      const directory = await mkdtemp(join(tmpdir(), 'DisRunner console negative '));
      const trace = join(directory, 'descendant.json');
      const executable = join(directory, 'uncooperative-cli.mjs');
      await writeFile(
        executable,
        `
import {spawn} from 'node:child_process';
import {writeFileSync, renameSync} from 'node:fs';
process.on('SIGINT', () => process.exit(130));
// Detached bypasses Node's own child Job but still inherits the controller's Job.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore', windowsHide: ${windowsHide}, detached: ${windowsHide},
});
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(trace + '.tmp')}, JSON.stringify({pid:child.pid}));
  renameSync(${JSON.stringify(trace + '.tmp')}, ${JSON.stringify(trace)});
});
setInterval(() => {}, 1000);
`,
      );
      let controller: Awaited<ReturnType<typeof launchWindowsConsole>> | undefined;
      try {
        controller = await launchWindowsConsole([process.execPath, executable], directory);
        let descendant: { pid: number } | undefined;
        const deadline = Date.now() + 4000;
        while (!descendant && Date.now() < deadline) {
          try {
            descendant = JSON.parse(await readFile(trace, 'utf8')) as { pid: number };
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
            await delay(10);
          }
        }
        expect(descendant?.pid).toBeGreaterThan(0);
        await controller.interrupt();
        await expect(controller.result).rejects.toThrow(error);
        const receipt = JSON.parse(
          await readFile(join(directory, 'console-controller', 'receipt.json'), 'utf8'),
        ) as {
          cliPid: number;
          eventDelivered: boolean;
          containmentDisarmed: boolean;
          remainingProcessIds: number[];
          consoleClients: number[];
          error: string;
        };
        expect(receipt.error).toMatch(error);
        expect(receipt.eventDelivered).toBe(delivered);
        expect(receipt.containmentDisarmed).toBe(false);
        if (delivered) expect(receipt.remainingProcessIds).toContain(descendant?.pid);
        else expect(receipt.consoleClients).toContain(descendant?.pid);
        const terminationDeadline = Date.now() + 1500;
        for (const pid of [receipt.cliPid, descendant!.pid]) {
          for (;;) {
            try {
              process.kill(pid, 0);
            } catch (failure) {
              expect((failure as NodeJS.ErrnoException).code).toBe('ESRCH');
              break;
            }
            expect(Date.now(), `Owned PID ${pid} survived failed-test containment`).toBeLessThan(
              terminationDeadline,
            );
            await delay(10);
          }
        }
        console.info(
          'WINDOWS_CONSOLE_NEGATIVE_EVIDENCE ' +
            JSON.stringify({
              case: _name,
              eventDelivered: delivered,
              failedBeforeContainment: true,
              allPidsDeadAfterContainment: true,
            }),
        );
      } finally {
        try {
          await controller?.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    15000,
  );
});
