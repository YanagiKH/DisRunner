import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { linkDiscordJsFixture } from '../../scripts/sdk-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function run(adapter, entry, changes) {
  const javascript = adapter === 'discord.js';
  const command = javascript ? process.execPath : (process.env.DISRUNNER_TEST_PYTHON ?? 'python3');
  const bootstrap = path.join(
    root,
    'packages',
    javascript ? 'adapter-discordjs/bootstrap.cjs' : 'adapter-discordpy/bootstrap.py',
  );
  const child = spawn(command, [bootstrap, entry], {
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      DISRUNNER_OFFLINE: '1',
      DISRUNNER_FAKE_TOKEN: 'disrunner.offline.adapter-boundary_0123456789',
      DISCORD_API_BASE_URL: 'http://127.0.0.1:51923/api/v10',
      DISCORD_GATEWAY_URL: 'ws://127.0.0.1:51924/gateway',
      ...changes,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stdout = '';
  child.stdout.on('data', (bytes) => {
    const text = bytes.toString();
    output += text;
    stdout += text;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes.toString();
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code] = await once(child, 'exit');
    return { code, output, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

for (const adapter of ['discord.js', 'discord.py']) {
  test(`${adapter}: adapter rejects external endpoints and non-synthetic credentials before loading a Bot`, async () => {
    const entry = path.join(tmpdir(), 'does-not-run-disrunner-bot');
    for (const changes of [
      { DISRUNNER_OFFLINE: '0' },
      { DISRUNNER_FAKE_TOKEN: 'production-credential-is-not-accepted' },
      { DISCORD_API_BASE_URL: 'https://discord.com/api/v10' },
      { DISCORD_GATEWAY_URL: 'wss://gateway.discord.gg/gateway' },
    ]) {
      const result = await run(adapter, entry, changes);
      assert.equal(result.code, 1);
      assert.match(result.output, /offline|synthetic|loopback/);
      assert.doesNotMatch(result.output, /production-credential-is-not-accepted/);
    }
  });
}

test('discord.js: incompatible SDK is rejected before executing installed package code', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'disrunner-sdk-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = path.join(directory, 'node_modules', 'discord.js');
  await mkdir(path.join(sdk, 'src'), { recursive: true });
  await writeFile(path.join(directory, 'bot.cjs'), 'throw new Error("Bot must not execute");');
  await writeFile(
    path.join(sdk, 'package.json'),
    JSON.stringify({ name: 'discord.js', version: '14.0.0', main: 'src/index.js' }),
  );
  const marker = path.join(directory, 'sdk-executed');
  await writeFile(
    path.join(sdk, 'src', 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`,
  );
  const result = await run('discord.js', path.join(directory, 'bot.cjs'), {});
  assert.equal(result.code, 1);
  assert.match(result.output, /Unsupported discord\.js version 14\.0\.0/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('discord.js: SDK attachment URL is rejected before any remote download', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'disrunner-sdk-attachment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'bot.cjs');
  await linkDiscordJsFixture(path.join(root, 'examples', 'discordjs-bot'), entry);
  await writeFile(
    entry,
    "const {MessagePayload}=require('discord.js'); MessagePayload.resolveFile({attachment:'https://cdn.discordapp.com/attachments/offline-test.txt'}).then(()=>{process.exitCode=2}, error=>{console.error(error.message);process.exitCode=1});",
  );
  const result = await run('discord.js', entry, {});
  assert.equal(result.code, 1);
  assert.match(result.output, /SDK file request must be a loopback URL|remote SDK attachment/);
});

test('discord.py: incompatible SDK metadata is rejected before importing the package', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'disrunner-python-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'discord_py-0.0.0.dist-info'));
  await mkdir(path.join(directory, 'discord'));
  await writeFile(
    path.join(directory, 'discord_py-0.0.0.dist-info', 'METADATA'),
    'Metadata-Version: 2.1\nName: discord.py\nVersion: 0.0.0\n',
  );
  const marker = path.join(directory, 'sdk-executed');
  await writeFile(
    path.join(directory, 'discord', '__init__.py'),
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\n`,
  );
  const entry = path.join(directory, 'bot.py');
  await writeFile(entry, 'raise RuntimeError("Bot must not execute")\n');
  const result = await run('discord.py', entry, {});
  assert.equal(result.code, 1);
  assert.match(result.output, /Unsupported discord\.py version 0\.0\.0/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

for (const adapter of ['discord.js', 'discord.py']) {
  test(`${adapter}: diagnostic redaction covers overlapping known-value occurrences`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'disrunner-sdk-redaction-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const javascript = adapter === 'discord.js';
    const entry = path.join(directory, javascript ? 'bot.cjs' : 'bot.py');
    if (javascript) await linkDiscordJsFixture(path.join(root, 'examples', 'discordjs-bot'), entry);
    await writeFile(
      entry,
      javascript
        ? "setImmediate(()=>{throw new Error('overlap:ababababa:end')});"
        : "import logging\nlogging.getLogger('discord.client').error('overlap:ababababa:end')\n",
    );
    const result = await run(adapter, entry, { LOCAL_ACCESS_KEY: 'abababa' });
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('DISRUNNER_DIAGNOSTIC '));
    assert.equal(lines.length, 1);
    const diagnostic = JSON.parse(lines[0].slice('DISRUNNER_DIAGNOSTIC '.length));
    assert.equal(diagnostic.code, 'bot-error');
    assert.match(diagnostic.message, /overlap:\[REDACTED\]:end/);
    assert.doesNotMatch(diagnostic.message, /abab|\[REDACTED\]ba/);
  });

  test(`${adapter}: structured diagnostics stay bounded and preserve native error behavior`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'disrunner-sdk-diagnostic-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const javascript = adapter === 'discord.js';
    const entry = path.join(directory, javascript ? 'bot.cjs' : 'bot.py');
    if (javascript) await linkDiscordJsFixture(path.join(root, 'examples', 'discordjs-bot'), entry);
    await writeFile(
      entry,
      javascript
        ? "setImmediate(()=>{throw new Error('bounded-diagnostic\\nprivate-token-start:'+'λ'.repeat(10000))});"
        : "import logging\nlogger=logging.getLogger('discord.app_commands.tree')\nlogger.addHandler(logging.StreamHandler())\ntry:\n    raise RuntimeError('bounded-diagnostic\\nprivate-token-start:'+'λ'*10000)\nexcept RuntimeError:\n    logger.exception('native-error-log')\n",
    );
    const result = await run(adapter, entry, {});
    assert.equal(result.code, javascript ? 1 : 0);
    assert.match(result.output, javascript ? /Error: bounded-diagnostic/ : /native-error-log/);
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('DISRUNNER_DIAGNOSTIC '));
    assert.equal(lines.length, 1, 'The same error record is reported once');
    assert.ok(Buffer.byteLength(lines[0]) <= 8192);
    const diagnostic = JSON.parse(lines[0].slice('DISRUNNER_DIAGNOSTIC '.length));
    assert.equal(diagnostic.code, 'bot-error');
    assert.match(diagnostic.message, /omitted/);
    assert.doesNotMatch(diagnostic.message, /private-token-start:/);
  });
}
