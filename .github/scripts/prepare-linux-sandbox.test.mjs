import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
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
  let mutation;
  let markerFile;
  let markerCreated = false;
  const replaceHelperBytes = async (content) => {
    await mutation.truncate(content.length);
    let offset = 0;
    while (offset < content.length) {
      const { bytesWritten } = await mutation.write(
        content,
        offset,
        content.length - offset,
        offset,
      );
      assert.ok(bytesWritten > 0);
      offset += bytesWritten;
    }
    await mutation.sync();
  };
  try {
    const first = await command('--create-external-helper', instance, expectedHash);
    created = true;
    assert.equal(first.uid, 0);
    assert.equal(first.gid, 0);
    assert.equal(first.mode, '4755');
    assert.equal(first.helperSha256, expectedHash);
    mutation = await open(
      helper,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const initialInode = (await mutation.stat()).ino;
    assert.equal((await inspectExternalHelper(instance)).helperPath, helper);
    assert.equal(
      (await lstat(helper)).ino,
      initialInode,
      'Reuse inspection must not replace the helper.',
    );

    await mutation.chmod(0o644);
    await assert.rejects(inspectExternalHelper(instance), /mode 4755/u);
    await mutation.chmod(0o4755);
    await replaceHelperBytes(Buffer.from('wrong bytes'));
    await mutation.chmod(0o4755);
    await assert.rejects(inspectExternalHelper(instance), /match pinned Electron/u);
    await assert.rejects(command('--remove-external-helper', instance, expectedHash));
    assert.equal((await mutation.stat()).nlink, 1, 'A mismatching helper must not be unlinked.');
    await replaceHelperBytes(bytes);
    await mutation.chmod(0o4755);

    const marker = path.join(directory, 'preserve-existing');
    markerFile = await open(
      marker,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    markerCreated = true;
    await markerFile.writeFile('keep');
    await assert.rejects(command('--create-external-helper', instance, expectedHash), /EEXIST/u);
    const markerBytes = Buffer.alloc(4);
    assert.equal((await markerFile.read(markerBytes, 0, 4, 0)).bytesRead, 4);
    assert.equal(markerBytes.toString('utf8'), 'keep');
    assert.equal(
      (await markerFile.stat()).nlink,
      1,
      'Creation failure must not remove pre-existing objects.',
    );
    assert.deepEqual((await readdir(directory)).sort(), ['chrome-sandbox', 'preserve-existing']);
    await assert.rejects(command('--remove-external-helper', instance, expectedHash));
    assert.equal((await mutation.stat()).nlink, 1);
    await unlink(marker);
    markerCreated = false;
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
    try {
      if (created) {
        if (mutation !== undefined) {
          await replaceHelperBytes(bytes);
          await mutation.chmod(0o4755);
        }
        if (markerCreated) await unlink(path.join(directory, 'preserve-existing'));
        await command('--remove-external-helper', instance, expectedHash);
      }
    } finally {
      try {
        await markerFile?.close();
      } finally {
        await mutation?.close();
      }
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
    'read-only external inspection does not allocate an unused instance directory',
    options,
    async () => {
      const instance = randomUUID();
      await assert.rejects(inspectExternalHelper(instance), { code: 'ENOENT' });
      await assert.rejects(lstat(externalHelperDirectory(instance)), { code: 'ENOENT' });
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
