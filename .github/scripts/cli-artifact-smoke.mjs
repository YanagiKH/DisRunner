import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const archive = path.resolve(process.argv[2] ?? '');
assert.match(path.basename(archive), /^disrunner-cli-[0-9][A-Za-z0-9.-]*\.tar\.gz$/u);
const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner 離線 CLI '));
try {
  execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'pipe' });
  const entries = await readdir(directory);
  assert.equal(entries.length, 1);
  const bundle = path.join(directory, entries[0]);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  for (const [relative, digest] of Object.entries(manifest.files)) {
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.split('/').includes('..'), false);
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(bundle, relative)))
        .digest('hex'),
      digest,
      relative,
    );
  }
  for (const adapter of ['adapter-discordjs', 'adapter-discordpy']) {
    const { bootstrapPath } = await import(
      pathToFileURL(path.join(bundle, 'node_modules', '@disrunner', adapter, 'index.mjs')).href
    );
    const relative = path.relative(bundle, bootstrapPath);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith('..'), false);
    assert.ok((await readFile(bootstrapPath)).byteLength > 0);
  }
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      /TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTHORIZATION|NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE/iu.test(
        name,
      )
    )
      delete environment[name];
  }
  const invoke = (args) =>
    execFileSync(process.execPath, [path.join(bundle, 'disrunner.mjs'), ...args], {
      cwd: bundle,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    });
  assert.match(invoke(['help']), /Usage:/u);
  const model = JSON.parse(invoke(['demo', '--format', 'json']));
  assert.equal(model.report.passed, true);
  assert.ok(model.assertions.length > 0);
  const bot = JSON.parse(
    invoke(['bot-test', 'examples/ping.bot-case.json', '--project', 'examples/raw-webhook-bot']),
  );
  assert.equal(bot.status, 'passed');
  assert.equal(bot.assertions.length, 1);
  assert.equal(bot.assertions[0].actual.data.content, 'Pong! Offline and deterministic.');
  console.log(
    `Verified extracted CLI ${manifest.version}: file hashes, model run, real local bot, and cleanup.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
