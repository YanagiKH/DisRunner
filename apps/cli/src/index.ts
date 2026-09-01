#!/usr/bin/env node
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScenario, runScenario, sanitizeScenarioRunResult } from '@disrunner/core';
import { demoScenario } from './demo.js';
import { sanitizeOutputText, stringifyForExport } from './output.js';
import { createRecording, parseRecording, replayRecording } from './recording.js';
import { renderReport, type ReportFormat } from './reporters.js';

const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;

interface CliOptions {
  readonly command: 'demo' | 'run' | 'test' | 'validate' | 'report' | 'record' | 'replay' | 'help';
  readonly file?: string;
  readonly format: ReportFormat;
  readonly formatSpecified: boolean;
  readonly output?: string;
  readonly seed?: number;
}

const formats = new Set<ReportFormat>(['json', 'html', 'junit', 'sarif']);

function usage(): string {
  return `DisRunner — deterministic offline Discord bot simulator

Usage:
  disrunner demo [--format json|html|junit|sarif] [--out path]
  disrunner run <scenario.yml> [--seed number] [--format json|html|junit|sarif] [--out path]
  disrunner test [scenario.yml] [--seed number]
  disrunner validate <scenario.yml>
  disrunner report <scenario.yml> --format html|json|junit|sarif --out path [--seed number]
  disrunner record <scenario.yml> --out recording.json [--seed number]
  disrunner replay <recording.json> [--out verification.json]

All simulation commands run offline. Assertion or replay mismatches exit with code 1;
invalid arguments, files, scenarios, or recording formats exit with code 2.
`;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [rawCommand = 'help', ...rest] = normalizedArgv;
  const allowed = new Set([
    'demo',
    'run',
    'test',
    'validate',
    'report',
    'record',
    'replay',
    'help',
  ]);
  if (!allowed.has(rawCommand)) throw new Error(`Unknown command: ${rawCommand}`);
  const command = rawCommand as CliOptions['command'];
  let file: string | undefined;
  let output: string | undefined;
  let format: ReportFormat = 'json';
  let formatSpecified = false;
  let seed: number | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--format') {
      const next = rest[index + 1];
      if (!next || !formats.has(next as ReportFormat)) {
        throw new Error(`Unsupported format: ${next ?? ''}`);
      }
      format = next as ReportFormat;
      formatSpecified = true;
      index += 1;
    } else if (value === '--out') {
      output = rest[index + 1];
      if (!output) throw new Error('--out requires a path');
      index += 1;
    } else if (value === '--seed') {
      const rawSeed = rest[index + 1];
      if (rawSeed === undefined || rawSeed === '') {
        throw new Error('--seed requires a safe integer');
      }
      const next = Number(rawSeed);
      if (!Number.isSafeInteger(next)) throw new Error('--seed requires a safe integer');
      seed = next;
      index += 1;
    } else if (value?.startsWith('-')) {
      throw new Error(`Unknown option: ${value}`);
    } else if (!file && value) {
      file = value;
    } else {
      throw new Error(`Unexpected argument: ${value ?? ''}`);
    }
  }

  const options: CliOptions = {
    command,
    format,
    formatSpecified,
    ...(file ? { file } : {}),
    ...(output ? { output } : {}),
    ...(seed === undefined ? {} : { seed }),
  };
  validateCommandOptions(options);
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeStderr(`${errorMessage(error, 'Invalid arguments')}\n\n${usage()}`);
    return 2;
  }

  if (options.command === 'help') {
    writeStdout(usage());
    return 0;
  }

  try {
    switch (options.command) {
      case 'demo':
        return runAndRender(demoScenario, options);
      case 'run':
        return runAndRender(await readInputFile(requireFile(options)), options);
      case 'test':
        return runTests(
          options.file === undefined ? demoScenario : await readInputFile(options.file),
          options,
        );
      case 'validate':
        return validateScenario(await readInputFile(requireFile(options)));
      case 'report': {
        const file = requireFile(options);
        const output = requireOutput(options);
        assertDistinctPaths(file, output);
        return runAndRender(await readInputFile(file), options);
      }
      case 'record': {
        const file = requireFile(options);
        const output = requireOutput(options);
        assertDistinctPaths(file, output);
        const recording = await createRecording(
          await readInputFile(file),
          options.seed === undefined ? {} : { seed: options.seed },
        );
        await writeResult(output, stringifyForExport(recording));
        return recording.trace.report.passed ? 0 : 1;
      }
      case 'replay': {
        const file = requireFile(options);
        if (options.output !== undefined) assertDistinctPaths(file, options.output);
        const recording = parseRecording(await readInputFile(file));
        const verification = await replayRecording(recording);
        await writeResult(options.output, stringifyForExport(verification));
        return verification.passed ? 0 : 1;
      }
    }
  } catch (error) {
    writeStderr(`DisRunner failed: ${errorMessage(error, 'Unknown error')}\n`);
    return 2;
  }
  return 2;
}

async function runAndRender(source: string, options: CliOptions): Promise<number> {
  if (options.file !== undefined && options.output !== undefined) {
    assertDistinctPaths(options.file, options.output);
  }
  const result = sanitizeScenarioRunResult(
    await runScenario(
      source,
      options.seed === undefined ? {} : { profile: { seed: options.seed } },
    ),
  );
  await writeResult(options.output, renderReport(options.format, result));
  return result.report.passed ? 0 : 1;
}

async function runTests(source: string, options: CliOptions): Promise<number> {
  const scenario = parseScenario(source);
  const result = sanitizeScenarioRunResult(
    await runScenario(
      scenario,
      options.seed === undefined ? {} : { profile: { seed: options.seed } },
    ),
  );
  const passedCount = result.assertions.filter((assertion) => assertion.passed).length;
  const lines = [
    `${result.report.passed ? 'PASS' : 'FAIL'} ${scenario.name} — ${String(passedCount)}/${String(result.assertions.length)} assertions`,
    ...result.assertions.map(
      (assertion) =>
        `${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.description ?? assertion.type}: ${assertion.message}`,
    ),
  ];
  writeStdout(`${lines.join('\n')}\n`);
  return result.report.passed ? 0 : 1;
}

function validateScenario(source: string): number {
  const scenario = parseScenario(source);
  writeStdout(`Valid scenario: ${scenario.name}\n`);
  return 0;
}

async function readInputFile(file: string): Promise<string> {
  const inputPath = resolve(file);
  const handle = await open(inputPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new TypeError(`Input is not a regular file: ${inputPath}`);
    if (stats.size > MAX_INPUT_BYTES) {
      throw new RangeError(`Input exceeds the ${String(MAX_INPUT_BYTES)} byte limit.`);
    }
    const contents = await handle.readFile();
    if (contents.length > MAX_INPUT_BYTES) {
      throw new RangeError(`Input exceeds the ${String(MAX_INPUT_BYTES)} byte limit.`);
    }
    return contents.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function writeResult(output: string | undefined, contents: string): Promise<void> {
  const safeContents = sanitizeOutputText(contents);
  if (output === undefined) {
    writeStdout(safeContents);
    return;
  }
  const outputPath = resolve(output);
  await writeFile(outputPath, safeContents, { encoding: 'utf8', flag: 'w' });
  writeStdout(`Wrote ${outputPath}\n`);
}

function validateCommandOptions(options: CliOptions): void {
  const requireScenarioFile = new Set<CliOptions['command']>([
    'run',
    'validate',
    'report',
    'record',
    'replay',
  ]);
  if (requireScenarioFile.has(options.command) && options.file === undefined) {
    throw new Error(`${options.command} requires an input file`);
  }
  if ((options.command === 'demo' || options.command === 'help') && options.file !== undefined) {
    throw new Error(`${options.command} does not accept an input file`);
  }
  if (
    (options.command === 'report' || options.command === 'record') &&
    options.output === undefined
  ) {
    throw new Error(`${options.command} requires --out`);
  }
  if (options.command === 'report' && !options.formatSpecified) {
    throw new Error('report requires --format');
  }
  if (
    (options.command === 'test' ||
      options.command === 'validate' ||
      options.command === 'record' ||
      options.command === 'replay' ||
      options.command === 'help') &&
    options.formatSpecified
  ) {
    throw new Error(`${options.command} does not accept --format`);
  }
  if (
    (options.command === 'test' || options.command === 'validate' || options.command === 'help') &&
    options.output !== undefined
  ) {
    throw new Error(`${options.command} does not accept --out`);
  }
  if (
    (options.command === 'demo' ||
      options.command === 'validate' ||
      options.command === 'replay' ||
      options.command === 'help') &&
    options.seed !== undefined
  ) {
    throw new Error(`${options.command} does not accept --seed`);
  }
}

function requireFile(options: CliOptions): string {
  if (options.file === undefined) throw new Error(`${options.command} requires an input file`);
  return options.file;
}

function requireOutput(options: CliOptions): string {
  if (options.output === undefined) throw new Error(`${options.command} requires --out`);
  return options.output;
}

function assertDistinctPaths(input: string, output: string): void {
  const normalize = (value: string) => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  if (normalize(input) === normalize(output)) {
    throw new Error('Input and output paths must be different.');
  }
}

function writeStdout(value: string): void {
  process.stdout.write(sanitizeOutputText(value));
}

function writeStderr(value: string): void {
  process.stderr.write(sanitizeOutputText(value));
}

function errorMessage(error: unknown, fallback: string): string {
  return sanitizeOutputText(error instanceof Error ? error.message : fallback);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
