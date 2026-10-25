import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateEvidence, THRESHOLDS } from '../../scripts/qualify-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapters = ['raw-interaction-webhook', 'discord.js', 'discord.py'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/u;

/** Reproduce the qualification harness's complete runtime/adapter artifact manifest. */
export async function runtimeArtifactSnapshot(root) {
  const entries = [];
  let totalBytes = 0;
  const add = async (filename) => {
    const info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Runtime artifact must be a regular file.');
    assert.ok(info.size <= 16 * 1_048_576, 'Runtime artifact exceeded the file size limit.');
    totalBytes += info.size;
    assert.ok(totalBytes <= 64 * 1_048_576, 'Runtime artifacts exceeded the total size limit.');
    assert.ok(entries.length < 208, 'Too many runtime artifacts.');
    entries.push({
      path: path.relative(root, filename).split(path.sep).join('/'),
      sha256: hash(await readFile(filename)),
    });
  };
  const visit = async (directory) => {
    assert.ok((await lstat(directory)).isDirectory(), 'Runtime artifact directory is missing.');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Runtime artifacts must not contain symbolic links.');
      if (entry.isDirectory()) await visit(filename);
      else if (
        entry.isFile() &&
        /\.(?:js|mjs|cjs|py|json)$/u.test(entry.name) &&
        entry.name !== 'package.json'
      )
        await add(filename);
    }
  };
  for (const directory of ['packages/core/dist', 'packages/runtime/dist']) {
    const filename = path.join(root, directory);
    assert.equal(await realpath(filename), filename, 'Runtime artifact directory must be local.');
    await visit(filename);
  }
  for (const [directory, names] of [
    [
      'packages/adapter-discordjs',
      ['index.mjs', 'bootstrap.cjs', 'handler-tracking.cjs', 'manifest.json'],
    ],
    ['packages/adapter-discordpy', ['index.mjs', 'bootstrap.py', 'manifest.json']],
  ]) {
    const filename = path.join(root, directory);
    assert.equal(await realpath(filename), filename, 'Adapter directory must be local.');
    for (const name of names) await add(path.join(filename, name));
  }
  assert.ok(entries.length > 0, 'Runtime artifact manifest is empty.');
  return { entries, sha256: hash(JSON.stringify(entries)) };
}

export async function verifyRuntimeQualification(
  filename,
  { mode, sha, version, root = repositoryRoot },
) {
  assert.ok(['full', 'smoke'].includes(mode), 'Qualification mode must be full or smoke.');
  assert.match(sha, /^[a-f0-9]{40}$/u, 'Expected source commit must be a full Git SHA.');
  assert.ok(typeof version === 'string' && version.length > 0, 'Expected version is required.');
  const info = await lstat(filename);
  assert.ok(info.isFile() && info.size <= 16 * 1_048_576, 'Invalid qualification receipt size.');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  const { integrity, ...content } = document;
  assert.equal(integrity?.algorithm, 'sha256', 'Missing qualification integrity algorithm.');
  assert.equal(integrity?.scope, 'JSON.stringify(document without integrity)');
  assert.match(integrity?.sha256 ?? '', digestPattern, 'Invalid qualification integrity digest.');
  assert.equal(
    hash(JSON.stringify(content)),
    integrity.sha256,
    'Qualification integrity mismatch.',
  );
  assert.equal(content.schemaVersion, 1);
  assert.equal(content.kind, 'runtime-qualification');
  assert.equal(content.state, 'completed', 'Qualification has not completed.');
  assert.equal(content.cancelled, false, 'Cancelled qualification cannot pass.');
  assert.deepEqual(content.errors, [], 'Qualification reported runtime errors.');
  assert.deepEqual(content.failures, [], 'Qualification reported failures.');
  assert.equal(content.environment?.version, version, 'Qualification version differs.');
  assert.equal(content.environment?.platform, 'linux');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version, 'Checkout version differs.');
  assert.equal(content.environment?.node, '22.23.2');
  assert.equal(content.environment?.python, '3.12.14');
  assert.deepEqual(content.environment?.sdk, { 'discord.js': '14.27.0', 'discord.py': '2.6.4' });
  for (const observation of [content.source?.start, content.source?.end]) {
    assert.equal(observation?.sha, sha, 'Qualification source differs from the required commit.');
    assert.equal(observation?.dirty, false, 'Qualification source was not clean.');
  }
  assert.deepEqual(content.thresholds, THRESHOLDS, 'Qualification thresholds differ.');
  assert.deepEqual(content.requirements, { cyclesPerAdapter: 100, soakDurationSeconds: 7200 });
  assert.ok(Number.isSafeInteger(content.options?.cycles));
  assert.ok(Number.isSafeInteger(content.options?.durationSeconds));
  assert.ok(Number.isSafeInteger(content.options?.intervalSeconds));
  assert.ok(content.options.intervalSeconds >= 1 && content.options.intervalSeconds <= 60);
  assert.equal(content.verdict, mode === 'full' ? 'passed' : 'smoke-passed');
  assert.equal(content.qualified, mode === 'full');
  if (mode === 'full') {
    assert.ok(content.options.cycles >= 100 && content.options.durationSeconds >= 7200);
  } else {
    assert.equal(content.options.cycles, 3);
    assert.equal(content.options.durationSeconds, 15);
  }
  assert.deepEqual(Object.keys(content.adapters ?? {}).sort(), [...adapters].sort());
  for (const adapter of adapters) {
    const item = content.adapters[adapter];
    assert.ok(Array.isArray(item.cycles) && item.cycles.length === content.options.cycles);
    for (const value of [item.startP95Ms, item.pingP95Ms, item.stopMaxMs, item.rss?.maxBytes])
      assert.ok(Number.isFinite(value) && value > 0, 'Qualification metrics must be observed.');
  }
  assert.ok(Number.isFinite(content.host?.rss?.maxBytes) && content.host.rss.maxBytes > 0);
  assert.ok(Number.isFinite(content.soak?.elapsedSeconds));
  const evaluated = evaluateEvidence(content);
  assert.deepEqual(evaluated, {
    verdict: mode === 'full' ? 'passed' : 'smoke-passed',
    qualified: mode === 'full',
    failures: [],
  });
  const observed = await runtimeArtifactSnapshot(root);
  for (const artifact of [content.artifacts?.start, content.artifacts?.end]) {
    assert.ok(Array.isArray(artifact?.entries) && artifact.entries.length <= 208);
    assert.match(artifact?.sha256 ?? '', digestPattern);
    assert.equal(hash(JSON.stringify(artifact.entries)), artifact.sha256);
    assert.deepEqual(artifact, observed, 'Qualified runtime bytes differ from the checkout build.');
  }
  return document;
}

async function main() {
  const [filename, ...args] = process.argv.slice(2);
  const options = {};
  assert.ok(
    filename && args.length === 6,
    'Expected receipt --mode MODE --sha SHA --version VERSION.',
  );
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/u, '');
    assert.ok(['mode', 'sha', 'version'].includes(key) && !Object.hasOwn(options, key));
    options[key] = args[index + 1];
  }
  await verifyRuntimeQualification(filename, options);
  console.log(`Verified ${options.mode} runtime qualification for ${options.sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(`Runtime qualification validation failed: ${error.message}`);
    process.exitCode = 1;
  });
