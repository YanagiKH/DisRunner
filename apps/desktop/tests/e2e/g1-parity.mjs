// Real packaged Electron UI + executable CLI. No bridge substitution or live-host probes.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const corpus = path.join(root, 'apps/desktop/tests/fixtures/g1-parity');
const output = path.resolve(process.env.G1_EVIDENCE_DIR ?? 'g1-evidence');
const cliOnly = process.argv.includes('--cli-only');
const marker = "const mode = 'normal'; // G1_MUTATION_POINT";
// Independent handwritten expectations. Never derive these from fixture responses.
const expected = {
  normal: [0, 'passed'],
  'missing-executable': [2, 'invalid'],
  'wrong-safe': [1, 'failed'],
  'pong-only': [1, 'runner-error'],
  'exit-startup-0': [1, 'runner-error'],
  'exit-startup-1': [1, 'runner-error'],
  'delayed-reply': [0, 'passed'],
  'stalled-startup': [1, 'runner-error'],
  'stalled-command': [1, 'runner-error'],
};
const canonical = 'G1 parity reply.';
const results = [];
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE.*KEY|API.*KEY|AUTHORIZATION|COOKIE/iu.test(key))
    delete env[key];
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'VITE_DEV_SERVER_URL'])
  delete env[key];
await mkdir(output, { recursive: true });
// Refuse to overwrite previous evidence, including first failures.
await writeFile(
  path.join(output, 'expectations.json'),
  JSON.stringify({ expected, canonical }, null, 2),
  { flag: 'wx' },
);
const digest = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const fixtures = Object.fromEntries(
  await Promise.all(
    (await readdir(corpus)).map(async (name) => [name, await digest(path.join(corpus, name))]),
  ),
);
async function hashTree(directory) {
  const hashes = {};
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else hashes[file] = await digest(path.join(directory, file));
    }
  }
  await walk();
  return hashes;
}
const identity = {
  timestamp: new Date().toISOString(),
  cwd: root,
  command: process.argv,
  node: process.version,
  nodeExecutable: process.execPath,
  platform: process.platform,
  arch: process.arch,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
  fixtures,
  harnessSha256: await digest(fileURLToPath(import.meta.url)),
  lockSha256: await digest(path.join(root, 'pnpm-lock.yaml')),
  buildTrees: {
    core: await hashTree(path.join(root, 'packages/core/dist')),
    runtime: await hashTree(path.join(root, 'packages/runtime/dist')),
    cli: await hashTree(path.join(root, 'apps/cli/dist')),
  },
  pnpmExecution: 'not invoked; no install or bootstrap',
  cliSha256: await digest(path.join(root, 'apps/cli/dist/index.js')),
  pending: [
    'live-host network security probe not authorized',
    'Windows/macOS qualification',
    'G0 SDK',
    'G8 installed release',
    'observed late successful old-run callback rejection (stop/death/replacement is not that proof)',
  ],
};
await save('identity.json', identity);
async function save(name, value) {
  await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
}
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Timed out: ${label}`);
}
async function project(label, mode, actor = 'a') {
  const directory = path.join(output, label);
  await cp(corpus, directory, { recursive: true, errorOnExist: true, force: false });
  const file = path.join(directory, 'bot.mjs');
  const source = await readFile(file, 'utf8');
  assert.equal(source.split(marker).length - 1, 1);
  await writeFile(
    file,
    source.replace(
      marker,
      `const mode = '${mode === 'missing-executable' ? 'normal' : mode}'; // G1_MUTATION_POINT`,
    ),
  );
  if (actor === 'b')
    await cp(
      path.join(directory, 'discord-simulator.actor-b.config.json'),
      path.join(directory, 'discord-simulator.config.json'),
    );
  if (mode === 'missing-executable') {
    const configPath = path.join(directory, 'discord-simulator.config.json');
    const before = await digest(configPath);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.bot.startCommand = 'definitely-missing-disrunner-g1-executable bot.mjs';
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await save(`${label}-config-fault.json`, {
      fault: 'missing-executable',
      field: 'bot.startCommand',
      before,
      after: await digest(configPath),
      expected: 'invalid/2; no child launch',
      distinctFromBotConstantMutation: true,
    });
  }
  await save(`${label}-mutation.json`, {
    mode,
    actor,
    originalBotSha256: fixtures['bot.mjs'],
    mutatedBotSha256: await digest(file),
    markerCount: 1,
  });
  return directory;
}
async function trace(directory) {
  try {
    return (await readFile(path.join(directory, 'child-trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function closed(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(Error('Loopback observer timed out'));
    });
  });
}
async function released(directory) {
  const events = await trace(directory);
  const launch = events.find((event) => event.event === 'launch');
  assert.ok(launch, 'real child must record launch');
  await until(async () => {
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${launch.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
        assert.equal(
          fields[19],
          launch.procStarttime,
          'PID reuse is not original-child death proof',
        );
        return ['Z', 'X', 'x'].includes(fields[0]);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) return true;
        throw error;
      }
    }
    try {
      process.kill(launch.pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }, 'owned direct child death');
  for (const port of [launch.port, launch.restPort, launch.gatewayPort]) {
    assert.ok(Number.isInteger(port) && port > 0);
    await until(() => closed(port), 'owned loopback port closure');
  }
  return events;
}
async function cli(directory, mode, actor = 'a', casePath) {
  const args = [
    path.join(root, 'apps/cli/dist/index.js'),
    'bot-test',
    casePath ?? path.join(directory, `case-${actor}.json`),
    '--project',
    directory,
    '--timeout-ms',
    '4000',
  ];
  let stdout = '',
    stderr = '',
    contained = false;
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    contained = true;
    child.kill('SIGTERM');
  }, 12000);
  const hardTimer = setTimeout(() => {
    contained = true;
    child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  }, 15000);
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-262144);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-262144);
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  });
  await save(`${path.basename(directory)}-cli-process.json`, {
    args,
    code,
    stdout,
    stderr,
    contained,
  });
  assert.equal(contained, false, 'test containment is not successful runtime cleanup');
  const report = JSON.parse(stdout);
  assert.deepEqual([code, report.status], expected[mode]);
  if (mode === 'normal' || mode === 'delayed-reply' || mode === 'wrong-safe') {
    assert.equal(report.assertions.length, 1);
    assert.equal(
      report.assertions[0].actual.data.content,
      mode === 'wrong-safe'
        ? 'Different G1 reply.'
        : casePath
          ? 'Pong! Offline and deterministic.'
          : canonical,
    );
    assert.equal(report.assertions[0].passed, mode !== 'wrong-safe');
  }
  if (mode === 'missing-executable')
    assert.deepEqual(await trace(directory), [], 'missing executable must fail before spawn');
  else if (!casePath) {
    const events = await released(directory);
    if (['normal', 'wrong-safe', 'delayed-reply'].includes(mode)) {
      const command = events.find((event) => event.event === 'command');
      assert.deepEqual(
        [command.guildId, command.channelId, command.actorId],
        ['1000', '2001', actor === 'b' ? '3001' : '3000'],
      );
      assert.ok(events.some((event) => event.event === 'callback' && event.authenticatedResponse));
    }
  }
  results.push({ surface: 'cli', mode, actor, code, status: report.status });
}
async function gui() {
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw Error(
      'GUI BLOCKED: no configured display; no provisioning or RUN_AS_NODE fallback permitted.',
    );
  const executablePath = process.env.G1_PACKAGED_EXECUTABLE;
  assert.ok(executablePath, 'G1_PACKAGED_EXECUTABLE must name a locally built packaged candidate');
  const { _electron: electron } = await import('playwright');
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${path.join(output, 'user-data')}`],
    env,
    timeout: 15000,
  });
  let page;
  let contained = false;
  const watchdog = setTimeout(() => {
    contained = true;
    application.process().kill('SIGKILL');
  }, 180000);
  try {
    page = await bounded(application.firstWindow(), 15000, 'first real renderer');
    page.setDefaultTimeout(15000);
    await page.waitForLoadState('domcontentloaded');
    assert.match(page.url(), /^file:/u);
    assert.deepEqual(
      await page.evaluate(() => ({
        bridge: typeof window.disrunnerDesktop,
        process: typeof globalThis.process,
        require: typeof globalThis.require,
      })),
      { bridge: 'object', process: 'undefined', require: 'undefined' },
    );
    const info = await page.evaluate(() => window.disrunnerDesktop.getRuntimeInfo());
    assert.equal(info.packaged, true);
    assert.equal(info.offline, true);
    const packageIdentity = await application.evaluate(async ({ app }) => {
      const fs = await import('node:fs/promises');
      const crypto = await import('node:crypto');
      const path = await import('node:path');
      const appPath = app.getAppPath();
      const files = {};
      async function walk(relative) {
        for (const item of await fs.readdir(path.join(appPath, relative), {
          withFileTypes: true,
        })) {
          const name = path.join(relative, item.name);
          if (item.isDirectory()) await walk(name);
          else
            files[name] = crypto
              .createHash('sha256')
              .update(await fs.readFile(path.join(appPath, name)))
              .digest('hex');
        }
      }
      for (const directory of [
        'dist',
        'dist-electron',
        'node_modules/@disrunner/runtime/dist',
        'node_modules/@disrunner/core/dist',
      ])
        await walk(directory);
      return {
        appPath,
        execPath: process.execPath,
        electron: process.versions.electron,
        node: process.versions.node,
        files,
      };
    });
    for (const [relative, hash] of Object.entries(packageIdentity.files)) {
      const local = relative.startsWith('node_modules/@disrunner/')
        ? path.join(root, relative.replace('node_modules/@disrunner/', 'packages/'))
        : path.join(root, 'apps/desktop', relative);
      assert.equal(await digest(local), hash, `packaged dependency/source mismatch: ${relative}`);
    }
    await save('package-identity.json', {
      ...packageIdentity,
      executableSha256: await digest(executablePath),
      asarSha256: await digest(packageIdentity.appPath),
    });
    let previousMessageIds = [];
    const freshBotContents = () =>
      page
        .locator('.chat-message')
        .evaluateAll(
          (nodes, previous) =>
            nodes
              .filter(
                (node) =>
                  !previous.includes(node.getAttribute('data-message-id')) &&
                  node.querySelector('.chat-avatar.bot'),
              )
              .map((node) => node.querySelector('.message-content').textContent),
          previousMessageIds,
        );
    const freshSuccessfulReplies = () =>
      page
        .locator('.chat-message')
        .evaluateAll(
          (nodes, previous) =>
            nodes
              .filter(
                (node) =>
                  !previous.includes(node.getAttribute('data-message-id')) &&
                  node.querySelector('.chat-avatar.bot') &&
                  node
                    .querySelector('.message-metadata')
                    ?.textContent.startsWith('Signed local callback'),
              )
              .map((node) => node.querySelector('.message-content').textContent),
          previousMessageIds,
        );
    const snapshot = () =>
      bounded(
        page.evaluate(() => window.disrunnerDesktop.getRuntimeState()),
        5000,
        'real bridge snapshot',
      );
    async function capture(label) {
      await writeFile(path.join(output, `${label}.html`), await page.content());
      await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
      await save(`${label}-snapshot.json`, await snapshot());
    }
    async function select(directory, actor, invalid = false) {
      // Error recovery is explicit: changing projects must not bypass retained cleanup.
      if ((await snapshot()).phase === 'error') {
        await page.getByRole('button', { name: 'Retry cleanup', exact: true }).click();
        await until(
          async () => ['ready', 'idle'].includes((await snapshot()).phase),
          'UI cleanup recovery',
        );
      }
      await application.evaluate(async ({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      }, directory);
      await page.keyboard.press('Alt+Digit6');
      await page.getByRole('button', { name: 'Runtime paths', exact: true }).click();
      await page.getByRole('button', { name: 'Browse', exact: true }).click();
      await until(
        async () => (await snapshot()).phase === (invalid ? 'error' : 'ready'),
        'UI project selection',
      );
      if (invalid) {
        assert.equal((await snapshot()).pid, null);
        return;
      }
      await page.keyboard.press('Alt+Digit1');
      const actorSelect = page.getByRole('combobox', { name: 'Invocation actor' });
      assert.equal(await actorSelect.inputValue(), actor);
      assert.equal(await actorSelect.locator('option').count(), 1, 'one loaded user only');
      previousMessageIds = await page
        .locator('.chat-message')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')));
      // Capture existing history in both channels; selecting projects does not clear it.
      for (const id of ['2000', '2001']) {
        const button = page.getByRole('button', { name: id, exact: true });
        if (await button.count()) {
          await button.click();
          previousMessageIds.push(
            ...(await page
              .locator('.chat-message')
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')))),
          );
        }
      }
      const first = page.getByRole('button', { name: '2000', exact: true });
      if (await first.count()) await first.click();
    }
    async function start() {
      await page.getByRole('button', { name: 'Start bot', exact: true }).click();
      await until(async () => (await snapshot()).phase === 'running', 'UI Start bot');
      const state = await snapshot();
      assert.equal(typeof state.pid, 'number');
      assert.ok(state.endpoints);
      const proc =
        process.platform === 'linux' ? await readFile(`/proc/${state.pid}/stat`, 'utf8') : null;
      await save(`child-${state.runId}.json`, {
        pid: state.pid,
        runId: state.runId,
        endpoints: state.endpoints,
        proc,
      });
      return state;
    }
    async function send() {
      await page.getByRole('button', { name: '2001', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Message #2001', exact: true });
      await composer.fill('/ping');
      await composer.press('Enter');
    }
    async function stop(directory) {
      await page.getByRole('button', { name: /^(Stop bot|Retry cleanup)$/u }).click();
      await until(async () => (await snapshot()).phase === 'ready', 'UI Stop bot');
      await released(directory);
    }
    // Each negative response is authenticated; the canonical expectation is never rewritten.
    for (const mode of Object.keys(expected)) {
      const directory = await project(`gui-${mode}`, mode);
      if (mode === 'missing-executable') {
        await select(directory, '3000', true);
        assert.deepEqual(await trace(directory), [], 'invalid selection must never launch child');
        await capture('gui-missing-executable');
        results.push({ surface: 'packaged-electron', mode, outcome: 'pre-spawn rejection' });
        continue;
      }
      await select(directory, '3000');
      if (mode.startsWith('exit-startup-')) {
        await page.getByRole('button', { name: 'Start bot', exact: true }).click();
        await until(async () => (await snapshot()).phase === 'error', 'pre-ready exit');
        assert.deepEqual(await freshBotContents(), []);
        await released(directory);
      } else if (mode === 'stalled-startup') {
        await page.getByRole('button', { name: 'Start bot', exact: true }).click();
        await until(
          async () => (await trace(directory)).some((event) => event.event === 'readiness'),
          'pending real readiness',
        );
        await stop(directory);
        assert.deepEqual(await freshBotContents(), []);
      } else {
        await start();
        await send();
        await until(
          async () => (await trace(directory)).some((event) => event.event === 'command'),
          'signed UI command',
        );
        if (mode === 'delayed-reply') {
          await page.getByRole('button', { name: '2000', exact: true }).click();
          await until(
            async () => (await trace(directory)).some((event) => event.event === 'callback'),
            'delayed callback',
          );
          assert.deepEqual(await freshBotContents(), []);
          await page.getByRole('button', { name: '2001', exact: true }).click();
          await until(
            async () => (await freshBotContents()).includes(canonical),
            'new exact delayed reply',
          );
          assert.deepEqual(await freshBotContents(), [canonical]);
          await page.getByRole('button', { name: '2000', exact: true }).click();
          assert.deepEqual(
            await freshBotContents(),
            [],
            'resolved reply cannot belong to first channel',
          );
          await page.getByRole('button', { name: '2001', exact: true }).click();
        } else if (mode === 'pong-only') {
          await until(
            async () => (await freshBotContents()).length > 0,
            'visible rejected command',
          );
          assert.deepEqual(await freshSuccessfulReplies(), []);
          assert.equal((await freshBotContents()).includes(canonical), false);
          assert.ok((await snapshot()).traces.some((item) => item.status === 'error'));
        } else if (mode !== 'stalled-command') {
          const actual = mode === 'wrong-safe' ? 'Different G1 reply.' : canonical;
          await until(
            async () => (await freshBotContents()).includes(actual),
            'new exact authenticated reply',
          );
          assert.deepEqual(await freshBotContents(), [actual]);
          assert.equal(
            (await freshBotContents())[0] === canonical,
            mode !== 'wrong-safe',
            'fixed whole-response parity assertion',
          );
        }
        if (mode === 'stalled-command')
          await until(
            async () => (await trace(directory)).some((event) => event.event === 'body-started'),
            'pending partial command body',
          );
        const command = (await trace(directory)).find((event) => event.event === 'command');
        assert.deepEqual(
          [command.guildId, command.channelId, command.actorId],
          ['1000', '2001', '3000'],
        );
        await capture(`gui-${mode}-before-stop`);
        await stop(directory);
        if (mode === 'stalled-command')
          assert.deepEqual(
            await freshSuccessfulReplies(),
            [],
            'stopped pending command cannot create success',
          );
      }
      await capture(`gui-${mode}-finished`);
      results.push({
        surface: 'packaged-electron',
        mode,
        outcome: 'control-passed',
        expectedContent: canonical,
        actualNewBotContents: await freshBotContents(),
        canonicalParityExpected: ['normal', 'delayed-reply'].includes(mode),
      });
    }
    // Restart while a delayed old invocation is pending, then replace with actor B's project.
    const oldProject = await project('gui-restart-a', 'delayed-reply');
    await select(oldProject, '3000');
    const old = await start();
    await send();
    await until(
      async () => (await trace(oldProject)).some((event) => event.event === 'command'),
      'old invocation pending',
    );
    await stop(oldProject);
    const nextProject = await project('gui-restart-b', 'normal', 'b');
    await select(nextProject, '3001');
    const next = await start();
    assert.notEqual(next.runId, old.runId);
    await page.getByRole('button', { name: '2001', exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(
      await freshBotContents(),
      [],
      'stale run cannot add a reply to replacement project',
    );
    await send();
    await until(async () => (await freshBotContents()).includes(canonical), 'actor-B exact reply');
    assert.deepEqual(await freshBotContents(), [canonical]);
    const command = (await trace(nextProject)).find((event) => event.event === 'command');
    assert.deepEqual(
      [command.actorId, command.guildId, command.channelId],
      ['3001', '1000', '2001'],
    );
    await capture('gui-restart-b');
    await stop(nextProject);
    // Original raw example is a separate unchanged project, not copied/mutated source.
    await select(path.join(root, 'examples/raw-webhook-bot'), '3000');
    await start();
    const composer = page.getByRole('textbox', { name: 'Message #2000', exact: true });
    await composer.fill('/ping');
    await composer.press('Enter');
    await until(
      async () => (await freshBotContents()).includes('Pong! Offline and deterministic.'),
      'unchanged raw reply',
    );
    assert.deepEqual(await freshBotContents(), ['Pong! Offline and deterministic.']);
    await capture('gui-unchanged-raw');
    await page.getByRole('button', { name: 'Stop bot', exact: true }).click();
    await until(async () => (await snapshot()).phase === 'ready', 'raw control stop');
    results.push({
      surface: 'packaged-electron',
      mode: 'actor-b-restart-and-unchanged-raw',
      outcome: 'control-passed',
    });
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, 'first-gui-failure.png') }).catch(() => {});
      await writeFile(path.join(output, 'first-gui-failure.html'), await page.content()).catch(
        () => {},
      );
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
    try {
      await bounded(application.close(), 5000, 'Electron close');
    } catch (error) {
      contained = true;
      application.process().kill('SIGKILL');
      await save('electron-close-failure.json', { message: error.message, containment: true });
      process.exitCode = 1;
    }
  }
  assert.equal(contained, false, 'watchdog containment cannot count as parity');
}
try {
  for (const mode of Object.keys(expected)) await cli(await project(`cli-${mode}`, mode), mode);
  await cli(await project('cli-actor-b', 'normal', 'b'), 'normal', 'b');
  await cli(
    path.join(root, 'examples/raw-webhook-bot'),
    'normal',
    'a',
    path.join(root, 'apps/cli/tests/fixtures/bot-test/case-pass.json'),
  );
  if (cliOnly) identity.pending.push('real GUI explicitly not run (--cli-only); CLI is not parity');
  else await gui();
} catch (error) {
  await save('first-failure.json', {
    message: error.message,
    stack: error.stack,
    containmentPolicy:
      'Parent-process termination is not process-tree cleanup evidence. Any containment requires independent survivor investigation before acceptance.',
  });
  process.exitCode = 1;
} finally {
  await save('results.json', {
    identity,
    results,
    harnessMatrixPassed: process.exitCode !== 1,
    guiMatrixPassed: !cliOnly && process.exitCode !== 1,
    completeParity: false, // Stronger late-success stale-result qualification remains pending.
  });
}
