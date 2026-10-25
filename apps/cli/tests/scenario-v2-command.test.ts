import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseReproductionBundle } from '@disrunner/runtime';
import { parseArgs } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/bot-test/', import.meta.url));
const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const directories: string[] = [];
beforeAll(() => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  execFileSync(
    process.execPath,
    [join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'apps/cli/tsconfig.build.json'],
    { cwd: repository, stdio: 'pipe' },
  );
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'disrunner-v2-cli-'));
  directories.push(directory);
  await cp(fixtures, directory, { recursive: true });
  const configPath = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    environment: Record<string, string>;
  };
  config.environment['DISRUNNER_TEST_MODE'] = mode;
  config.environment['DISRUNNER_TEST_TRACE'] = join(directory, 'child.jsonl');
  await writeFile(configPath, JSON.stringify(config));
  const source = {
    version: 2,
    name: 'CLI real ping',
    execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10000 },
    context: { actor: '3000', guild: '1000', channel: '2000' },
    steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 250 }],
    assertions: [
      {
        type: 'message-content',
        interaction: '${ping.id}',
        equals: 'Pong! Offline and deterministic.',
      },
    ],
  };
  const scenarioPath = join(directory, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(source));
  return { directory, scenarioPath, source };
}
function launch(args: string[]) {
  const child = spawn(process.execPath, [executable, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, result };
}

describe('version 2 CLI process contract', () => {
  it.each(['validate', 'run', 'test', 'report'])(
    'preserves bounded v1 YAML aliases for %s',
    async (command) => {
      const directory = await mkdtemp(join(tmpdir(), 'disrunner-v1-alias-cli-'));
      directories.push(directory);
      const filename = join(directory, 'aliases.yml');
      await writeFile(
        filename,
        'version: 1\nname: Alias compatibility\nsteps:\n  - &step {action: advance-time, ms: 1}\n  - *step\nassertions: []\n',
      );
      const result = await launch([
        command,
        filename,
        ...(command === 'report'
          ? ['--format', 'json', '--out', join(directory, 'report.json')]
          : []),
      ]).result;
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    },
  );
  it.each([
    ['repro'],
    ['repro', 'case.json'],
    ['repro', 'case.json', '--out'],
    ['repro', 'case.json', '--out', '--seed'],
    ['repro', 'case.json', '--out', 'result.json', '--format', 'json'],
    ['repro', 'case.json', '--out', 'result.json', '--seed', '42'],
    ['repro', 'case.json', '--out', 'one.json', '--out', 'two.json'],
    ['repro', 'case.json', '--out', 'case.json'],
  ])('rejects invalid repro arguments %j', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
  it('exports a validated diagnostic bundle with redacted secrets, paths and input identity', async () => {
    const { directory, scenarioPath, source } = await project();
    const secret = 'project-private-value-for-repro';
    source.name = `Local ${secret}`;
    await writeFile(scenarioPath, JSON.stringify(source));
    const configPath = join(directory, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      environment: Record<string, string>;
    };
    config.environment['CUSTOM_PROJECT_PASSWORD'] = secret;
    await writeFile(configPath, JSON.stringify(config));
    const output = join(directory, 'diagnostic-bundle.json');
    const result = await launch(['repro', scenarioPath, '--out', output]).result;
    expect(result.code).toBe(0);
    const contents = await readFile(output, 'utf8');
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(directory);
    const bundle = parseReproductionBundle(contents);
    expect(bundle).toMatchObject({
      version: 1,
      kind: 'bot-rerun',
      replayable: false,
      requiresOriginalProject: true,
      report: { status: 'passed', exitCode: 0 },
      manifest: { fixtureCapture: 'run-verified-at-export', redacted: true },
    });
    expect(bundle.integrity.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(bundle.manifest.sourceHashes).toHaveLength(1);
    expect(bundle.manifest.sourceHashes[0]).toMatchObject({ path: 'server.mjs', matchesRun: true });
    expect(bundle.manifest.sourceHashes[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const tampered = JSON.parse(contents) as { report: { status: string } };
    tampered.report.status = 'failed';
    expect(() => parseReproductionBundle(tampered)).toThrow(/digest|integrity/u);
  }, 15000);

  it('keeps a wrong real reply as exit 1 when a bundle is exported', async () => {
    const { directory, scenarioPath } = await project('wrong-safe');
    const output = join(directory, 'failed-bundle.json');
    const result = await launch(['repro', scenarioPath, '--out', output]).result;
    expect(result.code).toBe(1);
    expect(parseReproductionBundle(await readFile(output, 'utf8')).report).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
  }, 15000);

  it('exports a passing expected-error case without undefined report fields', async () => {
    const { directory, scenarioPath, source } = await project('pong-only');
    await writeFile(
      scenarioPath,
      JSON.stringify({
        ...source,
        assertions: [{ type: 'error', request: 'ping', code: 'timeout' }],
        policy: { failOnSeverity: 'none' },
      }),
    );
    const output = join(directory, 'expected-error-bundle.json');
    const result = await launch(['repro', scenarioPath, '--out', output]).result;
    expect(result.code).toBe(0);
    const bundle = parseReproductionBundle(await readFile(output, 'utf8'));
    expect(bundle.report).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(bundle.report['assertions']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          passed: true,
          expected: { code: 'timeout' },
        }),
      ]),
    );
  }, 15000);

  it('reports bundle output failure as exit 3 after cleaning the real Bot', async () => {
    const { directory, scenarioPath } = await project();
    const output = join(directory, 'missing-directory', 'bundle.json');
    const result = await launch(['repro', scenarioPath, '--out', output]).result;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Reproduction bundle could not be saved');
    expect(result.stdout).not.toContain('Wrote');
    const events = (await readFile(join(directory, 'child.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.some((event) => event.event === 'exit')).toBe(true);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);

  it('rejects model repro input before starting or overwriting the source', async () => {
    const { directory, scenarioPath } = await project();
    const source = JSON.stringify({ version: 1, name: 'model', steps: [] });
    await writeFile(scenarioPath, source);
    const result = await launch(['repro', scenarioPath, '--out', join(directory, 'bundle.json')])
      .result;
    expect(result.code).toBe(2);
    expect(await readFile(scenarioPath, 'utf8')).toBe(source);
    await expect(readFile(join(directory, 'child.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('validates without launching and resolves a project relative to the scenario', async () => {
    const { directory, scenarioPath } = await project();
    const validated = await launch(['validate', scenarioPath]).result;
    expect(validated.code).toBe(0);
    await expect(readFile(join(directory, 'child.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const result = await launch(['run', scenarioPath]).result;
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      execution: string;
      status: string;
      metadata: { replay: string };
    };
    expect(report).toMatchObject({
      execution: 'bot',
      status: 'passed',
      metadata: { replay: 'bot-rerun' },
    });
    expect(result.stderr).toBe('');
  }, 15000);

  it.each([
    ['wrong-safe', 1, 'failed'],
    ['pong-only', 1, 'failed'],
    ['early-crash', 3, 'runner-error'],
  ])(
    'classifies %s as exit %s',
    async (mode, code, status) => {
      const { scenarioPath } = await project(String(mode));
      const result = await launch(['run', scenarioPath]).result;
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout)).toMatchObject({ status, exitCode: code });
    },
    15000,
  );

  it('rejects unasserted scenarios before starting a process', async () => {
    const { directory, scenarioPath, source } = await project();
    source.assertions = [];
    await writeFile(scenarioPath, JSON.stringify(source));
    const result = await launch(['test', scenarioPath]).result;
    expect(result.code).toBe(2);
    await expect(readFile(join(directory, 'child.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes each report format through the shared Bot runner', async () => {
    const { directory, scenarioPath } = await project();
    for (const format of ['json', 'junit', 'html', 'sarif']) {
      const output = join(directory, `report.${format}`);
      const result = await launch(['report', scenarioPath, '--format', format, '--out', output])
        .result;
      expect(result.code).toBe(0);
      const contents = await readFile(output, 'utf8');
      if (format === 'json')
        expect(JSON.parse(contents)).toMatchObject({ status: 'passed', execution: 'bot' });
      else if (format === 'sarif')
        expect(JSON.parse(contents)).toMatchObject({
          version: '2.1.0',
          runs: [{ invocations: [{ executionSuccessful: true, exitCode: 0 }] }],
        });
      else if (format === 'junit') expect(contents).toContain('failures="0" errors="0"');
      else expect(contents).toContain('PASSED');
    }
  }, 25000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM cancels and cleans up the real Bot before exit 143',
    async () => {
      const { directory, scenarioPath, source } = await project();
      const changed = {
        ...source,
        steps: [...source.steps, { action: 'await-message', content: 'never', timeoutMs: 10000 }],
      };
      await writeFile(scenarioPath, JSON.stringify(changed));
      const running = launch(['run', scenarioPath]);
      let pid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const trace = await readFile(join(directory, 'child.jsonl'), 'utf8');
          const events = trace
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; pid: number });
          if (events.some((event) => event.event === 'command')) {
            pid = events[0]?.pid;
            break;
          }
        } catch {
          /* The child has not created its trace yet. */
        }
        await delay(25);
      }
      expect(pid).toBeDefined();
      running.child.kill('SIGTERM');
      const result = await running.result;
      expect(result.code).toBe(143);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'cancelled',
        exitCode: 143,
        cleanupErrors: [],
      });
      expect(() => process.kill(pid!, 0)).toThrow();
    },
    15000,
  );
});
