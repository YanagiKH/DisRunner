import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
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
    assert.equal(after.size, before.size);
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
