import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// This is plain Node, with no Electron bootstrap or renderer globals.
test('built ESM runtime imports, constructs, selects and stops without spawning or listening', async () => {
  const originalSpawn = childProcess.spawn;
  const originalListen = net.Server.prototype.listen;
  const forbidden = () => {
    assert.fail('import/create/select/stop must not spawn a child or listen on a socket');
  };
  childProcess.spawn = forbidden;
  net.Server.prototype.listen = forbidden;
  syncBuiltinESMExports();
  try {
    const { RuntimeManager, DesktopRuntimeManager, emptyRuntimeState, createSession } =
      await import('../dist/index.js');
    assert.equal(RuntimeManager, DesktopRuntimeManager);
    const states = [];
    const endpoints = [];
    const runtime = new RuntimeManager(
      (state) => states.push(state),
      (value) => endpoints.push(value),
    );
    assert.deepEqual(runtime.snapshot(), emptyRuntimeState());
    assert.deepEqual(states, []);
    assert.deepEqual(endpoints, []);
    const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
    const selected = await runtime.selectProject(project);
    assert.equal(selected.phase, 'ready');
    assert.equal(selected.project.root, await realpath(project));
    assert.equal(selected.project.adapter, 'raw-interaction-webhook');
    assert.equal(selected.pid, null);
    assert.equal(selected.endpoints, null);
    selected.output.push({ stream: 'stdout', text: 'must not escape clone', atMs: 0 });
    assert.deepEqual(runtime.snapshot().output, []);
    assert.equal((await runtime.stop()).phase, 'ready');
    assert.equal((await runtime.stop()).phase, 'ready');
    assert.deepEqual(endpoints, []);
    const session = createSession();
    assert.equal(session.snapshot().disposed, false);
    await session.selectProject(project);
    assert.equal((await session.dispose()).ok, true);
    assert.equal(session.snapshot().disposed, true);
    assert.equal((await session.dispose()).ok, true);
    await assert.rejects(session.start(), { code: 'invalid' });
    assert.equal(
      typeof runtime.dispose,
      'undefined',
      'the legacy manager has no dispose API; disposal belongs to Session',
    );
  } finally {
    childProcess.spawn = originalSpawn;
    net.Server.prototype.listen = originalListen;
    syncBuiltinESMExports();
  }
});

test('runtime production dependency closure excludes Electron and React', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.dependencies, { '@disrunner/core': 'workspace:*' });
  const core = JSON.parse(
    await readFile(new URL('../../core/package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(core.dependencies).sort(), ['ws', 'yaml', 'zod']);
  for (const name of [
    'index',
    'contracts',
    'runtime-manager',
    'project-config',
    'interaction-transport',
    'interaction-peer-auth',
  ]) {
    const source = await readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:electron|react)(?:['"/])/u,
    );
  }
});
