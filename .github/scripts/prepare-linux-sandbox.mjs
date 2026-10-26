import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '../..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const externalPrefix = '/tmp/disrunner-sandbox-';

function unchangedMetadata(before, after) {
  for (const field of ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'mtimeMs', 'ctimeMs'])
    assert.equal(after[field], before[field], `Sandbox file ${field} changed during inspection.`);
}

async function regularFile(filename) {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    assert.ok(before.isFile() && before.size > 0 && before.size <= 1_048_576);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    assert.equal(length, before.size, 'Sandbox helper changed during its bounded read.');
    unchangedMetadata(before, after);
    return { bytes: bytes.subarray(0, length), status: after };
  } finally {
    await file.close();
  }
}

async function pinnedHelper() {
  const expectedVersion = desktopRequire('./package.json').devDependencies.electron;
  const installedVersion = desktopRequire('electron/package.json').version;
  assert.equal(installedVersion, expectedVersion, 'Use the pinned Electron installation.');
  const electronDirectory = path.dirname(desktopRequire.resolve('electron/package.json'));
  const { bytes } = await regularFile(path.join(electronDirectory, 'dist', 'chrome-sandbox'));
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
  return { bytes, sha256: hash(bytes), electronVersion: installedVersion };
}

export async function inspectSandboxCandidate(directory) {
  assert.equal(process.platform, 'linux', 'Sandbox preparation is Linux-only.');
  const appDirectory = await realpath(directory);
  const pinned = await pinnedHelper();
  const { bytes } = await regularFile(path.join(appDirectory, 'chrome-sandbox'));
  assert.equal(hash(bytes), pinned.sha256, 'The packaged helper must match pinned Electron.');
  return { appDirectory, helperSha256: pinned.sha256, electronVersion: pinned.electronVersion };
}

export function externalHelperDirectory(instance) {
  assert.match(
    instance,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    'External sandbox instance must be a UUID generated for this roundtrip.',
  );
  return externalPrefix + instance;
}

export async function inspectCallerOwnedExecutable(executable) {
  assert.ok(
    process.getuid() > 0 && process.geteuid() > 0,
    'Use a non-root extracted installation.',
  );
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    assert.ok(before.isFile() && before.size >= 4, 'The application executable must be regular.');
    assert.equal(
      before.uid,
      process.getuid(),
      'The extracted executable must belong to the caller.',
    );
    assert.ok((before.mode & 0o111) !== 0, 'The application executable must be executable.');
    assert.equal(
      before.mode & 0o6000,
      0,
      'The application executable must not be setuid or setgid.',
    );
    const magic = Buffer.alloc(4);
    assert.equal((await file.read(magic, 0, 4, 0)).bytesRead, 4);
    assert.equal(magic.toString('hex'), '7f454c46', 'Use the packaged ELF application executable.');
    const after = await file.stat();
    unchangedMetadata(before, after);
    return { executableUid: after.uid, executableGid: after.gid, executableSize: after.size };
  } finally {
    await file.close();
  }
}

async function protectedExternalDirectory(instance, allowMissing = false) {
  const directory = externalHelperDirectory(instance);
  let folder;
  try {
    folder = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const status = await folder.stat();
    assert.ok(status.isDirectory());
    assert.equal(status.uid, 0, 'External sandbox directory must belong to root.');
    assert.equal(status.gid, 0, 'External sandbox directory group must be root.');
    assert.equal(status.mode & 0o7777, 0o755, 'External sandbox directory must have mode 0755.');
    assert.equal(
      await realpath(directory),
      directory,
      'External sandbox path must not contain symlinks.',
    );
    return { directory, folder, stableDirectory: '/proc/self/fd/' + folder.fd };
  } catch (error) {
    await folder.close();
    throw error;
  }
}

async function externalReceipt(instance, allowMissing = false) {
  const pinned = await pinnedHelper();
  const opened = await protectedExternalDirectory(instance, allowMissing);
  if (opened === null) return null;
  try {
    const { bytes, status } = await regularFile(
      path.join(opened.stableDirectory, 'chrome-sandbox'),
    );
    assert.equal(status.uid, 0, 'External sandbox helper must belong to root.');
    assert.equal(status.gid, 0, 'External sandbox helper group must be root.');
    assert.equal(status.mode & 0o7777, 0o4755, 'External sandbox helper must have mode 4755.');
    assert.equal(hash(bytes), pinned.sha256, 'External helper must match pinned Electron.');
    assert.deepEqual(
      await readdir(opened.stableDirectory),
      ['chrome-sandbox'],
      'External sandbox directory must contain only the verified helper.',
    );
    return {
      schemaVersion: 1,
      scope: 'temporary-ci-external-suid-helper',
      instance,
      helperDirectory: opened.directory,
      helperPath: path.join(opened.directory, 'chrome-sandbox'),
      helperSha256: pinned.sha256,
      electronVersion: pinned.electronVersion,
      uid: status.uid,
      gid: status.gid,
      mode: '4755',
      directoryMode: '0755',
    };
  } finally {
    await opened.folder.close();
  }
}

export async function inspectExternalHelper(instance) {
  return externalReceipt(instance);
}

async function createExternalHelper(instance, expectedHash) {
  assert.equal(process.geteuid(), 0, 'Installing a SUID helper requires an administrator.');
  const directory = externalHelperDirectory(instance);
  const pinned = await pinnedHelper();
  assert.equal(pinned.sha256, expectedHash);
  // mkdir is exclusive. Failure must never clean up a pre-existing directory.
  await mkdir(directory, { mode: 0o700 });
  let folder;
  let helperCreated = false;
  try {
    folder = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const target = path.join('/proc/self/fd/' + folder.fd, 'chrome-sandbox');
    const file = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    helperCreated = true;
    try {
      await file.writeFile(pinned.bytes);
      await file.chown(0, 0);
      await file.chmod(0o4755);
      await file.sync();
    } finally {
      await file.close();
    }
    await folder.chown(0, 0);
    await folder.chmod(0o755);
    await folder.sync();
    return await externalReceipt(instance);
  } catch (error) {
    try {
      if (helperCreated && folder !== undefined)
        await unlink(path.join('/proc/self/fd/' + folder.fd, 'chrome-sandbox'));
      await rmdir(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'External helper creation and partial cleanup failed.',
      );
    }
    throw error;
  } finally {
    await folder?.close();
  }
}

async function removeExternalHelper(instance, expectedHash) {
  assert.equal(process.geteuid(), 0, 'Removing a SUID helper requires an administrator.');
  const pinned = await pinnedHelper();
  assert.equal(pinned.sha256, expectedHash);
  const opened = await protectedExternalDirectory(instance, true);
  if (opened === null) return { instance, status: 'already-removed' };
  try {
    const { bytes, status } = await regularFile(
      path.join(opened.stableDirectory, 'chrome-sandbox'),
    );
    assert.equal(status.uid, 0);
    assert.equal(status.gid, 0);
    assert.equal(status.mode & 0o7777, 0o4755);
    assert.equal(hash(bytes), pinned.sha256);
    assert.deepEqual(
      await readdir(opened.stableDirectory),
      ['chrome-sandbox'],
      'Refuse cleanup when the helper directory contains extra entries.',
    );
    await unlink(path.join(opened.stableDirectory, 'chrome-sandbox'));
    await opened.folder.sync();
  } finally {
    await opened.folder.close();
  }
  await rmdir(opened.directory);
  return {
    instance,
    helperDirectory: opened.directory,
    helperSha256: pinned.sha256,
    status: 'removed',
  };
}

async function asAdministrator(args) {
  const { stdout } = await run(
    '/usr/bin/sudo',
    [
      '-n',
      '--',
      '/usr/bin/env',
      '-u',
      'NODE_OPTIONS',
      '-u',
      'NODE_PATH',
      process.execPath,
      filename,
      ...args,
    ],
    { maxBuffer: 131_072, timeout: 30_000 },
  );
  return stdout;
}

async function cleanupExternalHelper(instance) {
  externalHelperDirectory(instance);
  const pinned = await pinnedHelper();
  return process.geteuid() === 0
    ? removeExternalHelper(instance, pinned.sha256)
    : JSON.parse(await asAdministrator(['--remove-external-helper', instance, pinned.sha256]));
}

async function prepareExternalHelper(directory, instance) {
  externalHelperDirectory(instance);
  const candidate = await inspectSandboxCandidate(directory);
  const executable = await inspectCallerOwnedExecutable(
    path.join(candidate.appDirectory, 'disrunner'),
  );
  let created = false;
  try {
    let verified = await externalReceipt(instance, true);
    const reused = verified !== null;
    if (!reused) {
      await asAdministrator(['--create-external-helper', instance, candidate.helperSha256]);
      created = true;
      verified = await externalReceipt(instance);
    }
    // This operation is deliberately unprivileged and bound to the selected AppDir.
    const folder = await open(
      candidate.appDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      assert.equal(
        (await folder.stat()).uid,
        process.getuid(),
        'The extracted AppDir must belong to the caller.',
      );
      const adjacent = path.join('/proc/self/fd/' + folder.fd, 'chrome-sandbox');
      const current = await regularFile(adjacent);
      assert.equal(hash(current.bytes), candidate.helperSha256);
      await unlink(adjacent);
      await assert.rejects(
        lstat(adjacent),
        { code: 'ENOENT' },
        'The adjacent helper must be absent, including symlinks.',
      );
    } finally {
      await folder.close();
    }
    return { ...verified, ...candidate, ...executable, reused, adjacentHelperAbsent: true };
  } catch (error) {
    if (created) {
      try {
        await cleanupExternalHelper(instance);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'External helper preparation and cleanup failed.',
        );
      }
    }
    throw error;
  }
}

async function installVerifiedHelper(directory, expectedHash) {
  assert.equal(process.geteuid(), 0, 'Installing a SUID helper requires an administrator.');
  const pinned = await pinnedHelper();
  assert.equal(pinned.sha256, expectedHash);
  const folder = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stableDirectory = '/proc/self/fd/' + folder.fd;
  const temporary = path.join(stableDirectory, '.chrome-sandbox-' + randomUUID());
  try {
    const current = await regularFile(path.join(stableDirectory, 'chrome-sandbox'));
    assert.equal(hash(current.bytes), expectedHash);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(pinned.bytes);
      await file.chown(0, 0);
      await file.chmod(0o4755);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(stableDirectory, 'chrome-sandbox'));
  } finally {
    try {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      await folder.close();
    }
  }
}

async function receipt(candidate) {
  const { bytes, status } = await regularFile(path.join(candidate.appDirectory, 'chrome-sandbox'));
  assert.equal(status.uid, 0);
  assert.equal(status.gid, 0);
  assert.equal(status.mode & 0o7777, 0o4755);
  assert.equal(hash(bytes), candidate.helperSha256);
  return {
    schemaVersion: 1,
    scope: 'temporary-ci-suid-helper',
    ...candidate,
    uid: 0,
    gid: 0,
    mode: '4755',
  };
}

async function main(args) {
  assert.equal(process.platform, 'linux', 'Sandbox preparation is Linux-only.');
  if (args[0] === '--create-external-helper' || args[0] === '--remove-external-helper') {
    assert.equal(args.length, 3);
    const result =
      args[0] === '--create-external-helper'
        ? await createExternalHelper(args[1], args[2])
        : await removeExternalHelper(args[1], args[2]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (args[0] === '--external-helper') {
    assert.equal(args.length, 4);
    assert.equal(args[2], '--instance');
    process.stdout.write(
      JSON.stringify(await prepareExternalHelper(args[1], args[3]), null, 2) + '\n',
    );
    return;
  }
  if (args[0] === '--cleanup-external-helper') {
    assert.equal(args.length, 2);
    process.stdout.write(JSON.stringify(await cleanupExternalHelper(args[1]), null, 2) + '\n');
    return;
  }
  const installing = args[0] === '--install-verified-helper';
  assert.equal(args.length, installing ? 3 : 1);
  if (installing) {
    await installVerifiedHelper(args[1], args[2]);
    return;
  }
  const candidate = await inspectSandboxCandidate(args[0]);
  if (process.geteuid() === 0) {
    await installVerifiedHelper(candidate.appDirectory, candidate.helperSha256);
  } else {
    await run(
      '/usr/bin/sudo',
      [
        '-n',
        '--',
        '/usr/bin/env',
        '-u',
        'NODE_OPTIONS',
        '-u',
        'NODE_PATH',
        process.execPath,
        filename,
        '--install-verified-helper',
        candidate.appDirectory,
        candidate.helperSha256,
      ],
      { maxBuffer: 131_072 },
    );
  }
  process.stdout.write(JSON.stringify(await receipt(candidate), null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename)
  await main(process.argv.slice(2));
