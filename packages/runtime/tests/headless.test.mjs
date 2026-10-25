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
  assert.deepEqual(manifest.dependencies, {
    '@disrunner/core': 'workspace:*',
    '@disrunner/adapter-discordjs': 'workspace:*',
    '@disrunner/adapter-discordpy': 'workspace:*',
    yaml: '^2.9.1',
  });
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

// Actual Desktop main source, with only Electron's shell replaced by inert JS objects.
// This is headless adapter evidence: no Electron, browser, GUI window or Xvfb runs.
for (const strict of [true, false]) {
  test(`Desktop main IPC adopts ${strict ? 'strict' : 'legacy'} config and emits narrow real-session DTOs`, async () => {
    const { cp, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const { runInNewContext } = await import('node:vm');
    const ts = (await import('typescript')).default;
    const runtimeModule = await import('../dist/index.js');
    const directory = await mkdtemp(path.join(tmpdir(), 'desktop-permissions-headless-'));
    const handlers = new Map();
    const appEvents = new Map();
    const delivered = [];
    let ownedSession;
    let ready;
    const registered = new Promise((resolve) => {
      ready = resolve;
    });
    try {
      const fixture = new URL('../../../apps/cli/tests/fixtures/bot-test/', import.meta.url);
      await cp(fixture, directory, { recursive: true });
      const configPath = path.join(directory, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      if (strict) {
        config.profile.ordinaryMessagePermissions = 'guild-text-own-messages-v1';
        config.fixtures.bot = 'bot.json';
      }
      delete config.environment.DISRUNNER_TEST_TRACE;
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(
        path.join(directory, 'bot.json'),
        JSON.stringify({ version: 1, user: { id: '5000', bot: true } }),
      );
      await writeFile(
        path.join(directory, 'user.json'),
        JSON.stringify({
          version: 1,
          user: { id: '3000', bot: false, roles: ['private-human-role'] },
        }),
      );
      await writeFile(
        path.join(directory, 'guild.json'),
        JSON.stringify({
          version: 1,
          guild: {
            id: '1000',
            owner_id: '9000',
            roles: [
              { id: '1000', permissions: '0' },
              { id: '1100', permissions: '0' },
              { id: '1200', permissions: '68608' },
            ],
            channels: [{ id: '2000', type: 0, permission_overwrites: [] }],
            members: [
              { id: '5100', user_id: '5000', roles: ['1100'] },
              { id: '5101', user_id: '3000', roles: ['1200'] },
            ],
          },
        }),
      );
      const serverPath = path.join(directory, 'server.mjs');
      let server = await readFile(serverPath, 'utf8');
      const anchor = '      const content =';
      assert.equal(server.split(anchor).length, 2);
      server = server.replace("request.on('end', () => {", "request.on('end', async () => {");
      server = server.replace(
        anchor,
        `      let permissionObservation;
      if (!ping) {
        const response = await fetch('http://127.0.0.1:' + process.env.DISRUNNER_REST_PORT + '/api/v10/channels/2000/messages', {
          method: 'POST', headers: { authorization: 'Bot ' + process.env.DISRUNNER_FAKE_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'headless ordinary message' }),
        });
        const payload = await response.json();
        permissionObservation = JSON.stringify({ status: response.status, body: response.status === 403 ? payload : { content: payload.content, bot: payload.author?.bot }, actorId: interaction.member?.user?.id });
      }
      const content = permissionObservation ? permissionObservation :`,
      );
      await writeFile(serverPath, server);

      const shellSession = {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {} },
      };
      class InertShellWindow {
        static fromWebContents() {
          return null;
        }
        webContents = {
          send: (channel, event) => delivered.push({ channel, event }),
          setWindowOpenHandler() {},
          on() {},
        };
        isDestroyed() {
          return false;
        }
        once() {}
        loadURL() {
          ready();
          return Promise.resolve();
        }
      }
      const shell = {
        app: {
          isPackaged: false,
          on: (name, handler) => appEvents.set(name, handler),
          requestSingleInstanceLock: () => true,
          whenReady: () => Promise.resolve(),
          getVersion: () => 'headless',
          getPath: () => path.join(directory, 'user-data'),
          quit() {},
        },
        BrowserWindow: InertShellWindow,
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [directory] }) },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        Menu: { setApplicationMenu() {} },
        session: { defaultSession: shellSession },
      };
      const mainUrl = new URL('../../../apps/desktop/electron/main.cts', import.meta.url);
      const main = ts.transpileModule(await readFile(mainUrl, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      const require = createRequire(mainUrl);
      const shutdown = ts.transpileModule(
        await readFile(
          new URL('../../../apps/desktop/electron/shutdown-policy.ts', import.meta.url),
          'utf8',
        ),
        {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
      ).outputText;
      const shutdownExports = {};
      runInNewContext(shutdown, { exports: shutdownExports });
      runInNewContext(main, {
        exports: {},
        URL,
        __dirname: path.dirname(fileURLToPath(mainUrl)),
        console,
        process,
        require: (specifier) => {
          if (specifier === 'electron') return shell;
          if (specifier === './shutdown-policy.js') return shutdownExports;
          if (specifier === '@disrunner/runtime')
            return {
              ...runtimeModule,
              createSession: (options) => {
                ownedSession = runtimeModule.createSession(options);
                return ownedSession;
              },
            };
          return require(specifier);
        },
      });
      await Promise.race([
        registered,
        new Promise((_, reject) => {
          const timeout = setTimeout(
            () => reject(Error('headless IPC registration timed out')),
            3000,
          );
          timeout.unref();
        }),
      ]);
      const frame = { url: 'http://127.0.0.1:5173/' };
      const event = { senderFrame: frame, sender: { mainFrame: frame } };
      const call = (name, ...args) => handlers.get(name)(event, ...args);
      await assert.rejects(
        handlers.get('runtime:get-state')({ senderFrame: null, sender: {} }),
        /Untrusted IPC sender/u,
      );
      const selected = await call('project:select');
      assert.deepEqual(selected.contexts, [
        { actorId: '3000', guildId: '1000', channelId: '2000' },
      ]);
      const started = await call('runtime:start');
      assert.equal(started.phase, 'running');
      const result = await call('runtime:invoke', {
        runId: started.runId,
        requestId: 'desktop-permissions',
        input: '/ping',
        context: { actorId: '3000', guildId: '1000', channelId: '2000' },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(JSON.parse(result.response.data.content), {
        status: strict ? 403 : 200,
        body: strict
          ? { code: 50013, message: 'Missing Permissions' }
          : { content: 'headless ordinary message', bot: true },
        actorId: '3000',
      });
      const snapshot = await call('runtime:get-state');
      assert.ok(
        snapshot.coreState.resources.some(
          (row) => row.resourceType === 'channel' && row.id === '2000',
        ),
      );
      for (const state of [snapshot, ...delivered.map(({ event }) => event.snapshot)]) {
        const resources = state.coreState?.resources ?? [];
        assert.equal(
          resources.some((row) => ['role', 'member'].includes(row.resourceType)),
          false,
        );
        const serialized = JSON.stringify(resources);
        for (const forbidden of [
          '"roles"',
          '"permission_overwrites"',
          '"owner_id"',
          'private-human-role',
        ]) {
          assert.equal(serialized.includes(forbidden), false, forbidden);
        }
      }
      assert.ok(delivered.some(({ channel }) => channel === 'runtime:state'));
      assert.equal((await call('runtime:stop')).ok, true);
    } finally {
      if (ownedSession) assert.equal((await ownedSession.dispose()).ok, true);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
