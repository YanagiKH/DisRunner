import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BotRunner, type BotProcessOutput } from '../../src/bot-runner.js';
import { sanitizeForExport } from '../../src/export-sanitizer.js';

async function runChild(
  runner: BotRunner,
  directory: string,
  script: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  await runner.start({
    executable: process.execPath,
    args: ['-e', script],
    cwd: directory,
    workspaceRoot: directory,
    restBaseUrl: 'http://127.0.0.1:1/api/v10',
    gatewayUrl: 'ws://127.0.0.1:2/gateway',
    env,
  });
  const deadline = performance.now() + 5_000;
  while (runner.snapshot().status === 'starting' || runner.snapshot().status === 'running') {
    if (performance.now() > deadline) throw new Error('Child did not finish.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  await runner.stop(100);
  expect(runner.snapshot()).toMatchObject({ status: 'stopped', exitCode: 0 });
}

describe('configured secrets in actual child output', () => {
  it('redacts multiline and JSON-escaped output before history, observers and export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-private-lines-'));
    const observed: BotProcessOutput[] = [];
    const runner = new BotRunner({ onOutput: (entry) => observed.push(entry) });
    const secret = 'child-private-first-quote"\\\nchild-private-second-測試';
    try {
      await runChild(
        runner,
        directory,
        `const value = process.env.LOCAL_CREDENTIAL;
         process.stdout.write(value + '\\n');
         process.stderr.write(JSON.stringify(value).slice(1, -1) + '\\n');
         process.stdout.write('visible-line\\n');`,
        { LOCAL_CREDENTIAL: secret },
      );
      const output = runner
        .snapshot()
        .output.map(({ text }) => text)
        .join('');
      expect(output).toContain('visible-line');
      expect(output.match(/\[REDACTED\]/gu)).toHaveLength(3);
      const exported = JSON.stringify(sanitizeForExport({ snapshot: runner.snapshot(), observed }));
      for (const line of secret.split('\n')) {
        expect(output).not.toContain(line);
        expect(exported).not.toContain(JSON.stringify(line).slice(1, -1));
      }
      expect(runner.evidence()).toMatchObject({
        truncatedLines: 0,
        redactionTruncatedEntries: 0,
        observerFailures: 0,
        complete: true,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('omits an oversized source line when a known value completes in a later pipe chunk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-private-chunks-'));
    const observed: BotProcessOutput[] = [];
    const runner = new BotRunner({
      maxOutputLineBytes: 64,
      onOutput: (entry) => observed.push(entry),
    });
    const secret = 'split-private-credential-value-0123456789';
    const first = `${'p'.repeat(60)}${secret.slice(0, 12)}`;
    const remainder = `${secret.slice(12)}\n`;
    try {
      await runChild(
        runner,
        directory,
        `process.stdout.write(${JSON.stringify(first)}, () => setTimeout(() => {
           process.stdout.write(${JSON.stringify(remainder + 'visible-next\n')});
         }, 40));`,
        { LOCAL_CREDENTIAL: secret },
      );
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual([
        '[TRUNCATED]\n',
        'visible-next\n',
      ]);
      expect(observed.map(({ text }) => text)).toEqual(['[TRUNCATED]\n', 'visible-next\n']);
      expect(JSON.stringify(observed)).not.toContain(secret.slice(0, 12));
      const evidence = runner.evidence();
      expect(evidence).toMatchObject({
        receivedBytes: Buffer.byteLength(first + remainder + 'visible-next\n'),
        truncatedLines: 1,
        redactionTruncatedEntries: 0,
        observerFailures: 0,
        complete: false,
      });
      expect(evidence.clippedBytes + evidence.discardedBytes).toBe(
        Buffer.byteLength(first + remainder),
      );
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts a known value across the sanitizer cutoff before retaining or publishing its prefix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-private-cutoff-'));
    const observed: BotProcessOutput[] = [];
    const runner = new BotRunner({
      maxOutputLineBytes: 200_000,
      onOutput: (entry) => observed.push(entry),
    });
    const secret = 'cutoff-private-child-credential-value';
    try {
      await runChild(
        runner,
        directory,
        "process.stdout.write('p'.repeat(99_995) + process.env.LOCAL_CREDENTIAL + '\\n');",
        { LOCAL_CREDENTIAL: secret },
      );
      expect(runner.snapshot().output).toHaveLength(1);
      const output = runner.snapshot().output[0]?.text;
      expect(output).toBe(`${'p'.repeat(99_995)}[REDACTED][REDACTION_STRING_TRUNCATED]`);
      expect(JSON.stringify(observed)).not.toContain(secret.slice(0, 5));
      expect(runner.evidence()).toMatchObject({
        truncatedLines: 0,
        redactionTruncatedEntries: 1,
        observerFailures: 0,
        complete: false,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures the maximum configured count and values longer than the old redactor limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-private-envelope-'));
    const runner = new BotRunner();
    const env = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `KEY_${index}_CREDENTIAL`,
        `child-private-${index}-quote"\\`,
      ]),
    );
    try {
      await runChild(
        runner,
        directory,
        'console.log(process.env.KEY_0_CREDENTIAL); console.log(JSON.stringify(process.env.KEY_255_CREDENTIAL).slice(1, -1));',
        env,
      );
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual([
        '[REDACTED]\n',
        '[REDACTED]\n',
      ]);
      expect(runner.evidence().complete).toBe(true);
      await runChild(runner, directory, 'console.log(process.env.LOCAL_CREDENTIAL);', {
        LOCAL_CREDENTIAL: `long-child-private-${'x'.repeat(5_000)}`,
      });
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual(['[REDACTED]\n']);
      expect(runner.evidence().complete).toBe(true);
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records incomplete capture when a bounded variant expansion omits all source text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-private-variants-'));
    const runner = new BotRunner();
    const secret = Array.from({ length: 5_000 }, (_, index) => `part-${index}`).join('\n');
    try {
      await runChild(runner, directory, "console.log('private output');", { API_KEY: secret });
      expect(runner.snapshot().output.map(({ text }) => text)).toEqual([
        '[REDACTION_SENSITIVE_VALUES_LIMIT]',
      ]);
      expect(runner.evidence()).toMatchObject({
        receivedBytes: 15,
        clippedBytes: 15,
        redactionTruncatedEntries: 1,
        observerFailures: 0,
        complete: false,
      });
    } finally {
      await runner.stop(100);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
