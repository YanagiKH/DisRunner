import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BotRunner, type BotProcessControl, type BotProcessOutput } from '../../src/index.js';

const protocolError: BotProcessControl = {
  kind: 'protocol-error',
  message: 'Invalid or incomplete Bot control record.',
};

async function runChild(
  runner: BotRunner,
  directory: string,
  script: string,
  env: Readonly<Record<string, string>> = {},
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

async function fixture(
  run: (directory: string, runner: BotRunner) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'disrunner-control-'));
  const runner = new BotRunner();
  try {
    await run(directory, runner);
  } finally {
    await runner.stop(100);
    await rm(directory, { recursive: true, force: true });
  }
}

describe('pre-redaction Bot control records', () => {
  it('preserves fixed controls despite known-value collisions and redacts free-form messages and human output', async () => {
    await fixture(async (directory) => {
      const controls: BotProcessControl[] = [];
      const output: BotProcessOutput[] = [];
      const runner = new BotRunner({
        onControl: (record) => controls.push(record),
        onOutput: (entry) => output.push(entry),
      });
      try {
        await runChild(
          runner,
          directory,
          `const id = 'js-' + process.pid + '-1';
           console.log('DISRUNNER_ADAPTER_READY');
           console.log('DISRUNNER_HANDLER ' + JSON.stringify({id, phase: 'start'}));
           console.log('DISRUNNER_DIAGNOSTIC ' + JSON.stringify({code: 'bot-error', message: 'private-first\\nprivate-second'}));
           console.log('DISRUNNER_HANDLER ' + JSON.stringify({id, phase: 'end'}));
           console.log('DISRUNNER_ADAPTER_ERROR ' + JSON.stringify({code: 'unsupported', message: 'private-first\\nprivate-second'}));
           console.log('human DISRUNNER_HANDLER start private-first');`,
          {
            PREFIX_ACCESS_KEY: 'DISRUNNER_HANDLER',
            PHASE_ACCESS_KEY: 'start',
            ERROR_ACCESS_KEY: 'private-first\nprivate-second',
          },
        );
        expect(controls).toHaveLength(5);
        expect(controls[0]).toEqual({ kind: 'ready' });
        expect(controls[1]).toMatchObject({ kind: 'handler', phase: 'start' });
        expect(controls[2]).toEqual({
          kind: 'diagnostic',
          code: 'bot-error',
          message: '[REDACTED]',
        });
        expect(controls[3]).toMatchObject({ kind: 'handler', phase: 'end' });
        expect(controls[4]).toEqual({
          kind: 'adapter-error',
          code: 'unsupported',
          message: '[REDACTED]',
        });
        expect(controls.every(Object.isFrozen)).toBe(true);
        expect(output.map(({ text }) => text)).toEqual([
          'human [REDACTED] [REDACTED] [REDACTED]\n',
        ]);
        expect(runner.snapshot().output).toEqual(output);
        expect(runner.evidence()).toMatchObject({
          recordedEntries: 1,
          controlRecords: 5,
          controlErrors: 0,
          controlObserverFailures: 0,
          complete: true,
        });
      } finally {
        await runner.stop(100);
      }
    });
  });

  for (const [label, line] of [
    ['malformed JSON', 'DISRUNNER_HANDLER {private-malformed-payload}\n'],
    ['unknown reserved type', 'DISRUNNER_UNKNOWN {"private":"payload"}\n'],
    ['unknown fields', 'DISRUNNER_HANDLER {"id":"js-1-1","phase":"start","private":"payload"}\n'],
    ['duplicate fields', 'DISRUNNER_HANDLER {"id":"js-1-1","phase":null,"phase":"start"}\n'],
    ['invalid phase', 'DISRUNNER_HANDLER {"id":"js-1-1","phase":"private-phase"}\n'],
    ['invalid handler identity', 'DISRUNNER_HANDLER {"id":"private-id","phase":"start"}\n'],
    [
      'out-of-range process identity',
      'DISRUNNER_HANDLER {"id":"js-9999999999-1","phase":"start"}\n',
    ],
    [
      'out-of-range handler counter',
      'DISRUNNER_HANDLER {"id":"py-1-99999999999999999999","phase":"start"}\n',
    ],
    [
      'out-of-range raw snowflake',
      'DISRUNNER_HANDLER {"id":"raw-99999999999999999999","phase":"start"}\n',
    ],
    [
      'invalid diagnostic code',
      'DISRUNNER_DIAGNOSTIC {"code":"private-code","message":"private-message"}\n',
    ],
    ['empty diagnostic', 'DISRUNNER_DIAGNOSTIC {"code":"bot-error","message":""}\n'],
    ['ready payload', 'DISRUNNER_ADAPTER_READY private-payload\n'],
    ['unterminated frame', 'DISRUNNER_HANDLER {"id":"js-1-1","phase":"start"}'],
  ]) {
    it(`fails closed for ${label} without exposing raw control data`, async () => {
      await fixture(async (directory) => {
        const controls: BotProcessControl[] = [];
        const runner = new BotRunner({ onControl: (record) => controls.push(record) });
        try {
          await runChild(runner, directory, `process.stdout.write(${JSON.stringify(line)});`);
          expect(controls).toEqual([protocolError]);
          expect(runner.snapshot().output).toEqual([]);
          expect(runner.evidence()).toMatchObject({
            controlRecords: 0,
            controlErrors: 1,
            complete: false,
          });
          expect(JSON.stringify(controls)).not.toContain('private');
        } finally {
          await runner.stop(100);
        }
      });
    });
  }

  it('accepts CRLF and split control prefixes independently of a small human line budget', async () => {
    await fixture(async (directory) => {
      const controls: BotProcessControl[] = [];
      const runner = new BotRunner({
        maxOutputLineBytes: 4,
        onControl: (record) => controls.push(record),
      });
      try {
        await runChild(
          runner,
          directory,
          `process.stdout.write('DISRU', () => setTimeout(() => {
             process.stdout.write('NNER_ADAPTER_READY\\r\\nDISRUNNER_HANDLER {"id":"raw-123","phase":"start"}\\nDISRUNNER_HANDLER {"id":"raw-123","phase":"end"}\\n');
           }, 30));`,
        );
        expect(controls).toEqual([
          { kind: 'ready' },
          { kind: 'handler', id: 'raw-123', phase: 'start' },
          { kind: 'handler', id: 'raw-123', phase: 'end' },
        ]);
        expect(runner.evidence()).toMatchObject({
          controlRecords: 3,
          controlErrors: 0,
          complete: true,
        });
      } finally {
        await runner.stop(100);
      }
    });
  });

  it('rejects oversized controls before any partial frame reaches either callback', async () => {
    await fixture(async (directory) => {
      const controls: BotProcessControl[] = [];
      const output: BotProcessOutput[] = [];
      const runner = new BotRunner({
        onControl: (record) => controls.push(record),
        onOutput: (entry) => output.push(entry),
      });
      const first =
        'DISRUNNER_DIAGNOSTIC ' +
        JSON.stringify({ code: 'bot-error', message: 'private-'.repeat(600) });
      try {
        await runChild(
          runner,
          directory,
          `process.stdout.write(${JSON.stringify(first)}, () => setTimeout(() => process.stdout.write('\\nvisible\\n'), 30));`,
        );
        expect(controls).toEqual([protocolError]);
        expect(output.map(({ text }) => text)).toEqual(['visible\n']);
        const evidence = runner.evidence();
        expect(evidence).toMatchObject({
          controlRecords: 0,
          controlErrors: 1,
          truncatedLines: 1,
          complete: false,
        });
        expect(evidence.clippedBytes + evidence.discardedBytes).toBe(Buffer.byteLength(first) + 1);
      } finally {
        await runner.stop(100);
      }
    });
  });

  it('rejects reserved records on stderr', async () => {
    await fixture(async (directory) => {
      const controls: BotProcessControl[] = [];
      const runner = new BotRunner({ onControl: (record) => controls.push(record) });
      try {
        await runChild(runner, directory, "process.stderr.write('DISRUNNER_ADAPTER_READY\\n');");
        expect(controls).toEqual([protocolError]);
        expect(runner.snapshot().output).toEqual([]);
        expect(runner.evidence().complete).toBe(false);
      } finally {
        await runner.stop(100);
      }
    });
  });

  for (const [label, phases] of [
    ['duplicate start', ['start', 'start']],
    ['unknown end', ['end']],
  ] as const) {
    it(`rejects ${label} and latches a single protocol error`, async () => {
      await fixture(async (directory) => {
        const controls: BotProcessControl[] = [];
        const runner = new BotRunner({ onControl: (record) => controls.push(record) });
        try {
          await runChild(
            runner,
            directory,
            `for (const phase of ${JSON.stringify(phases)}) console.log('DISRUNNER_HANDLER ' + JSON.stringify({id: 'js-1-1', phase})); console.log('DISRUNNER_ADAPTER_READY');`,
          );
          expect(controls.filter(({ kind }) => kind === 'protocol-error')).toEqual([protocolError]);
          expect(controls.some(({ kind }) => kind === 'ready')).toBe(false);
          expect(runner.evidence()).toMatchObject({ controlErrors: 2, complete: false });
        } finally {
          await runner.stop(100);
        }
      });
    });
  }

  it('bounds active handler tracking and clears every control counter and identity on the next run', async () => {
    await fixture(async (directory) => {
      const controls: BotProcessControl[] = [];
      const runner = new BotRunner({ onControl: (record) => controls.push(record) });
      try {
        await runChild(
          runner,
          directory,
          `for (let index = 1; index <= 1001; index++) console.log('DISRUNNER_HANDLER ' + JSON.stringify({id: 'js-1-' + index, phase: 'start'}));`,
        );
        expect(controls).toHaveLength(1001);
        expect(controls.at(-1)).toEqual(protocolError);
        expect(runner.evidence()).toMatchObject({
          controlRecords: 1000,
          controlErrors: 1,
          complete: false,
        });
        controls.length = 0;
        await runChild(
          runner,
          directory,
          `for (const phase of ['start', 'end']) console.log('DISRUNNER_HANDLER ' + JSON.stringify({id: 'js-1-1', phase}));`,
        );
        expect(controls).toEqual([
          { kind: 'handler', id: 'js-1-1', phase: 'start' },
          { kind: 'handler', id: 'js-1-1', phase: 'end' },
        ]);
        expect(runner.evidence()).toMatchObject({
          controlRecords: 2,
          controlErrors: 0,
          controlObserverFailures: 0,
          complete: true,
        });
      } finally {
        await runner.stop(100);
      }
    });
  });

  it('isolates control observer exceptions and never reports complete capture afterward', async () => {
    await fixture(async (directory) => {
      const output: BotProcessOutput[] = [];
      const runner = new BotRunner({
        onControl() {
          throw new Error('private-observer-error');
        },
        onOutput: (entry) => output.push(entry),
      });
      try {
        await runChild(
          runner,
          directory,
          "console.log('DISRUNNER_ADAPTER_READY'); console.log('visible');",
        );
        expect(output.map(({ text }) => text)).toEqual([
          '[DisRunner] Control observer threw and was disabled.\n',
          'visible\n',
        ]);
        expect(JSON.stringify(output)).not.toContain('private-observer-error');
        expect(runner.evidence()).toMatchObject({
          controlRecords: 1,
          controlObserverFailures: 1,
          complete: false,
        });
      } finally {
        await runner.stop(100);
      }
    });
  });

  it('keeps the redacted legacy output contract when no control observer is configured', async () => {
    await fixture(async (directory, runner) => {
      const source =
        'DISRUNNER_HANDLER {"id":"js-1-1","phase":"start"}\nDISRUNNER_UNKNOWN private-line\n';
      await runChild(runner, directory, `process.stdout.write(${JSON.stringify(source)});`, {
        LOCAL_ACCESS_KEY: 'start',
      });
      expect(
        runner
          .snapshot()
          .output.map(({ text }) => text)
          .join(''),
      ).toBe(source.replace('start', '[REDACTED]'));
      expect(runner.evidence()).toMatchObject({
        controlRecords: 0,
        controlErrors: 0,
        controlObserverFailures: 0,
        complete: true,
      });
    });
  });
});
