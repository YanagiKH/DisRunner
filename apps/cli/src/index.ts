#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScenario, runScenario, sanitizeScenarioRunResult } from '@disrunner/core';
import {
  parseBotScenarioV2,
  runBotScenarioV2,
  renderBotScenarioV2Report,
  scenarioVersion,
  createReproductionBundle,
  type BotScenarioV2Result,
} from '@disrunner/runtime';
import { runBotTest } from './bot-test.js';
import { demoScenario } from './demo.js';
import { sanitizeOutputText, stringifyForExport } from './output.js';
import { createRecording, parseRecording, replayRecording } from './recording.js';
import { renderReport, type ReportFormat } from './reporters.js';

const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;

interface CliOptions {
  readonly command:
    | 'bot-test'
    | 'demo'
    | 'run'
    | 'test'
    | 'validate'
    | 'report'
    | 'record'
    | 'replay'
    | 'repro'
    | 'help';
  readonly file?: string;
  readonly format: ReportFormat;
  readonly formatSpecified: boolean;
  readonly output?: string;
  readonly seed?: number;
  readonly projectDirectory?: string;
  readonly timeoutMs?: number;
}

const formats = new Set<ReportFormat>(['json', 'html', 'junit', 'sarif']);

function usage(): string {
  return `DisRunner — deterministic offline Discord bot simulator

Usage:
  disrunner bot-test <case.json> --project <directory> [--out <result.json>] [--timeout-ms <integer>]
  disrunner demo [--format json|html|junit|sarif] [--out path]
  disrunner run <scenario.yml> [--seed number] [--format json|html|junit|sarif] [--out path]
  disrunner test [scenario.yml] [--seed number]
  disrunner validate <scenario.yml>
  disrunner report <scenario.yml> --format html|json|junit|sarif --out path [--seed number]
  disrunner record <scenario.yml> --out recording.json [--seed number]
  disrunner replay <recording.json> [--out verification.json]
  disrunner repro <scenario.yml> --out bundle.json

Version 1 scenarios use the virtual model. Version 2 runs the configured real Bot.
Assertion or replay mismatches exit 1; invalid input exits 2. Version 2 runtime
failures exit 3. Ctrl+C (SIGINT) exits 130 after cleanup; POSIX SIGTERM exits 143.
`;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [rawCommand = 'help', ...rest] = normalizedArgv;
  if (rawCommand === 'bot-test') return parseBotTestArgs(rest);
  if (rawCommand === 'repro') return parseReproArgs(rest);
  const allowed = new Set([
    'demo',
    'run',
    'test',
    'validate',
    'report',
    'record',
    'replay',
    'repro',
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

function parseReproArgs(argv: readonly string[]): CliOptions {
  const [file, flag, output, ...extra] = argv;
  if (!file || file.startsWith('-')) throw new Error('repro requires a version 2 scenario file');
  if (flag !== '--out' || !output || output.startsWith('-') || extra.length > 0)
    throw new Error('repro requires exactly one --out path and accepts no other options');
  assertDistinctPaths(file, output);
  return { command: 'repro', file, output, format: 'json', formatSpecified: false };
}

function parseBotTestArgs(argv: readonly string[]): CliOptions {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('-')) throw new Error('bot-test requires a case file');
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag !== '--project' && flag !== '--out' && flag !== '--timeout-ms') {
      throw new Error(`Unexpected bot-test argument: ${flag ?? ''}`);
    }
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    flags.set(flag, value);
  }
  const projectDirectory = flags.get('--project');
  if (projectDirectory === undefined) throw new Error('bot-test requires --project');
  const output = flags.get('--out');
  const rawTimeout = flags.get('--timeout-ms');
  const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (
    rawTimeout !== undefined &&
    (!/^[0-9]+$/u.test(rawTimeout) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs === undefined ||
      timeoutMs < 1 ||
      timeoutMs > 300_000)
  ) {
    throw new Error('--timeout-ms requires an integer from 1 to 300000');
  }
  if (output !== undefined) assertDistinctPaths(file, output);
  return {
    command: 'bot-test',
    file,
    projectDirectory,
    format: 'json',
    formatSpecified: false,
    ...(output === undefined ? {} : { output }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

async function runBotTestCommand(options: CliOptions): Promise<number> {
  const controller = new AbortController();
  let cancellationExitCode: 130 | 143 = 130;
  const cancel = (code: 130 | 143): void => {
    if (controller.signal.aborted) return;
    cancellationExitCode = code;
    controller.abort();
  };
  const interrupt = (): void => cancel(130);
  const terminate = (): void => cancel(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await runBotTest({
      casePath: requireFile(options),
      projectDirectory: options.projectDirectory ?? '',
      ...(options.output === undefined ? {} : { outPath: options.output }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal: controller.signal,
      // The module reads this after cancellation and cleanup have completed.
      get cancellationExitCode() {
        return cancellationExitCode;
      },
    });
    // The finalized report already contains redacted runtime issues. Preserve exact
    // observed assertion text and parity with the module-owned output file.
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return result.exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
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
      case 'bot-test':
        return await runBotTestCommand(options);
      case 'demo':
        return await runAndRender(demoScenario, options);
      case 'run':
        return await runAndRender(await readInputFile(requireFile(options)), options);
      case 'test':
        return await runTests(
          options.file === undefined ? demoScenario : await readInputFile(options.file),
          options,
        );
      case 'validate':
        return validateScenario(await readInputFile(requireFile(options)));
      case 'report': {
        const file = requireFile(options);
        const output = requireOutput(options);
        assertDistinctPaths(file, output);
        return await runAndRender(await readInputFile(file), options);
      }
      case 'repro': {
        const file = requireFile(options);
        const output = requireOutput(options);
        assertDistinctPaths(file, output);
        let outputIdentity: string;
        try {
          outputIdentity = await realpath(resolve(output));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          outputIdentity = resolve(output);
        }
        assertDistinctPaths(await realpath(resolve(file)), outputIdentity);
        const source = await readInputFile(file);
        const scenario = parseBotScenarioV2(source);
        const result = await runV2(source, options);
        let contents: string;
        try {
          const project = resolve(dirname(resolve(file)), scenario.execution.project);
          const projectRoot =
            basename(project) === 'discord-simulator.config.json' ? dirname(project) : project;
          const bundle = await createReproductionBundle(projectRoot, source, result);
          contents = `${JSON.stringify(bundle, null, 2)}\n`;
        } catch (error) {
          writeStderr(
            `Reproduction bundle could not be created: ${errorMessage(error, 'Export failed')}\n`,
          );
          return result.status === 'cancelled'
            ? result.exitCode
            : result.status === 'invalid'
              ? 2
              : 3;
        }
        try {
          // The runtime has already redacted and hashed this object. Preserve those bytes.
          await writeAtomicResult(output, contents);
          writeStdout(`Wrote ${resolve(output)}\n`);
        } catch (error) {
          writeStderr(
            `Reproduction bundle could not be saved: ${errorMessage(error, 'Output failed')}\n`,
          );
          return result.status === 'cancelled' ? result.exitCode : 3;
        }
        return result.exitCode;
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
  if (scenarioVersion(source) === 2) {
    const result = await runV2(source, options);
    try {
      await writeResult(options.output, renderBotScenarioV2Report(result, options.format));
    } catch (error) {
      writeStderr(`Report could not be saved: ${errorMessage(error, 'Output failed')}\n`);
      return result.status === 'cancelled' ? result.exitCode : 3;
    }
    return result.exitCode;
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
  if (scenarioVersion(source) === 2) {
    const result = await runV2(source, options);
    const passed = result.assertions.filter((assertion) => assertion.passed).length;
    writeStdout(
      `${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.name} — ${passed}/${result.assertions.length} assertions · real Bot\n`,
    );
    for (const assertion of result.assertions)
      writeStdout(
        `${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.description}: ${assertion.message}\n`,
      );
    for (const issue of [...result.issues, ...result.cleanupErrors])
      writeStderr(`${issue.code}: ${issue.message}\n`);
    return result.exitCode;
  }
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
  if (scenarioVersion(source) === 2) {
    const scenario = parseBotScenarioV2(source);
    writeStdout(`Valid Bot scenario v2: ${scenario.name}\n`);
    return 0;
  }
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
  await writeAtomicResult(outputPath, safeContents);
  writeStdout(`Wrote ${outputPath}\n`);
}

async function writeAtomicResult(output: string, contents: string): Promise<void> {
  const outputPath = resolve(output);
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, outputPath);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function runV2(source: string, options: CliOptions): Promise<BotScenarioV2Result> {
  if (options.seed !== undefined)
    throw new TypeError('Version 2 uses the project seed; --seed applies only to model scenarios.');
  const controller = new AbortController();
  let cancellationExitCode: 130 | 143 = 130;
  const interrupt = (): void => {
    cancellationExitCode = 130;
    controller.abort();
  };
  const terminate = (): void => {
    cancellationExitCode = 143;
    controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await runBotScenarioV2(source, {
      baseDirectory: dirname(resolve(requireFile(options))),
      signal: controller.signal,
      get cancellationExitCode() {
        return cancellationExitCode;
      },
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function validateCommandOptions(options: CliOptions): void {
  const requireScenarioFile = new Set<CliOptions['command']>([
    'run',
    'validate',
    'report',
    'record',
    'replay',
    'repro',
  ]);
  if (requireScenarioFile.has(options.command) && options.file === undefined) {
    throw new Error(`${options.command} requires an input file`);
  }
  if ((options.command === 'demo' || options.command === 'help') && options.file !== undefined) {
    throw new Error(`${options.command} does not accept an input file`);
  }
  if (
    (options.command === 'report' || options.command === 'record' || options.command === 'repro') &&
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
      options.command === 'repro' ||
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
      options.command === 'repro' ||
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
