import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'disrunner-cli-boundary-'));
  directories.push(directory);
  const file = join(directory, 'scenario.json');
  await writeFile(file, source);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { directory, file, stderr };
}

function argumentsFor(command: string, file: string, directory: string) {
  return command === 'report'
    ? [command, file, '--format', 'json', '--out', join(directory, 'report.json')]
    : [command, file];
}

describe('CLI asynchronous error boundary', () => {
  it.each(['run', 'test', 'report'])(
    '%s resolves invalid scenarios as exit 2, without rejecting',
    async (command) => {
      const { directory, file, stderr } = await fixture(
        '{"name":"invalid","steps":[],"actions":[]}',
      );
      await expect(main(argumentsFor(command, file, directory))).resolves.toBe(2);
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toBe(
        'DisRunner failed: Scenario must contain exactly one of steps or actions.\n',
      );
    },
  );

  it.each(['run', 'test', 'report'])('%s preserves successful exit 0', async (command) => {
    const { directory, file, stderr } = await fixture('{"name":"valid","steps":[]}');
    await expect(main(argumentsFor(command, file, directory))).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(['run', 'test', 'report'])('%s preserves failed-assertion exit 1', async (command) => {
    const { directory, file, stderr } = await fixture(
      JSON.stringify({
        name: 'failed assertion',
        steps: [],
        assertions: [{ type: 'risk-present', ruleId: 'NEVER_PRESENT' }],
      }),
    );
    await expect(main(argumentsFor(command, file, directory))).resolves.toBe(1);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('catches and sanitizes asynchronous demo output failures', async () => {
    const { directory, stderr } = await fixture('{"name":"unused","steps":[]}');
    const output = join(directory, 'BOT_TOKEN=not-a-real-sensitive-token', 'report.json');
    await expect(main(['demo', '--out', output])).resolves.toBe(2);
    const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(text).toContain('DisRunner failed:');
    expect(text).not.toContain('not-a-real-sensitive-token');
    expect(text).not.toContain('\n    at ');
  });
});
