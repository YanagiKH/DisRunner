import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectSandboxCandidate } from './prepare-linux-sandbox.mjs';

const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const options = { skip: process.platform !== 'linux' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner sandbox helper test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('sandbox preparation accepts only the exact pinned packaged helper', options, async (t) => {
  const directory = await fixture(t);
  await copyFile(
    path.join(path.dirname(requireDesktop('electron')), 'chrome-sandbox'),
    path.join(directory, 'chrome-sandbox'),
  );
  const result = await inspectSandboxCandidate(directory);
  assert.equal(result.appDirectory, directory);
  assert.equal(result.electronVersion, requireDesktop('electron/package.json').version);
  assert.match(result.helperSha256, /^[a-f0-9]{64}$/u);
});

test(
  'sandbox preparation refuses modified helper bytes before any privilege request',
  options,
  async (t) => {
    const directory = await fixture(t);
    await writeFile(path.join(directory, 'chrome-sandbox'), 'untrusted helper');
    await assert.rejects(inspectSandboxCandidate(directory), /must match pinned Electron/u);
  },
);

test(
  'sandbox preparation refuses a symlink helper before any privilege request',
  options,
  async (t) => {
    const directory = await fixture(t);
    await symlink(
      path.join(path.dirname(requireDesktop('electron')), 'chrome-sandbox'),
      path.join(directory, 'chrome-sandbox'),
    );
    await assert.rejects(inspectSandboxCandidate(directory), { code: 'ELOOP' });
  },
);
