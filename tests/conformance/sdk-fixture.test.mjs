import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { linkDiscordJsFixture } from '../../scripts/sdk-fixture.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('copied discord.js Bot resolves and executes the original physical pinned SDK', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner physical SDK 測試 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'bot.cjs');
  await writeFile(
    entry,
    "const sdk=require('discord.js'); console.log(JSON.stringify({version:sdk.version,entry:require.resolve('discord.js')}));",
  );
  const fixture = await linkDiscordJsFixture(path.join(root, 'examples/discordjs-bot'), entry);
  const modules = path.join(directory, 'node_modules');
  const modulesInfo = await lstat(modules);
  assert.equal(modulesInfo.isDirectory(), true);
  assert.equal(modulesInfo.isSymbolicLink(), false);
  assert.equal(fixture.fixtureModules, path.join(await realpath(directory), 'node_modules'));
  assert.equal((await lstat(path.join(modules, 'discord.js'))).isSymbolicLink(), true);
  assert.equal(await realpath(path.join(modules, 'discord.js')), fixture.packageRoot);

  const { stdout } = await execute(process.execPath, [entry], {
    cwd: directory,
    timeout: 10_000,
    encoding: 'utf8',
  });
  const actual = JSON.parse(stdout);
  assert.equal(actual.version, '14.27.0');
  assert.equal(await realpath(actual.entry), fixture.sdkEntry);
  t.diagnostic(
    JSON.stringify({
      nativeWindows: process.platform === 'win32',
      fixtureVolume: path.parse(fixture.fixtureModules).root,
      sdkVolume: path.parse(fixture.sdkEntry).root,
      ...fixture,
    }),
  );
});
