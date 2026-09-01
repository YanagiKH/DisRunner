import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/index.js';
import { createRecording, parseRecording, replayRecording } from '../src/recording.js';
import { stringifyForExport } from '../src/output.js';

const scenarioSource = `
version: 1
name: recording-smoke
description: BOT_TOKEN=not-a-real-but-sensitive-token
seed: 77
steps:
  - type: gateway-dispatch
    event: MESSAGE_CREATE
    data:
      session_id: local-session
      token: should-never-be-exported
assertions:
  - type: event-received
    event: MESSAGE_CREATE
    count: 1
`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('recording and replay', () => {
  it('accepts the package-manager argument separator used by documented root commands', () => {
    expect(parseArgs(['--', 'validate', 'scenario.yml'])).toMatchObject({
      command: 'validate',
      file: 'scenario.yml',
    });
  });

  it('writes a sanitized replayable envelope and reproduces state and events', async () => {
    const recording = await createRecording(scenarioSource);
    expect(recording.trace.assertions).toHaveLength(1);
    expect(recording.trace.report.assertions).toEqual(recording.trace.assertions);
    expect(recording.trace.report.assertions).not.toBe(recording.trace.assertions);
    const serialized = stringifyForExport(recording);
    expect(serialized).toContain('dev.disrunner.recording');
    expect(serialized).not.toContain('not-a-real-but-sensitive-token');
    expect(serialized).not.toContain('should-never-be-exported');

    const parsed = parseRecording(serialized);
    expect(parsed.trace.assertions).toHaveLength(1);
    expect(parsed.trace.report.assertions).toEqual(parsed.trace.assertions);
    const verification = await replayRecording(parsed);
    expect(verification.executed).toBe(true);
    expect(verification.reproduced).toBe(true);
    expect(verification.passed).toBe(true);
    expect(verification.checks.find((check) => check.name === 'events-exact')?.passed).toBe(true);
  });

  it('fails closed before execution when recorded evidence is modified', async () => {
    const recording = await createRecording(scenarioSource);
    const parsed = JSON.parse(stringifyForExport(recording)) as unknown as {
      trace: { events: { t: string }[] };
    };
    parsed.trace.events[0]!.t = 'TAMPERED';

    const verification = await replayRecording(parseRecording(JSON.stringify(parsed)));
    expect(verification.executed).toBe(false);
    expect(verification.reproduced).toBe(false);
    expect(verification.checks.find((check) => check.name === 'events-integrity')?.passed).toBe(
      false,
    );
  });

  it('uses distinct command semantics for validate, test, record, and replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disrunner-cli-'));
    temporaryDirectories.push(directory);
    const scenarioPath = join(directory, 'scenario.yml');
    const failingPath = join(directory, 'failing.yml');
    const recordingPath = join(directory, 'recording.json');
    const verificationPath = join(directory, 'verification.json');
    await writeFile(scenarioPath, scenarioSource, 'utf8');
    await writeFile(
      failingPath,
      'version: 1\nname: expected-failure\nsteps: []\nassertions:\n  - type: risk-present\n    ruleId: NEVER_PRESENT\n',
      'utf8',
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main(['validate', failingPath])).toBe(0);
    expect(await main(['test', failingPath])).toBe(1);
    expect(await main(['record', scenarioPath, '--out', recordingPath])).toBe(0);
    expect(await main(['replay', recordingPath, '--out', verificationPath])).toBe(0);

    const recording = JSON.parse(await readFile(recordingPath, 'utf8')) as unknown as {
      kind: string;
    };
    const verification = JSON.parse(await readFile(verificationPath, 'utf8')) as unknown as {
      kind: string;
      reproduced: boolean;
    };
    expect(recording.kind).toBe('dev.disrunner.recording');
    expect(verification).toMatchObject({
      kind: 'dev.disrunner.replay-verification',
      reproduced: true,
    });
  });

  it('rejects command flags that would blur command responsibilities', () => {
    expect(() => parseArgs(['report', 'scenario.yml', '--out', 'report.json'])).toThrow(
      'report requires --format',
    );
    expect(() => parseArgs(['record', 'scenario.yml'])).toThrow('record requires --out');
    expect(() => parseArgs(['replay', 'recording.json', '--seed', '1'])).toThrow(
      'replay does not accept --seed',
    );
    expect(() => parseArgs(['validate', 'scenario.yml', '--format', 'json'])).toThrow(
      'validate does not accept --format',
    );
  });
});
