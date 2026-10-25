import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  evaluateEvidence,
  botRssSummary,
  linuxListeners,
  linuxProcess,
  parseArguments,
  percentile,
  qualifyRuntime,
  rssSummary,
  THRESHOLDS,
} from '../../scripts/qualify-runtime.mjs';

const adapters = ['raw-interaction-webhook', 'discord.js', 'discord.py'];
function completeEvidence() {
  const rss = { maxBytes: 64 * 1_048_576, steadySamples: 100, steadyGrowthBytes: 0 };
  return {
    options: { cycles: 100, durationSeconds: 7200 },
    errors: [],
    cancelled: false,
    adapters: Object.fromEntries(
      adapters.map((adapter) => [
        adapter,
        {
          cycles: Array.from({ length: 100 }, () => ({})),
          startP95Ms: 100,
          pingP95Ms: 10,
          stopMaxMs: 100,
          rss: { ...rss },
        },
      ]),
    ),
    host: { rss: { ...rss } },
    soak: { elapsedSeconds: 7200 },
    cleanup: { returnedToBaseline: true },
    source: {
      start: { dirty: false, sha: 'a'.repeat(40) },
      end: { dirty: false, sha: 'a'.repeat(40) },
    },
    artifacts: { start: { sha256: 'b'.repeat(64) }, end: { sha256: 'b'.repeat(64) } },
  };
}

test('defaults require 100 cycles per adapter and a full two-hour soak', () => {
  const options = parseArguments([]);
  assert.equal(options.cycles, 100);
  assert.equal(options.durationSeconds, 7200);
  assert.equal(options.intervalSeconds, 30);
  for (const args of [
    ['--cycles', '0'],
    ['--cycles', '1.5'],
    ['--cycles', '-1'],
    ['--duration-seconds'],
    ['--interval-seconds', '61'],
    ['--cycles', '1', '--cycles', '2'],
    ['--unknown'],
    ['--duration-seconds', '86400', '--interval-seconds', '1'],
  ])
    assert.throws(() => parseArguments(args));
});

test('p95 uses observed nearest-rank values without hiding a tail sample', () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1).reverse();
  assert.equal(percentile(samples), 95);
  assert.equal(percentile([1, 100]), 100);
  assert.equal(samples[0], 100);
  assert.equal(percentile([]), null);
  assert.throws(() => percentile([NaN]));
});

test('RSS summaries compare early and late steady medians after initial warmup', () => {
  const samples = [10, 10, 100, 100, 120, 120, 120, 120].map((value, index) => ({
    elapsedSeconds: index,
    bytes: value,
  }));
  const summary = rssSummary(samples, 10, 'bytes');
  assert.equal(summary.steadySamples, 6);
  assert.equal(summary.firstSteadyMedianBytes, 100);
  assert.equal(summary.lastSteadyMedianBytes, 120);
  assert.equal(summary.steadyGrowthBytes, 20);
  assert.equal(summary.maxBytes, 120);
});

test('a process rotation cannot hide RSS growth in the previous Bot generation', () => {
  const samples = [100, 100, 100, 200, 200, 200, 10, 10, 10, 20, 20, 20].map(
    (botRssBytes, index) => ({ elapsedSeconds: index, generation: index < 6 ? 1 : 2, botRssBytes }),
  );
  const summary = botRssSummary(samples, 12);
  assert.equal(summary.generations.length, 2);
  assert.equal(summary.steadyGrowthBytes, 100);
});

test('short or incomplete coverage never becomes release qualification', () => {
  const full = completeEvidence();
  assert.equal(evaluateEvidence(full).qualified, true);
  const short = completeEvidence();
  short.options.durationSeconds = 2;
  assert.equal(evaluateEvidence(short).verdict, 'smoke-passed');
  assert.equal(evaluateEvidence(short).qualified, false);
  const incomplete = completeEvidence();
  incomplete.soak.elapsedSeconds = 7199;
  assert.equal(evaluateEvidence(incomplete).verdict, 'failed');
  incomplete.cancelled = true;
  assert.equal(evaluateEvidence(incomplete).verdict, 'cancelled');
});

test('dirty sources, changed build bytes, missing RSS and cleanup leaks block full qualification', () => {
  for (const mutate of [
    (value) => {
      value.source.end.dirty = true;
    },
    (value) => {
      value.source.end.sha = 'c'.repeat(40);
    },
    (value) => {
      value.artifacts.end.sha256 = 'c'.repeat(64);
    },
    (value) => {
      value.adapters['discord.py'].rss.maxBytes = null;
    },
    (value) => {
      value.host.rss.steadySamples = THRESHOLDS.minimumSteadySamples - 1;
    },
    (value) => {
      value.adapters['discord.js'].pingP95Ms = THRESHOLDS.pingP95Ms + 1;
    },
    (value) => {
      value.cleanup.returnedToBaseline = false;
    },
    (value) => {
      value.errors.push('Evidence was truncated');
    },
  ]) {
    const evidence = completeEvidence();
    mutate(evidence);
    assert.equal(evaluateEvidence(evidence).qualified, false);
    assert.equal(evaluateEvidence(evidence).verdict, 'failed');
  }
});

test(
  'qualification refuses to overwrite tracked source files before launching any work',
  { skip: process.platform !== 'linux' },
  async () => {
    const filename = fileURLToPath(new URL('../../package.json', import.meta.url));
    const before = await readFile(filename);
    await assert.rejects(
      qualifyRuntime(
        parseArguments(['--out', filename, '--cycles', '1', '--duration-seconds', '1']),
      ),
      /tracked source file/u,
    );
    assert.deepEqual(await readFile(filename), before);
  },
);

test(
  'Linux observations identify this process and an actual listener through kernel data',
  { skip: process.platform !== 'linux' },
  async () => {
    const processIdentity = await linuxProcess(process.pid);
    assert.equal(processIdentity.pid, process.pid);
    assert.match(processIdentity.startTicks, /^[0-9]+$/u);
    assert.ok(processIdentity.rssBytes > 0);
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    let identity;
    try {
      identity = (await linuxListeners()).find((listener) => listener.port === port);
      assert.ok(identity?.inode);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(
      (await linuxListeners()).some((listener) => listener.inode === identity.inode),
      false,
    );
  },
);
