import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism, cpus, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { linkDiscordJsFixture } from './sdk-fixture.mjs';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1_048_576;
const ADAPTERS = ['raw-interaction-webhook', 'discord.js', 'discord.py'];
const REQUIRED_CYCLES = 100;
const REQUIRED_SOAK_SECONDS = 7_200;
export const THRESHOLDS = Object.freeze({
  startP95Ms: 3_000,
  pingP95Ms: 250,
  stopMaxMs: 5_000,
  hostRssMaxBytes: 512 * MIB,
  hostSteadyGrowthMaxBytes: 128 * MIB,
  botRssMaxBytes: 256 * MIB,
  botSteadyGrowthMaxBytes: 64 * MIB,
  minimumSteadySamples: 30,
});

export function parseArguments(args) {
  const options = {
    durationSeconds: REQUIRED_SOAK_SECONDS,
    cycles: REQUIRED_CYCLES,
    intervalSeconds: 30,
    python: process.env.DISRUNNER_TEST_PYTHON ?? 'python3',
    out: path.resolve('runtime-qualification.json'),
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (
      !['--duration-seconds', '--cycles', '--interval-seconds', '--python', '--out'].includes(
        argument,
      ) ||
      seen.has(argument)
    )
      throw new TypeError(`Unknown or repeated argument: ${argument}`);
    seen.add(argument);
    const value = args[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError(`Missing value for ${argument}.`);
    if (argument === '--out') options.out = path.resolve(value);
    else if (argument === '--python') options.python = value;
    else {
      const maximum =
        argument === '--cycles' ? 1_000 : argument === '--interval-seconds' ? 60 : 86_400;
      if (
        !/^[1-9][0-9]*$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) > maximum
      )
        throw new RangeError(`${argument} must be an integer from 1 through ${maximum}.`);
      options[
        argument === '--cycles'
          ? 'cycles'
          : argument === '--interval-seconds'
            ? 'intervalSeconds'
            : 'durationSeconds'
      ] = Number(value);
    }
  }
  if (3 * (Math.ceil(options.durationSeconds / options.intervalSeconds) + 2) > 30_000)
    throw new RangeError(
      'Requested soak exceeds the 30,000 RSS sample limit. Increase the interval.',
    );
  return options;
}

export function percentile(values, probability = 0.95) {
  if (values.length === 0) return null;
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    probability <= 0 ||
    probability > 1
  )
    throw new TypeError(
      'Percentiles require finite nonnegative samples and a probability in (0,1].',
    );
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * probability) - 1];
}

export function rssSummary(samples, durationSeconds, valueKey = 'hostRssBytes') {
  const valid = samples.filter(
    (sample) => Number.isFinite(sample[valueKey]) && sample[valueKey] > 0,
  );
  const steady = valid.filter((sample) => sample.elapsedSeconds >= durationSeconds * 0.2);
  const window = Math.max(1, Math.floor(steady.length / 3));
  const first = steady.slice(0, window).map((sample) => sample[valueKey]);
  const last = steady.slice(-window).map((sample) => sample[valueKey]);
  const firstMedian = percentile(first, 0.5);
  const lastMedian = percentile(last, 0.5);
  return {
    samples: valid.length,
    steadySamples: steady.length,
    maxBytes: valid.length ? Math.max(...valid.map((sample) => sample[valueKey])) : null,
    firstSteadyMedianBytes: firstMedian,
    lastSteadyMedianBytes: lastMedian,
    steadyGrowthBytes:
      firstMedian === null || lastMedian === null ? null : Math.max(0, lastMedian - firstMedian),
  };
}

export function botRssSummary(samples, durationSeconds) {
  const groups = new Map();
  for (const sample of samples) {
    const group = groups.get(sample.generation) ?? [];
    group.push(sample);
    groups.set(sample.generation, group);
  }
  const generations = [...groups.entries()].map(([generation, group]) => {
    const first = group[0].elapsedSeconds;
    const lifetime = group.at(-1).elapsedSeconds - first;
    return {
      generation,
      elapsedSeconds: lifetime,
      ...rssSummary(
        group.map((sample) => ({ ...sample, elapsedSeconds: sample.elapsedSeconds - first })),
        lifetime,
        'botRssBytes',
      ),
    };
  });
  const measured = generations
    .map((group) => group.steadyGrowthBytes)
    .filter((value) => value !== null);
  return {
    ...rssSummary(samples, durationSeconds, 'botRssBytes'),
    steadyGrowthBytes: measured.length ? Math.max(...measured) : null,
    generations,
  };
}

/** Linux kernel process identity avoids mistaking a reused PID for a leaked Bot. */
export async function linuxProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const [rawStat, status] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
    ]);
    const fields = rawStat
      .slice(rawStat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    const rss = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
    return {
      pid,
      startTicks: fields[19],
      state: fields[0],
      rssBytes: rss ? Number(rss[1]) * 1024 : null,
    };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

/** Listener inode identity remains valid if another process later reuses the same port. */
export async function linuxListeners() {
  const rows = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((filename) => readFile(filename, 'utf8')),
  );
  return rows.flatMap((source) =>
    source
      .trim()
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        const fields = line.trim().split(/\s+/u);
        if (fields[3] !== '0A') return [];
        return [{ port: Number.parseInt(fields[1].split(':').at(-1), 16), inode: fields[9] }];
      }),
  );
}

async function ownedListeners(pids) {
  const inodes = new Set();
  for (const pid of pids) {
    let descriptors;
    try {
      descriptors = await readdir(`/proc/${pid}/fd`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const descriptor of descriptors) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
        const match = /^socket:\[([0-9]+)\]$/u.exec(target);
        if (match) inodes.add(match[1]);
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
    }
  }
  return (await linuxListeners()).filter((listener) => inodes.has(listener.inode));
}

async function processTree(pid) {
  const pending = [pid],
    result = [],
    seen = new Set();
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > 256)
      throw new Error('Bot process tree exceeds the 256-process observation limit.');
    const observed = await linuxProcess(next);
    if (observed === null) continue;
    result.push(observed);
    try {
      const children = (await readFile(`/proc/${next}/task/${next}/children`, 'utf8')).trim();
      if (children) pending.push(...children.split(/\s+/u).map(Number));
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return result;
}

function resourceCounts() {
  const counts = {};
  for (const resource of process.getActiveResourcesInfo())
    counts[resource] = (counts[resource] ?? 0) + 1;
  return counts;
}

function assertSnapshot(snapshot) {
  assert.equal(snapshot.phase, 'running', 'Bot left its running state.');
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.evidenceComplete, true, 'Runtime capture became incomplete.');
  assert.equal(snapshot.coreState?.evidenceComplete, true, 'State projection became incomplete.');
  assert.ok(snapshot.coreState.totalResources <= 1000, 'State capture reached its resource cap.');
  assert.equal(snapshot.commandsTruncated, false, 'Command registry projection was truncated.');
  assert.equal(snapshot.droppedOutput, 0, 'Runtime output was dropped.');
  assert.equal(snapshot.droppedTraces, 0, 'Runtime traces were dropped.');
  assert.equal(snapshot.droppedRisks, 0, 'Runtime risks were dropped.');
  assert.equal(snapshot.activeHandlers, 0, 'A runtime action remained active.');
  assert.equal(snapshot.diagnostics.length, 0, 'Runtime reported diagnostics.');
  assert.equal(snapshot.risks.length, 0, 'Runtime reported risks.');
  assert.ok(
    snapshot.commands.some((command) => command.name === 'ping'),
    'Actual Bot commands were not registered.',
  );
}

async function quiescentSnapshot(session, signal) {
  const deadline = performance.now() + 1_500;
  for (;;) {
    signal.throwIfAborted();
    const snapshot = session.snapshot();
    if (
      snapshot.activeHandlers === 0 &&
      snapshot.commands.some((command) => command.name === 'ping')
    )
      return snapshot;
    if (performance.now() >= deadline)
      throw new Error('Bot handlers or command registration did not become quiescent.');
    await delay(5, undefined, { signal });
  }
}

async function withDeadline(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds} ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupRecord(record, evidence) {
  const started = performance.now();
  const before = record.session.snapshot();
  const identities = [
    ...new Map(
      [...record.identities, ...(before.pid ? await processTree(before.pid) : [])].map(
        (identity) => [`${identity.pid}:${identity.startTicks}`, identity],
      ),
    ).values(),
  ];
  const listeners = [
    ...new Map(
      [
        ...record.listeners,
        ...(await ownedListeners(identities.map((identity) => identity.pid))),
      ].map((listener) => [listener.inode, listener]),
    ).values(),
  ];
  const stopped = await withDeadline(record.session.stop(), 10_000, 'Session stop');
  assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
  assert.equal(stopped.snapshot.pid, null);
  assert.equal(stopped.snapshot.endpoints, null);
  assert.equal(stopped.snapshot.activeHandlers, 0);
  const deadline = performance.now() + 1_000;
  let remainingProcesses = [],
    remainingListeners = [];
  do {
    remainingProcesses = [];
    for (const identity of identities) {
      const current = await linuxProcess(identity.pid);
      if (current?.startTicks === identity.startTicks)
        remainingProcesses.push({ pid: identity.pid, state: current.state });
    }
    const active = new Set((await linuxListeners()).map((listener) => listener.inode));
    remainingListeners = listeners.filter((listener) => active.has(listener.inode));
    if (!remainingProcesses.length && !remainingListeners.length) break;
    await delay(25);
  } while (performance.now() < deadline);
  assert.deepEqual(remainingProcesses, [], 'A Bot process survived cleanup.');
  assert.deepEqual(remainingListeners, [], 'A run-owned listener survived cleanup.');
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs <= THRESHOLDS.stopMaxMs, `Cleanup took ${elapsedMs.toFixed(1)} ms.`);
  record.started = null;
  record.identities = [];
  record.listeners = [];
  evidence.cleanupChecks++;
  return {
    elapsedMs,
    processesChecked: identities.length,
    listenersChecked: listeners.length,
    remainingProcesses: 0,
    remainingListeners: 0,
  };
}

async function startRecord(record, evidence, signal) {
  const existing = new Set((await ownedListeners([process.pid])).map((listener) => listener.inode));
  const start = performance.now();
  const snapshot = await record.session.start({ timeoutMs: 10_000, signal });
  await quiescentSnapshot(record.session, signal);
  const elapsedMs = performance.now() - start;
  record.started = snapshot;
  record.generation++;
  record.identities = await processTree(snapshot.pid);
  record.listeners = (
    await ownedListeners([process.pid, ...record.identities.map((identity) => identity.pid)])
  ).filter((listener) => !existing.has(listener.inode));
  assert.ok(record.identities.length >= 1, 'No supervised Bot process was observable.');
  const expectedPorts = Object.values(snapshot.endpoints).map((value) =>
    Number(new URL(value).port),
  );
  for (const port of expectedPorts)
    assert.ok(
      record.listeners.some((listener) => listener.port === port),
      'A runtime endpoint did not own its listener.',
    );
  assertSnapshot(record.session.snapshot());
  record.request = 0;
  evidence.adapters[record.adapter].starts++;
  return elapsedMs;
}

async function pingRecord(record, signal) {
  const started = performance.now();
  const result = await record.session.dispatch(
    {
      runId: record.started.runId,
      requestId: `qualify-${record.generation}-${++record.request}`,
      context: record.context,
      action: { type: 'command', name: 'ping' },
    },
    { signal, timeoutMs: 3_000 },
  );
  await quiescentSnapshot(record.session, signal);
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, result.error ?? 'Bot invocation failed.');
  assert.equal(result.response?.type, 'message');
  assert.equal(
    result.response.data.content,
    record.adapter === 'raw-interaction-webhook' ? 'Pong! Offline and deterministic.' : 'Pong!',
  );
  assertSnapshot(record.session.snapshot());
  return elapsedMs;
}

async function sourceIdentity(root, outputPath) {
  const [head, dirty] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10_000 }),
    execute('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      timeout: 10_000,
    }),
  ]);
  const excluded = path.relative(root, outputPath).split(path.sep).join('/');
  const changes = dirty.stdout
    .split('\0')
    .filter((entry) => entry.length > 0 && entry.slice(3) !== excluded);
  return {
    sha: head.stdout.trim(),
    dirty: changes.length !== 0,
    excludedEvidencePath: excluded.startsWith('../') ? null : excluded,
  };
}

export async function runtimeArtifacts(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (
        entry.isFile() &&
        /\.(?:js|mjs|cjs|py|json)$/u.test(entry.name) &&
        entry.name !== 'package.json'
      ) {
        if (entries.length >= 200)
          throw new Error('Built runtime artifact observation exceeded its file limit.');
        entries.push({
          path: path.relative(root, filename).split(path.sep).join('/'),
          sha256: createHash('sha256')
            .update(await readFile(filename))
            .digest('hex'),
        });
      }
    }
  }
  for (const directory of ['packages/core/dist', 'packages/runtime/dist'])
    await visit(path.join(root, directory));
  for (const [directory, names] of [
    [
      'packages/adapter-discordjs',
      ['index.mjs', 'bootstrap.cjs', 'handler-tracking.cjs', 'manifest.json'],
    ],
    ['packages/adapter-discordpy', ['index.mjs', 'bootstrap.py', 'manifest.json']],
  ]) {
    for (const name of names) {
      const filename = path.join(root, directory, name);
      const bytes = await readFile(filename);
      entries.push({
        path: `${directory}/${name}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return { entries, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

async function prepareProjects(directory, options, runtime) {
  const records = [];
  for (const adapter of ADAPTERS) {
    const folder =
      adapter === 'raw-interaction-webhook'
        ? 'raw-webhook-bot'
        : adapter === 'discord.js'
          ? 'discordjs-bot'
          : 'discordpy-bot';
    const source = path.join(repositoryRoot, 'examples', folder);
    const project = path.join(directory, folder);
    await cp(source, project, {
      recursive: true,
      filter: (filename) =>
        !['node_modules', 'tests', '.disrunner', '__pycache__', '.venv'].includes(
          path.basename(filename),
        ),
    });
    const configFile = path.join(project, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    if (adapter === 'discord.js')
      await linkDiscordJsFixture(source, path.join(project, config.bot.entryPoint));
    const executable = adapter === 'discord.py' ? options.python : process.execPath;
    config.bot.startCommand = `"${executable.replaceAll('"', '\\"')}" ${config.bot.entryPoint}`;
    await writeFile(configFile, JSON.stringify(config));
    const resolved = await runtime.loadProjectConfiguration(project);
    const actor = resolved.resources.find(
      (resource) => resource.resourceType === 'user' && resource.bot !== true,
    );
    const channel = resolved.resources.find(
      (resource) => resource.resourceType === 'channel' && resource.type === 0,
    );
    assert.ok(
      actor && channel,
      'Qualification fixture must provide a human actor and guild text channel.',
    );
    const session = runtime.createSession();
    await session.selectProject(project);
    records.push({
      adapter,
      project,
      session,
      context: { actorId: actor.id, guildId: channel.guild_id, channelId: channel.id },
      started: null,
      generation: 0,
      request: 0,
      identities: [],
      listeners: [],
    });
  }
  return records;
}

async function environmentVersions(options) {
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const jsManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages/adapter-discordjs/manifest.json'), 'utf8'),
  );
  const pyManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages/adapter-discordpy/manifest.json'), 'utf8'),
  );
  const actualJs = JSON.parse(
    await readFile(
      path.join(repositoryRoot, 'examples/discordjs-bot/node_modules/discord.js/package.json'),
      'utf8',
    ),
  ).version;
  const python = await execute(
    options.python,
    [
      '-c',
      'import discord, json, platform; print(json.dumps({"python": platform.python_version(), "discord.py": discord.__version__}))',
    ],
    { timeout: 10_000, maxBuffer: 4096 },
  );
  const actualPython = JSON.parse(python.stdout.trim());
  assert.equal(
    Number(process.versions.node.split('.')[0]),
    jsManifest.runtimeMajor,
    'Use the pinned Node runtime.',
  );
  assert.equal(actualJs, jsManifest.sdkVersion);
  assert.equal(actualPython['discord.py'], pyManifest.sdkVersion);
  assert.equal(
    actualPython.python.split('.').slice(0, 2).join('.'),
    `${pyManifest.runtimeMajor}.${pyManifest.runtimeMinor}`,
  );
  let memoryLimit = null;
  try {
    const value = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
    if (value !== 'max') memoryLimit = Number(value);
  } catch {
    /* Older hosts may not expose cgroup v2 memory limits. */
  }
  return {
    version: rootManifest.version,
    node: process.versions.node,
    python: actualPython.python,
    sdk: { 'discord.js': actualJs, 'discord.py': actualPython['discord.py'] },
    platform: process.platform,
    architecture: process.arch,
    kernelRelease: release(),
    cpuModel: cpus()[0]?.model ?? 'unavailable',
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    hostMemoryBytes: totalmem(),
    containerMemoryLimitBytes: memoryLimit,
  };
}

async function saveEvidence(filename, evidence) {
  const content = { ...evidence };
  delete content.integrity;
  const document = {
    ...content,
    integrity: {
      algorithm: 'sha256',
      scope: 'JSON.stringify(document without integrity)',
      sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    },
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 16 * MIB)
    throw new Error('Qualification evidence exceeds its 16 MiB limit.');
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function evaluateEvidence(evidence) {
  const failures = [...evidence.errors];
  const full =
    evidence.options.cycles >= REQUIRED_CYCLES &&
    evidence.options.durationSeconds >= REQUIRED_SOAK_SECONDS;
  for (const adapter of ADAPTERS) {
    const item = evidence.adapters[adapter];
    if (item.cycles.length !== evidence.options.cycles)
      failures.push(`${adapter}: lifecycle cycles are incomplete.`);
    if (item.startP95Ms === null || item.startP95Ms > THRESHOLDS.startP95Ms)
      failures.push(`${adapter}: startup p95 exceeded the threshold.`);
    if (item.pingP95Ms === null || item.pingP95Ms > THRESHOLDS.pingP95Ms)
      failures.push(`${adapter}: ping p95 exceeded the threshold.`);
    if (item.stopMaxMs === null || item.stopMaxMs > THRESHOLDS.stopMaxMs)
      failures.push(`${adapter}: cleanup exceeded the threshold.`);
    const rss = item.rss;
    if (rss.maxBytes === null || rss.maxBytes > THRESHOLDS.botRssMaxBytes)
      failures.push(`${adapter}: Bot RSS was unobserved or exceeded its ceiling.`);
    if (
      full &&
      (rss.steadySamples < THRESHOLDS.minimumSteadySamples ||
        rss.steadyGrowthBytes === null ||
        rss.steadyGrowthBytes > THRESHOLDS.botSteadyGrowthMaxBytes)
    )
      failures.push(`${adapter}: steady Bot RSS was unverified or exceeded its growth limit.`);
  }
  if (evidence.soak.elapsedSeconds < evidence.options.durationSeconds)
    failures.push('The requested soak duration did not complete.');
  if (
    evidence.host.rss.maxBytes === null ||
    evidence.host.rss.maxBytes > THRESHOLDS.hostRssMaxBytes
  )
    failures.push('Host RSS was unobserved or exceeded its ceiling.');
  if (
    full &&
    (evidence.host.rss.steadySamples < THRESHOLDS.minimumSteadySamples ||
      evidence.host.rss.steadyGrowthBytes === null ||
      evidence.host.rss.steadyGrowthBytes > THRESHOLDS.hostSteadyGrowthMaxBytes)
  )
    failures.push('Steady host RSS was unverified or exceeded its growth limit.');
  if (
    full &&
    (evidence.source.start?.dirty !== false ||
      evidence.source.end?.dirty !== false ||
      evidence.source.start?.sha !== evidence.source.end?.sha ||
      !evidence.artifacts.start ||
      evidence.artifacts.start.sha256 !== evidence.artifacts.end?.sha256)
  )
    failures.push(
      'Full qualification requires a clean, unchanged source commit and built runtime artifacts.',
    );
  if (!evidence.cleanup.returnedToBaseline)
    failures.push('Process/listener/resource cleanup did not return to baseline.');
  return {
    verdict: evidence.cancelled
      ? 'cancelled'
      : failures.length
        ? 'failed'
        : full
          ? 'passed'
          : 'smoke-passed',
    qualified: full && !evidence.cancelled && failures.length === 0,
    failures,
  };
}

export async function qualifyRuntime(options) {
  if (process.platform !== 'linux')
    throw new Error(
      'Runtime qualification currently requires Linux /proc process and listener evidence.',
    );
  const outputRelative = path.relative(repositoryRoot, options.out);
  if (!outputRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelative)) {
    const tracked = await execute('git', ['ls-files', '--', outputRelative], {
      cwd: repositoryRoot,
      timeout: 10_000,
    });
    if (tracked.stdout.trim())
      throw new Error('Qualification output must not overwrite a tracked source file.');
  }
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Qualification was cancelled.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let directory,
    records = [];
  const evidence = {
    schemaVersion: 1,
    kind: 'runtime-qualification',
    scope:
      'Shared runtime and three example Bot processes on this Linux host. Desktop rendering, installers, minimum OS certification and CPU utilization are outside this measurement.',
    startedAt: new Date().toISOString(),
    completedAt: null,
    state: 'in-progress',
    options: {
      durationSeconds: options.durationSeconds,
      cycles: options.cycles,
      intervalSeconds: options.intervalSeconds,
    },
    thresholds: THRESHOLDS,
    requirements: { cyclesPerAdapter: REQUIRED_CYCLES, soakDurationSeconds: REQUIRED_SOAK_SECONDS },
    environment: null,
    source: { start: null, end: null },
    artifacts: { start: null, end: null },
    workload: {
      order: ADAPTERS,
      traffic:
        'One real /ping per adapter per interval, sequentially; all three independent sessions remain alive during soak.',
      rotations:
        'Restart a session before 700 resources, 700 retained traces or 600 requests; record every rotation and fail on any dropped/incomplete evidence.',
    },
    adapters: Object.fromEntries(
      ADAPTERS.map((adapter) => [
        adapter,
        {
          starts: 0,
          cycles: [],
          startP95Ms: null,
          pingP95Ms: null,
          stopMaxMs: null,
          rss: null,
          rotations: [],
          samples: [],
        },
      ]),
    ),
    host: { samples: [], rss: null },
    soak: { elapsedSeconds: 0, completedRounds: 0 },
    cleanupChecks: 0,
    cleanup: {
      baselineListeners: [],
      finalListeners: [],
      baselineResources: {},
      finalResources: {},
      returnedToBaseline: false,
    },
    errors: [],
    cancelled: false,
    verdict: null,
    qualified: false,
  };
  const pings = Object.fromEntries(ADAPTERS.map((adapter) => [adapter, []]));
  const starts = Object.fromEntries(ADAPTERS.map((adapter) => [adapter, []]));
  const stops = Object.fromEntries(ADAPTERS.map((adapter) => [adapter, []]));
  try {
    evidence.source.start = await sourceIdentity(repositoryRoot, options.out);
    evidence.artifacts.start = await runtimeArtifacts(repositoryRoot);
    evidence.environment = await environmentVersions(options);
    const runtime = await import('../packages/runtime/dist/index.js');
    directory = await mkdtemp(path.join(tmpdir(), 'DisRunner qualification '));
    records = await prepareProjects(directory, options, runtime);
    process.stdout.write('');
    process.stderr.write('');
    await delay(100);
    evidence.cleanup.baselineListeners = await ownedListeners([process.pid]);
    evidence.cleanup.baselineResources = resourceCounts();
    for (const record of records) {
      await startRecord(record, evidence, cancellation.signal);
      await pingRecord(record, cancellation.signal);
      await cleanupRecord(record, evidence);
    }
    for (let cycle = 0; cycle < options.cycles; cycle++) {
      cancellation.signal.throwIfAborted();
      for (const record of records) {
        const startupMs = await startRecord(record, evidence, cancellation.signal);
        const pingMs = await pingRecord(record, cancellation.signal);
        const cleanup = await cleanupRecord(record, evidence);
        starts[record.adapter].push(startupMs);
        pings[record.adapter].push(pingMs);
        stops[record.adapter].push(cleanup.elapsedMs);
        evidence.adapters[record.adapter].cycles.push({
          cycle: cycle + 1,
          startupMs,
          pingMs,
          cleanup,
        });
      }
      if ((cycle + 1) % 10 === 0 || cycle + 1 === options.cycles) {
        process.stdout.write(
          `Lifecycle qualification: ${cycle + 1}/${options.cycles} cycles per adapter.\n`,
        );
        await saveEvidence(options.out, evidence);
      }
    }
    for (const record of records)
      starts[record.adapter].push(await startRecord(record, evidence, cancellation.signal));
    const soakStart = performance.now();
    let nextRound = soakStart,
      lastCheckpoint = soakStart;
    for (;;) {
      cancellation.signal.throwIfAborted();
      const elapsedSeconds = (performance.now() - soakStart) / 1000;
      evidence.host.samples.push({
        elapsedSeconds,
        hostRssBytes: process.memoryUsage().rss,
        activeResources: resourceCounts(),
      });
      for (const record of records) {
        const snapshot = record.session.snapshot();
        assertSnapshot(snapshot);
        if (
          snapshot.coreState.totalResources >= 700 ||
          snapshot.traces.length >= 700 ||
          record.request >= 600
        ) {
          const cleanup = await cleanupRecord(record, evidence);
          stops[record.adapter].push(cleanup.elapsedMs);
          starts[record.adapter].push(await startRecord(record, evidence, cancellation.signal));
          evidence.adapters[record.adapter].rotations.push({
            elapsedSeconds,
            reason: 'Preemptive bounded capture reset',
          });
        }
        const pingMs = await pingRecord(record, cancellation.signal);
        pings[record.adapter].push(pingMs);
        const observed = await linuxProcess(record.started.pid);
        assert.ok(observed?.rssBytes, 'Bot RSS was unavailable.');
        const current = record.session.snapshot();
        evidence.adapters[record.adapter].samples.push({
          elapsedSeconds,
          generation: record.generation,
          pid: observed.pid,
          startTicks: observed.startTicks,
          botRssBytes: observed.rssBytes,
          pingMs,
          resources: current.coreState.totalResources,
          retainedTraces: current.traces.length,
          activeHandlers: current.activeHandlers,
          projectedResources: current.coreState.resources.length,
        });
      }
      evidence.soak.completedRounds++;
      evidence.soak.elapsedSeconds = (performance.now() - soakStart) / 1000;
      if (performance.now() - lastCheckpoint >= 60_000) {
        process.stdout.write(
          `Runtime soak: ${Math.floor(evidence.soak.elapsedSeconds)}/${options.durationSeconds} seconds.\n`,
        );
        await saveEvidence(options.out, evidence);
        lastCheckpoint = performance.now();
      }
      if (evidence.soak.elapsedSeconds >= options.durationSeconds) break;
      nextRound += options.intervalSeconds * 1000;
      const waitMs = Math.min(
        nextRound - performance.now(),
        options.durationSeconds * 1000 - (performance.now() - soakStart),
      );
      if (waitMs > 0) await delay(waitMs, undefined, { signal: cancellation.signal });
    }
  } catch (error) {
    evidence.cancelled = cancellation.signal.aborted;
    evidence.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    for (const record of records) {
      try {
        if (record.started !== null || record.session.snapshot().pid !== null) {
          const cleanup = await cleanupRecord(record, evidence);
          stops[record.adapter].push(cleanup.elapsedMs);
        }
        const disposed = await withDeadline(record.session.dispose(), 10_000, 'Session disposal');
        assert.equal(disposed.ok, true, JSON.stringify(disposed.errors));
      } catch (error) {
        evidence.errors.push(`${record.adapter} cleanup: ${error.message}`);
        await forceOwnedChildren(record.identities);
      }
    }
    await delay(100);
    try {
      evidence.cleanup.finalListeners = await ownedListeners([process.pid]);
      evidence.cleanup.finalResources = resourceCounts();
      const baseline = new Set(
        evidence.cleanup.baselineListeners.map((listener) => listener.inode),
      );
      const unexpectedListeners = evidence.cleanup.finalListeners.filter(
        (listener) => !baseline.has(listener.inode),
      );
      const resources = ['TCPServerWrap', 'ProcessWrap', 'PipeWrap'];
      evidence.cleanup.returnedToBaseline =
        unexpectedListeners.length === 0 &&
        resources.every(
          (resource) =>
            (evidence.cleanup.finalResources[resource] ?? 0) <=
            (evidence.cleanup.baselineResources[resource] ?? 0),
        );
      evidence.source.end = await sourceIdentity(repositoryRoot, options.out);
      evidence.artifacts.end = await runtimeArtifacts(repositoryRoot);
    } catch (error) {
      evidence.errors.push(`Final observation failed: ${error.message}`);
    }
    for (const adapter of ADAPTERS) {
      const item = evidence.adapters[adapter];
      item.startP95Ms = percentile(starts[adapter]);
      item.pingP95Ms = percentile(pings[adapter]);
      item.stopMaxMs = stops[adapter].length ? Math.max(...stops[adapter]) : null;
      item.rss = botRssSummary(item.samples, options.durationSeconds);
    }
    evidence.host.rss = rssSummary(evidence.host.samples, options.durationSeconds);
    evidence.state = 'completed';
    evidence.completedAt = new Date().toISOString();
    Object.assign(evidence, evaluateEvidence(evidence));
    try {
      await saveEvidence(options.out, evidence);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
      }
    }
  }
  return evidence;
}

async function forceOwnedChildren(identities) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const identity of [...identities].reverse()) {
      const current = await linuxProcess(identity.pid);
      if (current?.startTicks === identity.startTicks)
        try {
          process.kill(identity.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
    }
    await delay(200);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/qualify-runtime.mjs [--duration-seconds 7200] [--cycles 100] [--interval-seconds 30] [--python python3] [--out evidence.json]\nShort runs produce smoke evidence, not release qualification. Full qualification requires a clean unchanged checkout, prebuilt runtime and installed pinned SDK dependencies.\n',
    );
    return;
  }
  const evidence = await qualifyRuntime(options);
  process.stdout.write(`Runtime qualification: ${evidence.verdict}. Evidence: ${options.out}\n`);
  for (const failure of evidence.failures) process.stderr.write(`${failure}\n`);
  process.exitCode =
    evidence.verdict === 'cancelled'
      ? 130
      : ['passed', 'smoke-passed'].includes(evidence.verdict)
        ? 0
        : 1;
  if (process.exitCode !== 0 && !evidence.cleanup.returnedToBaseline)
    process.exit(process.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`Runtime qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
