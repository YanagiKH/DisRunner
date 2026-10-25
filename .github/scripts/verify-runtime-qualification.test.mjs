import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runtimeArtifacts, THRESHOLDS } from '../../scripts/qualify-runtime.mjs';
import {
  runtimeArtifactSnapshot,
  readBoundedRegularFile,
  verifyRuntimeQualification,
} from './verify-runtime-qualification.mjs';

const sha = 'a'.repeat(40);
const version = '1.0.0';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, mode = 'full') {
  const root = await mkdtemp(path.join(tmpdir(), 'qualification-validator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  for (const directory of ['core/dist', 'runtime/dist', 'adapter-discordjs', 'adapter-discordpy'])
    await mkdir(path.join(root, 'packages', directory), { recursive: true });
  await writeFile(path.join(root, 'packages/core/dist/index.js'), 'export const core = 1;\n');
  await writeFile(path.join(root, 'packages/runtime/dist/index.js'), 'export const runtime = 1;\n');
  await writeFile(path.join(root, 'packages/adapter-discordjs/bootstrap.cjs'), '// JS bootstrap\n');
  await writeFile(
    path.join(root, 'packages/adapter-discordjs/handler-tracking.cjs'),
    'module.exports = { tracker: true };\n',
  );
  await writeFile(
    path.join(root, 'packages/adapter-discordpy/bootstrap.py'),
    '# Python bootstrap\n',
  );
  for (const adapter of ['adapter-discordjs', 'adapter-discordpy']) {
    await writeFile(
      path.join(root, 'packages', adapter, 'index.mjs'),
      'export const adapter = 1;\n',
    );
    await writeFile(path.join(root, 'packages', adapter, 'manifest.json'), '{}\n');
  }
  const artifact = await runtimeArtifactSnapshot(root);
  const cycles = mode === 'full' ? 100 : 3;
  const durationSeconds = mode === 'full' ? 7200 : 15;
  const rss = { maxBytes: 64 * 1_048_576, steadySamples: 100, steadyGrowthBytes: 0 };
  const document = {
    schemaVersion: 1,
    kind: 'runtime-qualification',
    state: 'completed',
    environment: {
      version,
      platform: 'linux',
      node: '22.23.2',
      python: '3.12.14',
      sdk: { 'discord.js': '14.27.0', 'discord.py': '2.6.4' },
    },
    source: { start: { sha, dirty: false }, end: { sha, dirty: false } },
    artifacts: { start: structuredClone(artifact), end: structuredClone(artifact) },
    options: { cycles, durationSeconds, intervalSeconds: 30 },
    thresholds: THRESHOLDS,
    requirements: { cyclesPerAdapter: 100, soakDurationSeconds: 7200 },
    adapters: Object.fromEntries(
      ['raw-interaction-webhook', 'discord.js', 'discord.py'].map((adapter) => [
        adapter,
        {
          cycles: Array.from({ length: cycles }, () => ({})),
          startP95Ms: 100,
          pingP95Ms: 10,
          stopMaxMs: 100,
          rss: structuredClone(rss),
        },
      ]),
    ),
    host: { rss: structuredClone(rss) },
    soak: { elapsedSeconds: durationSeconds },
    cleanup: { returnedToBaseline: true },
    cancelled: false,
    errors: [],
    failures: [],
    qualified: mode === 'full',
    verdict: mode === 'full' ? 'passed' : 'smoke-passed',
  };
  const filename = path.join(root, 'receipt.json');
  const save = async (value = document) => {
    const content = { ...value };
    delete content.integrity;
    await writeFile(
      filename,
      JSON.stringify({
        ...content,
        integrity: {
          algorithm: 'sha256',
          scope: 'JSON.stringify(document without integrity)',
          sha256: hash(JSON.stringify(content)),
        },
      }),
    );
  };
  await save();
  const verify = (requiredMode = mode) =>
    verifyRuntimeQualification(filename, { root, mode: requiredMode, sha, version });
  return { root, document, filename, save, verify };
}

test('accepts full qualification only when source, version and complete built artifact hashes agree', async (t) => {
  const { verify } = await fixture(t);
  assert.equal((await verify()).qualified, true);
});

test('PR smoke remains unqualified and cannot satisfy the canonical release gate', async (t) => {
  const { verify } = await fixture(t, 'smoke');
  assert.equal((await verify()).verdict, 'smoke-passed');
  await assert.rejects(verify('full'));
});

test('rejects resealed identity, threshold, completion and coverage failures', async (t) => {
  const { document, save, verify } = await fixture(t);
  for (const mutate of [
    (value) => {
      value.source.end.sha = 'b'.repeat(40);
    },
    (value) => {
      value.source.start.dirty = true;
    },
    (value) => {
      value.environment.version = '0.1.0';
    },
    (value) => {
      value.state = 'in-progress';
    },
    (value) => {
      value.thresholds.pingP95Ms = 10000;
    },
    (value) => {
      value.options.durationSeconds = 7199;
    },
    (value) => {
      value.adapters['discord.py'].cycles.pop();
    },
    (value) => {
      value.host.rss.steadySamples = 1;
    },
    (value) => {
      value.cleanup.returnedToBaseline = false;
    },
    (value) => {
      value.errors.push('Runtime observation failed');
    },
  ]) {
    const changed = structuredClone(document);
    mutate(changed);
    await save(changed);
    await assert.rejects(verify());
  }
});

test('rejects receipt tampering and changed runtime bytes', async (t) => {
  const { root, filename, save, verify } = await fixture(t);
  const tampered = JSON.parse(await readFile(filename, 'utf8'));
  tampered.source.end.dirty = true;
  await writeFile(filename, JSON.stringify(tampered));
  await assert.rejects(verify(), /integrity mismatch/u);
  await save();
  await writeFile(path.join(root, 'packages/runtime/dist/index.js'), 'export const runtime = 2;\n');
  await assert.rejects(verify(), /runtime bytes differ/u);
});

test('an internally consistent but incomplete runtime manifest cannot conceal a built file', async (t) => {
  const { document, save, verify } = await fixture(t);
  for (const artifact of [document.artifacts.start, document.artifacts.end]) {
    artifact.entries.pop();
    artifact.sha256 = hash(JSON.stringify(artifact.entries));
  }
  await save();
  await assert.rejects(verify(), /runtime bytes differ/u);
});

test('runtime artifact symlinks are rejected instead of hashing outside the checkout', async (t) => {
  const { root, verify } = await fixture(t);
  const target = path.join(root, 'packages/runtime/dist/index.js');
  await rm(target);
  await symlink(path.join(root, 'package.json'), target);
  await assert.rejects(verify(), /symbolic links/u);
});

test('measurement and independent validation both include the required handler tracking bytes', async (t) => {
  const { root, document, verify } = await fixture(t);
  const measured = await runtimeArtifacts(root);
  assert.deepEqual(measured, document.artifacts.start);
  assert.ok(
    measured.entries.some(
      (entry) => entry.path === 'packages/adapter-discordjs/handler-tracking.cjs',
    ),
  );
  await writeFile(
    path.join(root, 'packages/adapter-discordjs/handler-tracking.cjs'),
    'module.exports = { tracker: false };\n',
  );
  assert.notEqual((await runtimeArtifacts(root)).sha256, measured.sha256);
  await assert.rejects(verify(), /runtime bytes differ/u);
});

test('a resealed receipt cannot omit handler tracking and missing required adapter files fail closed', async (t) => {
  const { root, document, save, verify } = await fixture(t);
  for (const artifact of [document.artifacts.start, document.artifacts.end]) {
    artifact.entries = artifact.entries.filter(
      (entry) => entry.path !== 'packages/adapter-discordjs/handler-tracking.cjs',
    );
    artifact.sha256 = hash(JSON.stringify(artifact.entries));
  }
  await save();
  await assert.rejects(verify(), /runtime bytes differ/u);
  await rm(path.join(root, 'packages/adapter-discordjs/handler-tracking.cjs'));
  await assert.rejects(runtimeArtifacts(root), { code: 'ENOENT' });
  await assert.rejects(verify(), { code: 'ENOENT' });
});

test('a pathname replaced after descriptor checking never supplies replacement bytes', async (t) => {
  const { root } = await fixture(t);
  const filename = path.join(root, 'descriptor-input');
  await writeFile(filename, 'original');
  const probe = await open(filename, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const stat = prototype.stat;
  const checked = [];
  t.mock.method(prototype, 'stat', async function (...args) {
    const result = await Reflect.apply(stat, this, args);
    if (checked.length === 0) {
      checked.push(this);
      await rename(filename, `${filename}.old`);
      await writeFile(filename, 'replacement'.repeat(1000));
    }
    return result;
  });
  await assert.rejects(readBoundedRegularFile(filename, 16), /changed|replaced/u);
  assert.equal(checked[0].fd, -1, 'The checked descriptor is closed even when the path changes.');
});

test('growth after fstat is bounded to the checked size plus one byte and closes the descriptor', async (t) => {
  const { root } = await fixture(t);
  const filename = path.join(root, 'growing-input');
  await writeFile(filename, 'original');
  const probe = await open(filename, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const stat = prototype.stat;
  const read = prototype.read;
  const checked = [];
  let requested = 0;
  t.mock.method(prototype, 'stat', async function (...args) {
    const result = await Reflect.apply(stat, this, args);
    if (checked.length === 0) {
      checked.push(this);
      await appendFile(filename, 'growth'.repeat(10_000));
    }
    return result;
  });
  t.mock.method(prototype, 'read', function (...args) {
    requested += args[2];
    return Reflect.apply(read, this, args);
  });
  await assert.rejects(readBoundedRegularFile(filename, 16), /changed/u);
  assert.ok(requested <= 9, 'A growing file cannot cause reads beyond the checked size plus one.');
  assert.equal(checked[0].fd, -1);
});

test('receipt and required adapter leaves reject symbolic links and nonregular files', async (t) => {
  const { root, filename, verify } = await fixture(t);
  const moved = `${filename}.original`;
  await rename(filename, moved);
  await symlink(moved, filename);
  await assert.rejects(verify());
  await rm(filename);
  await mkdir(filename);
  await assert.rejects(verify(), /regular file/u);
  const adapter = path.join(root, 'packages/adapter-discordjs/handler-tracking.cjs');
  await rm(adapter);
  await symlink(path.join(root, 'package.json'), adapter);
  await assert.rejects(runtimeArtifactSnapshot(root));
});

test(
  'FIFO input is rejected without waiting for a writer',
  { skip: process.platform !== 'linux', timeout: 1000 },
  async (t) => {
    const { root } = await fixture(t);
    const filename = path.join(root, 'fifo-input');
    execFileSync('mkfifo', [filename]);
    await assert.rejects(readBoundedRegularFile(filename, 16), /regular file/u);
  },
);

test('receipt and artifact reads preserve the 16 MiB per-file ceiling', async (t) => {
  const { root, filename, verify } = await fixture(t);
  await truncate(filename, 16 * 1_048_576 + 1);
  await assert.rejects(verify(), /byte limit/u);
  const artifact = path.join(root, 'packages/runtime/dist/index.js');
  await truncate(artifact, 16 * 1_048_576 + 1);
  await assert.rejects(runtimeArtifactSnapshot(root), /byte limit/u);
});

test('the artifact tree preserves its 64 MiB total byte ceiling', async (t) => {
  const { root } = await fixture(t);
  for (let index = 0; index < 4; index++) {
    const filename = path.join(root, `packages/core/dist/large-${index}.js`);
    await writeFile(filename, '');
    await truncate(filename, 16 * 1_048_576);
  }
  await assert.rejects(runtimeArtifactSnapshot(root), /byte limit|total size limit/u);
});

test('malformed and incomplete receipt documents cannot enter qualification', async (t) => {
  const { filename, verify } = await fixture(t);
  for (const content of ['{', 'null', '[]', '{}']) {
    await writeFile(filename, content);
    await assert.rejects(verify());
  }
});
