import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  externalHelperDirectory,
  inspectCallerOwnedExecutable,
  inspectExternalHelper,
  inspectSandboxCandidate,
} from './prepare-linux-sandbox.mjs';

const run = promisify(execFile);
const helperScript = fileURLToPath(new URL('./prepare-linux-sandbox.mjs', import.meta.url));
const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const pinnedHelper = path.join(
  path.dirname(requireDesktop.resolve('electron/package.json')),
  'dist',
  'chrome-sandbox',
);
const options = { skip: process.platform !== 'linux' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner sandbox helper test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function namespaceProbe() {
  assert.equal(
    process.getuid(),
    0,
    'Run this internal probe only inside an isolated user namespace.',
  );
  assert.equal(
    (await readFile('/proc/self/uid_map', 'utf8')).trim().split(/\s+/u)[1] !== '0',
    true,
    'The namespace must map root to a non-root host UID.',
  );
  const bytes = await readFile(pinnedHelper);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const instance = randomUUID();
  const directory = externalHelperDirectory(instance);
  const helper = path.join(directory, 'chrome-sandbox');
  const command = async (...args) =>
    JSON.parse((await run(process.execPath, [helperScript, ...args], { timeout: 10_000 })).stdout);
  let created = false;
  try {
    const first = await command('--create-external-helper', instance, expectedHash);
    created = true;
    assert.equal(first.uid, 0);
    assert.equal(first.gid, 0);
    assert.equal(first.mode, '4755');
    assert.equal(first.helperSha256, expectedHash);
    const initialInode = (await lstat(helper)).ino;
    assert.equal((await inspectExternalHelper(instance)).helperPath, helper);
    assert.equal(
      (await lstat(helper)).ino,
      initialInode,
      'Reuse inspection must not replace the helper.',
    );

    await chmod(helper, 0o644);
    await assert.rejects(inspectExternalHelper(instance), /mode 4755/u);
    await chmod(helper, 0o4755);
    await writeFile(helper, 'wrong bytes');
    await chmod(helper, 0o4755);
    await assert.rejects(inspectExternalHelper(instance), /match pinned Electron/u);
    await assert.rejects(command('--remove-external-helper', instance, expectedHash));
    assert.ok((await lstat(helper)).isFile(), 'A mismatching helper must not be unlinked.');
    await writeFile(helper, bytes);
    await chmod(helper, 0o4755);

    const marker = path.join(directory, 'preserve-existing');
    await writeFile(marker, 'keep');
    await assert.rejects(command('--create-external-helper', instance, expectedHash), /EEXIST/u);
    assert.equal(
      await readFile(marker, 'utf8'),
      'keep',
      'Creation failure must not remove pre-existing objects.',
    );
    await assert.rejects(command('--remove-external-helper', instance, expectedHash));
    assert.ok((await lstat(helper)).isFile());
    await unlink(marker);
    assert.equal(
      (await command('--remove-external-helper', instance, expectedHash)).status,
      'removed',
    );
    created = false;
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    assert.equal(
      (await command('--remove-external-helper', instance, expectedHash)).status,
      'already-removed',
    );
    process.stdout.write(
      JSON.stringify({
        status: 'passed',
        scope: 'isolated-user-namespace-root-modes-only',
        namespaceUid: process.getuid(),
        helperSha256: expectedHash,
        create: true,
        reuse: true,
        wrongModeRejected: true,
        wrongHashCleanupRejected: true,
        extraEntryCleanupRejected: true,
        preexistingObjectsPreserved: true,
        removed: true,
        hostSuidFallbackQualified: false,
      }) + '\n',
    );
  } finally {
    if (created) {
      await writeFile(helper, bytes);
      await chmod(helper, 0o4755);
      await unlink(path.join(directory, 'preserve-existing')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await command('--remove-external-helper', instance, expectedHash);
    }
  }
}

if (process.argv[2] === '--namespace-probe') {
  await namespaceProbe();
} else {
  test(
    'sandbox preparation accepts only the exact pinned packaged helper without Electron index side effects',
    options,
    async (t) => {
      const directory = await fixture(t);
      await copyFile(pinnedHelper, path.join(directory, 'chrome-sandbox'));
      const original = process.env.ELECTRON_OVERRIDE_DIST_PATH;
      process.env.ELECTRON_OVERRIDE_DIST_PATH = path.join(directory, 'untrusted-override');
      t.after(() => {
        if (original === undefined) delete process.env.ELECTRON_OVERRIDE_DIST_PATH;
        else process.env.ELECTRON_OVERRIDE_DIST_PATH = original;
      });
      const result = await inspectSandboxCandidate(directory);
      assert.equal(result.appDirectory, directory);
      assert.equal(result.electronVersion, requireDesktop('electron/package.json').version);
      assert.match(result.helperSha256, /^[a-f0-9]{64}$/u);
    },
  );

  test(
    'sandbox preparation rejects modified, empty, oversized and non-regular helper files',
    options,
    async (t) => {
      const directory = await fixture(t);
      const helper = path.join(directory, 'chrome-sandbox');
      for (const bytes of [
        Buffer.from('untrusted helper'),
        Buffer.alloc(0),
        Buffer.alloc(1_048_577),
      ]) {
        await writeFile(helper, bytes);
        await assert.rejects(inspectSandboxCandidate(directory));
      }
      await unlink(helper);
      await mkdir(helper);
      await assert.rejects(inspectSandboxCandidate(directory));
    },
  );

  test(
    'sandbox preparation refuses a symlink helper before any privilege request',
    options,
    async (t) => {
      const directory = await fixture(t);
      await symlink(pinnedHelper, path.join(directory, 'chrome-sandbox'));
      await assert.rejects(inspectSandboxCandidate(directory), { code: 'ELOOP' });
    },
  );

  test(
    'external profile binds its executable metadata to a regular caller-owned ELF file',
    options,
    async (t) => {
      const directory = await fixture(t);
      const executable = path.join(directory, 'disrunner');
      await copyFile('/usr/bin/true', executable);
      await chmod(executable, 0o755);
      assert.equal(
        (await inspectCallerOwnedExecutable(executable)).executableUid,
        process.getuid(),
      );
      await assert.rejects(inspectCallerOwnedExecutable('/usr/bin/true'), /belong to the caller/u);
      await unlink(executable);
      await symlink('/usr/bin/true', executable);
      await assert.rejects(inspectCallerOwnedExecutable(executable), { code: 'ELOOP' });
      await unlink(executable);
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await assert.rejects(inspectCallerOwnedExecutable(executable), /ELF/u);
    },
  );

  test('external helper paths are fixed-prefix UUIDs and reject arbitrary cleanup destinations', () => {
    const instance = randomUUID();
    assert.equal(externalHelperDirectory(instance), '/tmp/disrunner-sandbox-' + instance);
    for (const invalid of [
      '',
      '/tmp/arbitrary',
      '../escape',
      instance + '/..',
      '00000000-0000-0000-0000-000000000000',
      'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345',
    ])
      assert.throws(() => externalHelperDirectory(invalid), /instance must be a UUID/u);
  });

  test(
    'external helper rejects caller-owned and symlink directories rather than trusting receipt paths',
    options,
    async (t) => {
      const instance = randomUUID();
      const directory = externalHelperDirectory(instance);
      await mkdir(directory, { mode: 0o755 });
      t.after(() => rm(directory, { recursive: true, force: true }));
      await copyFile(pinnedHelper, path.join(directory, 'chrome-sandbox'));
      await assert.rejects(inspectExternalHelper(instance), /directory must belong to root/u);
      await rm(directory, { recursive: true });
      const target = await fixture(t);
      await symlink(target, directory);
      await assert.rejects(inspectExternalHelper(instance));
      assert.ok((await lstat(directory)).isSymbolicLink());
    },
  );

  test(
    'unprivileged root submodes fail before creating or removing a helper',
    options,
    async () => {
      const instance = randomUUID();
      for (const flag of ['--create-external-helper', '--remove-external-helper'])
        await assert.rejects(
          run(process.execPath, [helperScript, flag, instance, '0'.repeat(64)], { timeout: 5000 }),
          /requires an administrator/u,
        );
      await assert.rejects(lstat(externalHelperDirectory(instance)), { code: 'ENOENT' });
    },
  );
}
