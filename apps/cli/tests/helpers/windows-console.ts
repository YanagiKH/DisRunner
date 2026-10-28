import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export async function launchWindowsConsole(command: string[], project: string) {
  const directory = join(project, 'console-controller');
  await mkdir(directory);
  await writeFile(join(directory, 'arguments.json'), JSON.stringify(command));
  const child = spawn(
    process.env['DISRUNNER_TEST_PYTHON'] ?? 'python',
    [fileURLToPath(new URL('./windows-console.py', import.meta.url)), directory],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let diagnostics = '';
  child.stdout.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  let watchdogUsed = false;
  const watchdog = setTimeout(() => {
    watchdogUsed = true;
    // This is the original owned controller handle. Its Job contains any children.
    child.kill('SIGKILL');
  }, 12_000);
  watchdog.unref();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
  });
  const result = closed.then(async (code) => {
    assert.equal(watchdogUsed, false, 'The console controller required watchdog containment.');
    const serialized = await readFile(join(directory, 'receipt.json'), 'utf8').catch(
      (error: unknown) => {
        throw new Error(`The console controller did not produce a receipt: ${diagnostics}`, {
          cause: error,
        });
      },
    );
    const receipt = JSON.parse(serialized) as {
      controllerPid: number;
      cliPid: number;
      eventDelivered: boolean;
      consoleClients: number[];
      remainingProcessIds: number[];
      activeProcesses: number;
      exitCode: number;
      containmentDisarmed: boolean;
      error: string | null;
    };
    assert.equal(code, 0, JSON.stringify({ receipt, diagnostics }));
    assert.equal(receipt.error, null);
    assert.equal(receipt.eventDelivered, true);
    assert.equal(receipt.containmentDisarmed, true);
    assert.deepEqual(receipt.remainingProcessIds, []);
    assert.equal(receipt.activeProcesses, 1);
    assert.deepEqual(
      receipt.consoleClients,
      [receipt.controllerPid, receipt.cliPid].sort((a, b) => a - b),
    );
    assert.throws(() => process.kill(receipt.cliPid, 0), { code: 'ESRCH' });
    console.info('WINDOWS_CTRL_C_EVIDENCE ' + JSON.stringify(receipt));
    return {
      code: receipt.exitCode,
      signal: null,
      stdout: await readFile(join(directory, 'stdout.txt'), 'utf8'),
      stderr: await readFile(join(directory, 'stderr.txt'), 'utf8'),
    };
  });
  // Attach immediately; the test awaits the same rejecting promise after its fixture gate.
  void result.catch(() => {});
  try {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        await readFile(join(directory, 'ready.json'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert.ok(Date.now() < deadline, 'The isolated console controller did not start.');
        if (child.exitCode !== null || child.signalCode !== null) await result;
        await delay(10);
      }
    }
  } catch (error) {
    await writeFile(join(directory, 'abort'), '');
    await closed;
    throw error;
  }
  return {
    child,
    result,
    interrupt: () => writeFile(join(directory, 'interrupt'), ''),
    async dispose() {
      if (child.exitCode === null && child.signalCode === null)
        await writeFile(join(directory, 'abort'), '');
      await closed;
    },
  };
}
