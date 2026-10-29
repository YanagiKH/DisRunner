import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSession, emptyWorkspace, openWorkspace, saveWorkspace } from '../dist/index.js';

async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'DisRunner file read race '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('dangling workspace links stay unsafe when no-follow opens are unavailable', async (t) => {
  const root = await directory(t);
  assert.equal((await openWorkspace(root)).status, 'missing');
  await fs.mkdir(join(root, '.disrunner'));
  const target = join(root, '.disrunner', 'workspace.json');
  try {
    await fs.symlink('missing.json', target, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Creating a symlink requires Windows privileges.');
      return;
    }
    throw error;
  }
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', (filename, flags, ...args) =>
    originalOpen(
      filename,
      filename === target && typeof flags === 'number'
        ? flags & ~(constants.O_NOFOLLOW ?? 0)
        : flags,
      ...args,
    ),
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(openWorkspace(root), { code: 'unsafe-path' });
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test(
  'a workspace replaced with a pipe before opening is rejected without blocking',
  { skip: process.platform === 'win32', timeout: 8000 },
  async (t) => {
    const root = await directory(t);
    await saveWorkspace(root, emptyWorkspace(), { expectedHash: null });
    const child = String.raw`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const { openWorkspace } = await import(process.argv[1]);
      const root = process.argv[2];
      const target = join(root, '.disrunner', 'workspace.json');
      const originalOpen = fs.open;
      const handles = [];
      let replaced = false;
      fs.open = async (filename, ...args) => {
        if (filename === target && !replaced) {
          replaced = true;
          await fs.unlink(target);
          const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8' });
          assert.equal(fifo.status, 0, fifo.stderr);
        }
        const handle = await originalOpen(filename, ...args);
        if (filename === target) handles.push(handle);
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(openWorkspace(root), { code: 'unsafe-path' });
      assert.equal(replaced, true, 'The real path replacement must occur.');
      assert.ok(handles.every(handle => handle.fd === -1), 'Rejected descriptors must close.');
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', child, new URL('../dist/index.js', import.meta.url).href, root],
      { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
  },
);

test(
  'entry source growth cannot bypass the startup hashing limit',
  { timeout: 20000 },
  async (t) => {
    const root = await directory(t);
    const fixture = fileURLToPath(
      new URL('../../../apps/cli/tests/fixtures/bot-test/', import.meta.url),
    );
    await fs.cp(fixture, root, { recursive: true });
    const configPath = join(root, 'discord-simulator.config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.bot.startCommand = `"${process.execPath}" server.mjs`;
    await fs.writeFile(configPath, JSON.stringify(config));
    const target = join(root, 'server.mjs');
    const session = createSession();
    await session.selectProject(root);
    const originalStat = fs.stat;
    const originalOpen = fs.open;
    const handles = [];
    let grew = false;
    const grow = async () => {
      if (grew) return;
      grew = true;
      await fs.appendFile(target, Buffer.alloc(16 * 1_048_576 + 1, 32));
    };
    t.mock.method(fs, 'stat', async (filename, ...args) => {
      const info = await originalStat(filename, ...args);
      if (filename === target) await grow();
      return info;
    });
    t.mock.method(fs, 'open', async (filename, ...args) => {
      const handle = await originalOpen(filename, ...args);
      if (filename === target) {
        handles.push(handle);
        const stat = handle.stat.bind(handle);
        t.mock.method(handle, 'stat', async (...options) => {
          const info = await stat(...options);
          await grow();
          return info;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const started = await session.start();
      assert.equal(started.phase, 'running', started.error);
      assert.equal(grew, true, 'The real file must grow after its size is checked.');
      assert.equal(session.snapshot().inputs.sourceHash, null);
      assert.ok(
        handles.every((handle) => handle.fd === -1),
        'Hash descriptors must close.',
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal((await session.dispose()).ok, true);
    }
  },
);
