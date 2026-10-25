import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BotRunner } from '../../src/bot-runner.js';

async function runChild(runner: BotRunner, directory: string, script: string): Promise<void> {
  await runner.start({
    executable: process.execPath,
    args: ['-e', script],
    cwd: directory,
    workspaceRoot: directory,
    restBaseUrl: 'http://127.0.0.1:1/api/v10',
    gatewayUrl: 'ws://127.0.0.1:2/gateway',
  });
  const deadline = performance.now() + 5_000;
  while (runner.snapshot().status === 'starting' || runner.snapshot().status === 'running') {
    if (performance.now() > deadline) throw new Error('Child did not finish.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  await runner.stop(100);
}

describe('real bot output evidence', () => {
  it('counts flood eviction and resets all capture counters on the next run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-output-evidence-'));
    const runner = new BotRunner({
      maxOutputEntries: 3,
      maxOutputBytes: 1_024,
      maxOutputLineBytes: 128,
    });
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index}\n`);
    try {
      await runChild(
        runner,
        directory,
        `process.stdout.write(${JSON.stringify(lines.join(''))}); setTimeout(() => process.exit(0), 25);`,
      );
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual(lines.slice(-3));
      expect(runner.evidence()).toEqual({
        receivedBytes: Buffer.byteLength(lines.join('')),
        recordedEntries: 100,
        retainedEntries: 3,
        retainedBytes: Buffer.byteLength(lines.slice(-3).join('')),
        evictedEntries: 97,
        evictedBytes: Buffer.byteLength(lines.slice(0, -3).join('')),
        truncatedLines: 0,
        discardedBytes: 0,
        clippedBytes: 0,
        redactionTruncatedEntries: 0,
        observerFailures: 0,
        controlRecords: 0,
        controlErrors: 0,
        controlObserverFailures: 0,
        complete: false,
      });
      await runChild(
        runner,
        directory,
        "process.stdout.write('fresh\\n'); setTimeout(() => process.exit(0), 25);",
      );
      expect(runner.evidence()).toEqual({
        receivedBytes: 6,
        recordedEntries: 1,
        retainedEntries: 1,
        retainedBytes: 6,
        evictedEntries: 0,
        evictedBytes: 0,
        truncatedLines: 0,
        discardedBytes: 0,
        clippedBytes: 0,
        redactionTruncatedEntries: 0,
        observerFailures: 0,
        controlRecords: 0,
        controlErrors: 0,
        controlObserverFailures: 0,
        complete: true,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accounts for byte-capacity loss independently of the entry count', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-output-bytes-'));
    const runner = new BotRunner({
      maxOutputEntries: 100,
      maxOutputBytes: 32,
      maxOutputLineBytes: 32,
    });
    const line = 'x'.repeat(15) + '\n';
    try {
      await runChild(
        runner,
        directory,
        `process.stdout.write(${JSON.stringify(line.repeat(10))}); setTimeout(() => process.exit(0), 25);`,
      );
      expect(runner.evidence()).toMatchObject({
        receivedBytes: 160,
        recordedEntries: 10,
        retainedEntries: 2,
        retainedBytes: 32,
        evictedEntries: 8,
        evictedBytes: 128,
        complete: false,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('distinguishes clipped line bytes from whole-history eviction with UTF-8 output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-output-line-'));
    const runner = new BotRunner({
      maxOutputEntries: 10,
      maxOutputBytes: 1_024,
      maxOutputLineBytes: 32,
    });
    const oversized = '界'.repeat(10_000) + '\n';
    try {
      await runChild(
        runner,
        directory,
        `process.stdout.write(${JSON.stringify(oversized)}); process.stdout.write('done\\n'); setTimeout(() => process.exit(0), 25);`,
      );
      expect(runner.snapshot().output).toHaveLength(2);
      expect(runner.snapshot().output[0]?.text).toBe('[TRUNCATED]\n');
      expect(runner.snapshot().output[1]?.text).toBe('done\n');
      const evidence = runner.evidence();
      expect(evidence).toMatchObject({
        receivedBytes: Buffer.byteLength(oversized) + 5,
        recordedEntries: 2,
        evictedEntries: 0,
        evictedBytes: 0,
        truncatedLines: 1,
        redactionTruncatedEntries: 0,
        complete: false,
      });
      expect(evidence.clippedBytes + evidence.discardedBytes).toBe(Buffer.byteLength(oversized));
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks an observer failure without disrupting process exit or future capture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-output-observer-'));
    const runner = new BotRunner({
      onOutput() {
        throw new Error('subscriber failed');
      },
    });
    try {
      await runChild(
        runner,
        directory,
        "process.stdout.write('one\\ntwo\\n'); setTimeout(() => process.exit(0), 25);",
      );
      expect(runner.snapshot()).toMatchObject({ status: 'stopped', exitCode: 0 });
      expect(runner.evidence()).toMatchObject({
        receivedBytes: 8,
        recordedEntries: 3,
        retainedEntries: 3,
        observerFailures: 1,
        complete: false,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports string-sanitizer truncation even when the configured line limit was not reached', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-output-redaction-limit-'));
    const runner = new BotRunner({
      maxOutputEntries: 10,
      maxOutputBytes: 500_000,
      maxOutputLineBytes: 200_000,
    });
    try {
      await runChild(
        runner,
        directory,
        "process.stdout.write('x'.repeat(150_000) + '\\n', () => setTimeout(() => process.exit(0), 25));",
      );
      expect(runner.snapshot().output).toHaveLength(1);
      expect(runner.snapshot().output[0]?.text).toContain('[REDACTION_STRING_TRUNCATED]');
      expect(runner.evidence()).toMatchObject({
        receivedBytes: 150_001,
        recordedEntries: 1,
        retainedEntries: 1,
        evictedEntries: 0,
        truncatedLines: 0,
        discardedBytes: 0,
        clippedBytes: 50_001,
        redactionTruncatedEntries: 1,
        complete: false,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
