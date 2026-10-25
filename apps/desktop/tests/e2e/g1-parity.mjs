// Real packaged Electron UI + executable CLI. No bridge substitution or live-host probes.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { strictExpected, assertStrictMutation, assertStrictDenial } from './g1-strict-oracle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const corpus = path.join(root, 'apps/desktop/tests/fixtures/g1-parity');
const strictCorpus = path.join(root, 'apps/desktop/tests/fixtures/g1-strict-permissions');
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
// Verify Retry, recovered Start, and inspector keyboard transitions.
// These are not a generated full-app tab-order oracle.
const uxExpected = {
  contentSize: [720, 640],
  minimumEnabledTextContrast: 4.5,
  retry: [
    ['Tab', 'Close window'],
    ['Shift+Tab', 'Retry cleanup'],
  ],
  recovered: [
    ['Tab', 'Close window'],
    ['Shift+Tab', 'Start bot'],
  ],
  inspector: [
    ['Tab', 'Expand inspector'],
    ['Shift+Tab', 'Insert emoji'],
    ['Tab', 'Expand inspector'],
    ['Enter', 'Collapse inspector'],
    ['Tab', 'Trace', 'tab'],
    ['Tab', 'Payload', 'tab'],
    ['Tab', 'State Diff', 'tab'],
    ['Tab', 'Permissions', 'tab'],
    ['Tab', 'Rate Limits', 'tab'],
    ['Tab', 'Risks', 'tab'],
    ['Shift+Tab', 'Rate Limits', 'tab'],
    ['Shift+Tab', 'Permissions', 'tab'],
    ['Shift+Tab', 'State Diff', 'tab'],
    ['Shift+Tab', 'Payload', 'tab'],
    ['Shift+Tab', 'Trace', 'tab'],
    ['Shift+Tab', 'Collapse inspector'],
    ['Space', 'Expand inspector'],
    ['Shift+Tab', 'Insert emoji'],
    ['Tab', 'Expand inspector'],
  ],
};
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
  JSON.stringify({ expected, canonical, uxExpected, strictExpected }, null, 2),
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
  strictFixtures: await hashTree(strictCorpus),
  strictOracleSha256: await digest(path.join(root, 'apps/desktop/tests/e2e/g1-strict-oracle.mjs')),
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
  let browserWindow;
  let contained = false;
  const watchdog = setTimeout(() => {
    contained = true;
    application.process().kill('SIGKILL');
  }, 180000);
  try {
    page = await bounded(application.firstWindow(), 15000, 'first real renderer');
    browserWindow = await application.browserWindow(page);
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
      // Inspector evaluation has no ESM import hook; load builtins from the main process.
      const fs = process.getBuiltinModule('fs/promises');
      const crypto = process.getBuiltinModule('crypto');
      const path = process.getBuiltinModule('path');
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
    const visibleMessageContents = () =>
      page.locator('.chat-message:not(.ephemeral):visible .message-content').allTextContents();
    async function visibleInspector(check) {
      const expand = page.getByRole('button', { name: 'Expand inspector', exact: true });
      const restoreCollapsed = (await expand.count()) === 1;
      if (restoreCollapsed) await expand.click();
      try {
        await page.getByRole('tab', { name: 'Trace', exact: true }).click();
        return await check();
      } finally {
        if (restoreCollapsed)
          await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
      }
    }
    async function expectNoDiagnostics() {
      await visibleInspector(async () => {
        const empty = page.getByRole('tabpanel');
        await until(
          async () =>
            (await empty.isVisible()) &&
            (await empty.textContent()) === 'No invocation diagnostics for this context.',
          'visible empty invocation diagnostics',
        );
        assert.equal(await page.locator('.outcome-panel:visible').count(), 0);
      });
    }
    const diagnosticRequestIds = new Set();
    async function expectDiagnostic(
      content,
      actor = '3000',
      channel = '2001',
      failed = false,
      command = '/ping',
    ) {
      return visibleInspector(async () => {
        const details = page
          .locator('.outcome-panel section')
          .filter({
            has: page.getByRole('heading', { name: 'Details', exact: true }),
          })
          .locator('p');
        await until(async () => {
          if (!(await details.isVisible())) return false;
          const visibleCommand = page.locator('.trace-details dd').first();
          if (
            !(await visibleCommand.isVisible()) ||
            (await visibleCommand.textContent()) !== command
          )
            return false;
          const actual = await details.textContent();
          return content instanceof RegExp ? content.test(actual) : actual === content;
        }, 'visible exact callback diagnostic');
        const actual = await details.textContent();
        assert.equal(
          await page.locator('.outcome-badge:visible').textContent(),
          failed ? 'Denied' : 'Passed',
        );
        await page.getByRole('tab', { name: 'Payload', exact: true }).click();
        const payloadElement = page.locator('.payload-view pre code');
        assert.equal(await payloadElement.isVisible(), true);
        const payload = JSON.parse(await payloadElement.textContent());
        assert.deepEqual(
          [payload.actorId, payload.guildId, payload.channelId],
          [actor, '1000', channel],
        );
        assert.equal(payload.command, command);
        assert.equal(typeof payload.requestId, 'string');
        assert.ok(payload.requestId.length > 0);
        assert.equal(
          diagnosticRequestIds.has(payload.requestId),
          false,
          'each invocation must expose its own diagnostic',
        );
        diagnosticRequestIds.add(payload.requestId);
        assert.equal(payload.signed, !failed);
        assert.equal(payload.runId, (await snapshot()).runId);
        await page.getByRole('tab', { name: 'Trace', exact: true }).click();
        return actual;
      });
    }
    const snapshot = () =>
      bounded(
        page.evaluate(() => window.disrunnerDesktop.getRuntimeState()),
        5000,
        'real bridge snapshot',
      );
    async function metrics() {
      return {
        native: await browserWindow.evaluate((window) => ({
          bounds: window.getBounds(),
          contentBounds: window.getContentBounds(),
          contentSize: window.getContentSize(),
          minimumOuterSize: window.getMinimumSize(),
          zoomFactor: window.webContents.getZoomFactor(),
        })),
        renderer: await page.evaluate(() => ({
          innerWidth,
          innerHeight,
          devicePixelRatio,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
        })),
      };
    }
    async function capture(label, viewportOnly = false) {
      const html = await page.content();
      await writeFile(path.join(output, `${label}.html`), html);
      const png = await page.screenshot({
        path: path.join(output, `${label}.png`),
        fullPage: !viewportOnly,
      });
      const state = await snapshot();
      await save(`${label}-snapshot.json`, state);
      await save(`${label}-evidence.json`, {
        screenshotSha256: createHash('sha256').update(png).digest('hex'),
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        snapshotSha256: await digest(path.join(output, `${label}-snapshot.json`)),
        viewportOnly,
        window: await metrics(),
      });
      return png;
    }
    async function compact(check) {
      const original = await browserWindow.evaluate((window) => window.getContentSize());
      try {
        await browserWindow.evaluate(
          (window, size) => window.setContentSize(...size),
          uxExpected.contentSize,
        );
        await until(async () => {
          const measured = await metrics();
          return measured.renderer.innerWidth === 720 && measured.renderer.innerHeight === 640;
        }, 'actual Electron 720x640 content size');
        const measured = await metrics();
        await save('ux-native-window.json', {
          ...measured,
          scope: 'actual Electron 720x640 content viewport, not minimum outer window bounds',
          minimumOuterWindowCase: 'unverified: no separate minimum-outer-bounds run',
        });
        assert.deepEqual(measured.native.contentSize, uxExpected.contentSize);
        assert.equal(measured.native.contentBounds.width, 720);
        assert.equal(measured.native.contentBounds.height, 640);
        assert.ok(measured.renderer.devicePixelRatio > 0);
        await check();
      } catch (error) {
        // Preserve the actual compact failure before restoring the matrix window size.
        await capture('first-compact-failure', true).catch(() => {});
        throw error;
      } finally {
        await browserWindow.evaluate((window, size) => window.setContentSize(...size), original);
        await until(async () => {
          const measured = await metrics();
          return (
            measured.renderer.innerWidth === original[0] &&
            measured.renderer.innerHeight === original[1]
          );
        }, 'restore original Electron content size');
      }
    }
    const control = (name, role = 'button') => page.getByRole(role, { name, exact: true });
    const active = () =>
      page.evaluate(() => {
        const element = document.activeElement;
        return {
          tag: element?.tagName,
          role: element?.getAttribute('role'),
          name: element?.getAttribute('aria-label') ?? element?.textContent?.trim().slice(0, 120),
          disabled: element instanceof HTMLButtonElement ? element.disabled : null,
        };
      });
    async function keys(label, expectations) {
      const observed = [];
      for (const [key, name, role = 'button'] of expectations) {
        await page.keyboard.press(key);
        const target = control(name, role);
        const focused = await target.evaluate((element) => element === document.activeElement);
        observed.push({ key, expected: { name, role }, actual: await active(), focused });
        // Preserve the first incorrect transition, not just the final traversal.
        await save(`${label}-keyboard.json`, { expectations, observed, fullAppOrderClaim: false });
        assert.equal(focused, true, `${label}: ${key} must focus ${name}`);
        assert.equal(await target.isEnabled(), true, `${name} must be enabled`);
        if (name === 'Expand inspector' || name === 'Collapse inspector') {
          assert.equal(
            await target.getAttribute('aria-expanded'),
            name === 'Collapse inspector' ? 'true' : 'false',
          );
          if (name === 'Expand inspector')
            assert.equal(
              await page.getByRole('tab').count(),
              0,
              'collapsed inspector tabs must be hidden from accessible traversal',
            );
        }
      }
    }
    let reachabilityMessageId = null;
    async function reachability(label) {
      const disclosure = control('Expand inspector');
      const collapsed = (await disclosure.count()) === 1;
      const runtimePanel = await page.locator('.runtime-panel').evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        capExercised: element.scrollHeight > element.clientHeight,
      }));
      const targets = [
        reachabilityMessageId === null
          ? ['feed-status', page.getByRole('status', { name: 'Live message feed status' })]
          : [
              'message',
              page.locator(
                `.chat-message[data-message-id="${reachabilityMessageId}"] .message-content`,
              ),
            ],
        ['composer', page.locator('.composer input')],
      ];
      if (await page.locator('#invocation-unavailable').count())
        targets.push(['explanation', page.locator('#invocation-unavailable')]);
      const observations = [];
      for (const [name, locator] of targets) {
        await locator.scrollIntoViewIfNeeded();
        const geometry = await locator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          let left = Math.max(0, rect.left),
            right = Math.min(innerWidth, rect.right);
          let top = Math.max(0, rect.top),
            bottom = Math.min(innerHeight, rect.bottom);
          const clips = [];
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const box = ancestor.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) {
              left = Math.max(left, box.left);
              right = Math.min(right, box.right);
            }
            if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) {
              top = Math.max(top, box.top);
              bottom = Math.min(bottom, box.bottom);
            }
            if (/(auto|scroll|hidden|clip)/u.test(`${style.overflowX} ${style.overflowY}`))
              clips.push({
                className: ancestor.className,
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                clientHeight: ancestor.clientHeight,
                scrollHeight: ancestor.scrollHeight,
              });
          }
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible: { width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
            centerUnoccluded: hit === element || element.contains(hit),
            documentWidth: document.documentElement.scrollWidth,
            innerWidth,
            clips,
            messageId: element.closest('.chat-message')?.getAttribute('data-message-id') ?? null,
          };
        });
        observations.push({ name, geometry });
        await capture(`${label}-${name}`, true);
        await save(`${label}-reachability.json`, {
          collapsed,
          runtimePanel,
          observations,
          messageProvenance:
            reachabilityMessageId === null
              ? 'visible retained-feed availability status; callbacks are diagnostics, not chat rows'
              : 'ordinary message created by authenticated REST in the current run',
          classification: runtimePanel.capExercised
            ? 'observed capped runtime overflow'
            : 'actual recovery height observed; maximum-height recovery case not proven',
          method: 'each actual target scroll-reachable; not a simultaneous-visibility claim',
        });
        assert.ok(geometry.rect.width > 0 && geometry.rect.height > 0);
        assert.ok(
          geometry.visible.width >= geometry.rect.width - 1,
          `${label}: ${name} must not be horizontally clipped`,
        );
        assert.ok(
          geometry.visible.height >= geometry.rect.height - 1,
          `${label}: ${name} must be vertically scroll-reachable`,
        );
        assert.equal(geometry.centerUnoccluded, true, `${label}: ${name} must not be obscured`);
        assert.ok(
          geometry.documentWidth <= geometry.innerWidth + 1,
          `${label}: root horizontal overflow`,
        );
      }
    }
    async function contrast(name, label) {
      const button = control(name);
      await until(() => button.isEnabled(), `${name} enabled before contrast`);
      assert.equal(await button.isEnabled(), true);
      for (const hover of [false, true]) {
        if (hover) await button.hover();
        else await page.mouse.move(718, 638);
        const painted = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const box = (value) => ({
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
          });
          const foreground = [...element.querySelectorAll('svg')].map((icon) =>
            box(icon.getBoundingClientRect()),
          );
          const textRanges = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            const rectangles = [...range.getClientRects()].map(box);
            foreground.push(...rectangles);
            textRanges.push(...rectangles);
          }
          const style = getComputedStyle(element);
          return {
            rect: box(rect),
            foreground,
            textRanges,
            color: style.color,
            opacity: style.opacity,
            background: style.backgroundImage,
            hovered: element.matches(':hover'),
            disabled: element.disabled,
            innerWidth,
            innerHeight,
            devicePixelRatio,
          };
        });
        const artifact = `${label}-${hover ? 'hover' : 'default'}`;
        const png = await capture(artifact, true);
        const pixels = await page.evaluate(
          async ({ encoded, painted }) => {
            // Decode the actual native screenshot, without dependencies or an on-page image.
            const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0);
            const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
            const scaleX = bitmap.width / painted.innerWidth;
            const scaleY = bitmap.height / painted.innerHeight;
            const samples = [];
            const luminance = (rgb) =>
              rgb
                .map((byte) => {
                  const value = byte / 255;
                  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            // Every interior gradient row, excluding rounded corners, text and icons.
            for (
              let y = Math.ceil((painted.rect.top + 1.5) * scaleY);
              y < (painted.rect.bottom - 1.5) * scaleY;
              y++
            ) {
              const cssY = (y + 0.5) / scaleY;
              const margin =
                cssY > painted.rect.top + 7 && cssY < painted.rect.bottom - 7 ? 2.5 : 7;
              for (
                let x = Math.ceil((painted.rect.left + margin) * scaleX);
                x < (painted.rect.right - margin) * scaleX;
                x++
              ) {
                const cssX = (x + 0.5) / scaleX;
                if (
                  painted.foreground.some(
                    (rect) =>
                      cssX >= rect.left - 1.5 &&
                      cssX <= rect.right + 1.5 &&
                      cssY >= rect.top - 1.5 &&
                      cssY <= rect.bottom + 1.5,
                  )
                )
                  continue;
                const offset = (y * bitmap.width + x) * 4;
                const rgb = [...data.slice(offset, offset + 3)];
                samples.push({
                  x,
                  y,
                  rgb,
                  alpha: data[offset + 3],
                  contrastAgainstWhite: 1.05 / (luminance(rgb) + 0.05),
                });
              }
            }
            samples.sort((a, b) => a.contrastAgainstWhite - b.contrastAgainstWhite);
            const textRowCoverage = [];
            for (
              let y = Math.floor(painted.rect.top * scaleY);
              y < painted.rect.bottom * scaleY;
              y++
            ) {
              const cssY = (y + 0.5) / scaleY;
              if (painted.textRanges.some((rect) => cssY >= rect.top && cssY <= rect.bottom))
                textRowCoverage.push({
                  y,
                  backgroundSampleCount: samples.filter((sample) => sample.y === y).length,
                });
            }
            const result = {
              width: bitmap.width,
              height: bitmap.height,
              scaleX,
              scaleY,
              textRowCoverage,
              uncoveredTextRows: textRowCoverage.filter((row) => row.backgroundSampleCount === 0),
              count: samples.length,
              worst: samples[0],
              sampledRows: [...new Set(samples.map((sample) => sample.y))],
              opaque: samples.every((sample) => sample.alpha === 255),
              backgroundColors: [...new Set(samples.map((sample) => sample.rgb.join(',')))],
            };
            bitmap.close();
            return result;
          },
          { encoded: png.toString('base64'), painted },
        );
        await save(`${artifact}-contrast.json`, {
          name,
          painted,
          pixels,
          threshold: uxExpected.minimumEnabledTextContrast,
          screenshot: `${artifact}.png`,
          scope: 'actual screenshot background vs computed white text; glyph pixels not sampled',
          gradientEndpointCalculation: 'separate source-level evidence, not this measurement',
        });
        assert.equal(painted.disabled, false);
        assert.equal(painted.hovered, hover);
        assert.equal(painted.color, 'rgb(255, 255, 255)');
        assert.equal(painted.opacity, '1');
        assert.ok(
          Math.abs(pixels.scaleX - pixels.scaleY) <=
            Math.max(1 / painted.innerWidth, 1 / painted.innerHeight),
        );
        assert.ok(Math.abs(pixels.scaleX - painted.devicePixelRatio) < 0.01);
        assert.ok(pixels.count > 0 && pixels.sampledRows.length >= 10);
        assert.equal(pixels.opaque, true);
        assert.ok(pixels.textRowCoverage.length > 0);
        assert.deepEqual(
          pixels.uncoveredTextRows,
          [],
          'each text-height row needs an adjacent unobscured background sample',
        );
        assert.ok(
          pixels.worst.contrastAgainstWhite >= uxExpected.minimumEnabledTextContrast,
          `${name} ${hover ? 'hover' : 'default'} screenshot text contrast below 4.5`,
        );
      }
    }
    async function inspectorUx(label) {
      const composer = page.locator('.composer input');
      await composer.fill('');
      assert.equal(await control('Send local event').isDisabled(), true);
      // Diagnostic checks can leave focus inside the wide inspector. Compact resizing
      // intentionally expands it to preserve that focus; establish this oracle's baseline
      // through the visible disclosure before its single keyboard anchor below.
      const collapse = control('Collapse inspector');
      if ((await collapse.count()) === 1) {
        assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
        await collapse.click();
      }
      const disclosure = control('Expand inspector');
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      const controlledId = await disclosure.getAttribute('aria-controls');
      assert.ok(controlledId);
      assert.equal(
        await page.evaluate((id) => document.getElementById(id) !== null, controlledId),
        true,
      );
      await reachability(`${label}-collapsed`);
      // Exactly one initial anchor; every asserted transition below uses native keys.
      await control('Insert emoji').focus();
      await keys(`${label}-inspector-forward`, uxExpected.inspector.slice(0, 10));
      assert.equal(await control('Collapse inspector').getAttribute('aria-controls'), controlledId);
      await reachability(`${label}-expanded`);
      // Scrolling observations do not change the native focus left on Risks.
      assert.equal(
        await control('Risks', 'tab').evaluate((element) => element === document.activeElement),
        true,
      );
      await keys(`${label}-inspector-reverse`, uxExpected.inspector.slice(10));
      assert.equal(await control('Expand inspector').getAttribute('aria-controls'), controlledId);
    }
    async function retryUx(directory) {
      await until(() => control('Retry cleanup').isEnabled(), 'Route A Retry enabled');
      const before = await snapshot();
      assert.equal(before.phase, 'error');
      assert.ok(before.runId);
      assert.equal(await control('Start bot').isDisabled(), true);
      assert.equal(await control('Retry cleanup').isEnabled(), true);
      await contrast('Retry cleanup', 'ux-retry');
      await inspectorUx('ux-recovery');
      await control('Retry cleanup').focus(); // One H2 initial anchor, not restoration.
      await keys('ux-retry-before', uxExpected.retry);
      await capture('ux-retry-before-activation', true);
      await page.evaluate(() => {
        const records = [];
        const record = (kind, detail = null) => {
          const focused = document.activeElement;
          const retry = document.querySelector('.runner-controls .stop-button');
          const start = document.querySelector('.runner-controls .start-button');
          if (records.length < 256)
            records.push({
              kind,
              detail,
              at: performance.now(),
              active: {
                tag: focused?.tagName,
                name:
                  focused?.getAttribute('aria-label') ?? focused?.textContent?.trim().slice(0, 120),
              },
              retryDisabled: retry?.disabled,
              retryLabel: retry?.textContent?.trim(),
              startDisabled: start?.disabled,
              notice: document.querySelector('.runtime-recovery')?.textContent?.trim(),
            });
        };
        const observer = new MutationObserver(() => record('dom-change'));
        observer.observe(document.querySelector('.app-shell'), {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['disabled', 'hidden'],
        });
        const events = ['focusin', 'focusout', 'keydown', 'pointerdown'];
        const onEvent = (event) => record(event.type, event.key ?? null);
        for (const event of events) document.addEventListener(event, onEvent, true);
        const onBlur = () => record('window-blur');
        window.addEventListener('blur', onBlur);
        const unsubscribe = window.disrunnerDesktop.onRuntimeState((event) =>
          record('bridge-event', event),
        );
        record('armed');
        window.__g1RetryObservation = () => {
          record('finished');
          observer.disconnect();
          unsubscribe();
          for (const event of events) document.removeEventListener(event, onEvent, true);
          window.removeEventListener('blur', onBlur);
          return records;
        };
      });
      let after, observation;
      try {
        await page.keyboard.press('Enter'); // Actual focused, enabled Retry operation.
        await until(async () => (await snapshot()).phase === 'ready', 'Route A Retry cleanup');
        await until(async () => await control('Start bot').isEnabled(), 'Retry result rendered');
        after = await snapshot();
      } finally {
        observation = await page.evaluate(() => {
          const records = window.__g1RetryObservation();
          delete window.__g1RetryObservation;
          return records;
        });
        await save('ux-retry-operation.json', {
          before,
          after: after ?? (await snapshot()),
          observation,
          pendingDisabled: observation.some(
            (item) =>
              item.retryDisabled &&
              item.startDisabled &&
              item.notice?.includes('Checking runtime cleanup'),
          )
            ? 'observed'
            : 'unobserved: no pending disabled interval exposed to observer',
          nativeDisabledFocusLoss: observation.some(
            (item) => item.retryDisabled && item.active.tag === 'BODY',
          )
            ? 'observed'
            : 'unobserved: no native body-focus loss observed',
          cancellationBranches: 'unobserved: no artificial in-flight interval or focus loss',
          routeB: 'blocked/unobserved: no authorized production injection route',
          completeKeyboardAcceptance: false,
        });
      }
      await capture('ux-retry-after-activation', true);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.runId, before.runId);
      assert.ok(after.revision > before.revision);
      assert.equal(after.disposed, false);
      assert.equal(after.error, null);
      assert.equal(
        await control('Start bot').evaluate(
          (element) => element === document.activeElement && !element.disabled,
        ),
        true,
        'eligible confirmed Retry success must restore enabled Start',
      );
      await keys('ux-retry-after', uxExpected.recovered);
      await released(directory);
      results.push({
        surface: 'packaged-electron',
        mode: 'compact-route-a-ux',
        outcome: 'asserted-local-sequences-and-settled-focus-passed',
        pendingDisableObserved: observation.some(
          (item) => item.retryDisabled && item.notice?.includes('Checking runtime cleanup'),
        ),
        contentViewport: [720, 640],
        minimumOuterWindowCase: 'unverified',
        fullKeyboardAcceptance: false,
        routeB: 'blocked/unobserved',
      });
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
      await page.getByRole('button', { name: 'Browse folders', exact: true }).click();
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
      assert.deepEqual(
        await visibleMessageContents(),
        [],
        'project selection clears retained feed',
      );
      const first = page.locator('.channel-row[data-channel-id="2000"]');
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
    async function send(command = '/ping') {
      await page.locator('.channel-row[data-channel-id="2001"]').click();
      const composer = page.locator('.composer input');
      await composer.fill(command);
      await composer.press('Enter');
    }
    async function stop(directory) {
      await page.getByRole('button', { name: /^(Stop bot|Retry cleanup)$/u }).click();
      await until(async () => (await snapshot()).phase === 'ready', 'UI Stop bot');
      await released(directory);
      assert.deepEqual(await visibleMessageContents(), [], 'stopped runtime clears retained feed');
      assert.match(
        await page.getByRole('status', { name: 'Live message feed status' }).textContent(),
        /Live messages unavailable/u,
      );
      await expectNoDiagnostics();
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
      if (mode === 'normal') await compact(() => contrast('Start bot', 'ux-start'));
      if (mode === 'exit-startup-0')
        await page.locator('.channel-row[data-channel-id="2001"]').click();
      if (mode.startsWith('exit-startup-')) {
        await page.getByRole('button', { name: 'Start bot', exact: true }).click();
        await until(async () => (await snapshot()).phase === 'error', 'pre-ready exit');
        assert.deepEqual(await visibleMessageContents(), []);
        await released(directory);
        if (mode === 'exit-startup-0') await compact(() => retryUx(directory));
      } else if (mode === 'stalled-startup') {
        await page.getByRole('button', { name: 'Start bot', exact: true }).click();
        await until(
          async () => (await trace(directory)).some((event) => event.event === 'readiness'),
          'pending real readiness',
        );
        await stop(directory);
        assert.deepEqual(await visibleMessageContents(), []);
      } else {
        await start();
        await send();
        await until(
          async () => (await trace(directory)).some((event) => event.event === 'command'),
          'signed UI command',
        );
        if (mode === 'delayed-reply') {
          await page.locator('.channel-row[data-channel-id="2000"]').click();
          await until(
            async () => (await trace(directory)).some((event) => event.event === 'callback'),
            'delayed callback',
          );
          assert.deepEqual(await visibleMessageContents(), []);
          await page.locator('.channel-row[data-channel-id="2001"]').click();
          // Completion was observed in the real child's trace before switching back.
          // Returning to the old context must not restore its discarded diagnostics.
          await expectNoDiagnostics();
          await new Promise((resolve) => setTimeout(resolve, 150));
          await expectNoDiagnostics();
          assert.deepEqual(
            await visibleMessageContents(),
            ['G1 parity reply.'],
            'the delayed public reply is committed in the channel it was sent from',
          );
          await send();
          await expectDiagnostic(canonical);
          assert.deepEqual(
            await visibleMessageContents(),
            ['G1 parity reply.', 'G1 parity reply.'],
            'each public reply appears once in send order',
          );
          const delayedIds = await page
            .locator('.chat-message:visible')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')));
          assert.equal(delayedIds.length, 2);
          assert.notEqual(delayedIds[0], delayedIds[1], 'two replies keep distinct message ids');
        } else if (mode === 'pong-only') {
          // Existing UI labels this deadline failure Denied; it is not a permission denial.
          await expectDiagnostic(/Interaction deadline exceeded\./u, '3000', '2001', true);
          assert.deepEqual(await visibleMessageContents(), []);
          assert.ok((await snapshot()).traces.some((item) => item.status === 'error'));
        } else if (mode !== 'stalled-command') {
          const expectedDiagnostic = mode === 'wrong-safe' ? 'Different G1 reply.' : canonical;
          const actual = await expectDiagnostic(expectedDiagnostic);
          assert.deepEqual(
            await visibleMessageContents(),
            [mode === 'wrong-safe' ? 'Different G1 reply.' : 'G1 parity reply.'],
            'a public reply appears once in the feed',
          );
          assert.equal(
            actual === canonical,
            mode !== 'wrong-safe',
            'fixed diagnostic parity assertion',
          );
        }
        if (mode === 'stalled-command') {
          await until(
            async () => (await trace(directory)).some((event) => event.event === 'body-started'),
            'pending partial command body',
          );
          assert.deepEqual(
            await visibleMessageContents(),
            [],
            'an incomplete reply is never committed',
          );
        }
        const command = (await trace(directory)).find((event) => event.event === 'command');
        assert.deepEqual(
          [command.guildId, command.channelId, command.actorId],
          ['1000', '2001', '3000'],
        );
        if (mode === 'normal')
          await compact(async () => {
            await contrast('Stop bot', 'ux-stop');
            await inspectorUx('ux-running');
          });
        await capture(`gui-${mode}-before-stop`);
        await stop(directory);
        if (mode === 'stalled-command')
          assert.deepEqual(
            await visibleMessageContents(),
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
        visibleOrdinaryMessageContents: await visibleMessageContents(),
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
    await page.locator('.channel-row[data-channel-id="2001"]').click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(
      await visibleMessageContents(),
      [],
      'replacement project starts without ordinary messages',
    );
    await expectNoDiagnostics();
    await send();
    await expectDiagnostic(canonical, '3001');
    assert.deepEqual(
      await visibleMessageContents(),
      ['G1 parity reply.'],
      'the replacement project shows its own public reply once',
    );
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
    const composer = page.locator('.composer input');
    await composer.fill('/ping');
    await composer.press('Enter');
    await expectDiagnostic('Pong! Offline and deterministic.', '3000', '2000');
    assert.deepEqual(
      await visibleMessageContents(),
      ['Pong! Offline and deterministic.'],
      'the unchanged example public reply appears once',
    );
    await capture('gui-unchanged-raw');
    await page.getByRole('button', { name: 'Stop bot', exact: true }).click();
    await until(async () => (await snapshot()).phase === 'ready', 'raw control stop');
    results.push({
      surface: 'packaged-electron',
      mode: 'actor-b-restart-and-unchanged-raw',
      outcome: 'control-passed',
    });
    assert.deepEqual(await visibleMessageContents(), []);
    await expectNoDiagnostics();

    async function selectLiveFixture(label, actor = 'a') {
      const directory = await project(label, 'normal', actor);
      const file = path.join(directory, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(file, 'utf8'));
      config.bot.startCommand = 'node live-feed-bot.mjs';
      config.bot.entryPoint = 'live-feed-bot.mjs';
      await writeFile(file, JSON.stringify(config, null, 2));
      await save(`${label}-fixture.json`, {
        configSha256: await digest(file),
        botSha256: await digest(path.join(directory, 'live-feed-bot.mjs')),
        operationSource: 'real child using its injected synthetic credential in memory',
      });
      await select(directory, actor === 'b' ? '3001' : '3000');
      return directory;
    }
    async function ordinaryOperation(
      directory,
      operation,
      expectedText,
      expectedId,
      actor = '3000',
    ) {
      const before = await snapshot();
      // Unchanged guild roles are intentionally outside the display DTO.
      assert.equal(before.coreState?.truncated, true);
      await send(`/feed-${operation}`);
      await until(
        async () =>
          (await trace(directory)).some(
            (item) => item.event === 'rest-operation' && item.operation === operation,
          ),
        `real REST ${operation}`,
      );
      const events = await trace(directory);
      const record = events.find(
        (item) => item.event === 'rest-operation' && item.operation === operation,
      );
      const bootstrap = events.find((item) => item.event === 'bootstrap');
      const command = events.filter((item) => item.event === 'command').at(-1);
      assert.equal(record.status, operation === 'delete' ? 204 : 200);
      assert.match(record.messageId, /^[1-9][0-9]{0,19}$/u);
      if (expectedId !== undefined) assert.equal(record.messageId, expectedId);
      assert.deepEqual(
        [command.actorId, command.guildId, command.channelId],
        [actor, '1000', '2001'],
      );
      assert.equal(command.applicationIdMatches, true);
      assert.equal(command.applicationId, bootstrap.applicationId);
      assert.equal(record.applicationId, bootstrap.applicationId);
      assert.equal(record.authorId, bootstrap.authorId);
      assert.notEqual(record.authorId, actor, 'ordinary author is the bot, not the invoking human');
      const row = page.locator(`.chat-message[data-message-id="${record.messageId}"]`);
      await until(
        async () =>
          operation === 'delete'
            ? (await row.count()) === 0
            : (await row.count()) === 1 &&
              (await row.isVisible()) &&
              (await row.locator('.message-content').textContent()) === expectedText,
        `visible ordinary ${operation}`,
      );
      assert.deepEqual(
        await visibleMessageContents(),
        operation === 'delete' ? [] : [expectedText],
      );
      if (operation !== 'delete')
        assert.equal(await row.locator('.chat-avatar.bot').isVisible(), true);
      await expectDiagnostic(
        'G1 callback diagnostic only.',
        actor,
        '2001',
        false,
        `/feed-${operation}`,
      );
      assert.equal(
        (await visibleMessageContents()).includes('G1 callback diagnostic only.'),
        false,
      );
      const after = await snapshot();
      assert.equal(after.runId, before.runId);
      assert.equal(after.coreState.runId, after.runId);
      assert.equal(after.coreState.truncated, true);
      assert.ok(
        (
          await page.getByRole('status', { name: 'Live message feed status' }).textContent()
        ).includes('Showing the latest messages. Earlier messages may be omitted.'),
      );
      assert.ok(after.revision > before.revision, 'Session publication revision advances');
      assert.ok(
        record.stateRevision > before.coreState.stateRevision,
        'core mutation revision advances independently',
      );
      assert.ok(after.coreState.stateRevision >= record.stateRevision);
      const retained = after.coreState.resources.filter(
        (item) => item.resourceType === 'message' && item.id === record.messageId,
      );
      if (operation === 'delete') assert.deepEqual(retained, []);
      else {
        assert.equal(retained.length, 1);
        assert.deepEqual(
          [
            retained[0].content,
            retained[0].channel_id,
            retained[0].guild_id,
            retained[0].author.id,
          ],
          [expectedText, '2001', '1000', bootstrap.authorId],
        );
      }
      await save(`ordinary-${actor}-${operation}.json`, {
        ...record,
        runId: after.runId,
        sessionRevision: after.revision,
        coreStateRevision: after.coreState.stateRevision,
        visibleMessageId: operation === 'delete' ? null : record.messageId,
        visibleContent: operation === 'delete' ? null : expectedText,
        callbackWasSeparateDiagnostic: true,
      });
      await capture(`gui-ordinary-${actor}-${operation}`);
      return record.messageId;
    }
    const liveProject = await selectLiveFixture('gui-live-feed');
    const liveRun = await start();
    await expectNoDiagnostics();
    const createdId = await ordinaryOperation(liveProject, 'create', 'G1 public message created.');
    await page.locator('.channel-row[data-channel-id="2000"]').click();
    assert.deepEqual(
      await visibleMessageContents(),
      [],
      'other channel excludes the real ordinary row',
    );
    await expectNoDiagnostics();
    await page.locator('.channel-row[data-channel-id="2001"]').click();
    assert.deepEqual(await visibleMessageContents(), ['G1 public message created.']);
    await expectNoDiagnostics();
    reachabilityMessageId = createdId;
    await compact(() => inspectorUx('ux-live-feed'));
    reachabilityMessageId = null;
    await ordinaryOperation(liveProject, 'edit', 'G1 public message edited.', createdId);
    await ordinaryOperation(liveProject, 'delete', null, createdId);
    await stop(liveProject);
    const replacement = await selectLiveFixture('gui-live-feed-b', 'b');
    const replacementRun = await start();
    assert.notEqual(replacementRun.runId, liveRun.runId);
    assert.deepEqual(await visibleMessageContents(), [], 'new run cannot inherit retained rows');
    await expectNoDiagnostics();
    await ordinaryOperation(replacement, 'create', 'G1 public message created.', undefined, '3001');
    await stop(replacement);
    results.push({
      surface: 'packaged-electron',
      mode: 'ordinary-rest-message-lifecycle',
      outcome: 'control-passed',
      mutationSequence: ['create', 'edit', 'delete'],
      replacementRunCleared: true,
      lateOldRunDeliveryProven: false,
    });

    // Explicit opt-in projects are separate from every legacy control above.
    let previousStrictRun;
    for (const profileCase of ['allow', 'missing-send', 'missing-view']) {
      const label = `gui-strict-${profileCase}`;
      const directory = path.join(output, label);
      await cp(path.join(strictCorpus, profileCase), directory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await cp(
        path.join(strictCorpus, 'strict-feed-bot.mjs'),
        path.join(directory, 'strict-feed-bot.mjs'),
      );
      await cp(path.join(strictCorpus, 'peer-auth.mjs'), path.join(directory, 'peer-auth.mjs'));
      await save(`${label}-fixture.json`, {
        files: await hashTree(directory),
        expected: strictExpected,
        credentials: 'injected by real Session; retained only in child memory',
      });
      await select(directory, '3000');
      // Restart the same selected project as well as replacing projects. Do not copy
      // an old trace into a new run or accept old operation records as fresh evidence.
      for (let attempt = 0; attempt < 2; attempt++) {
        const runLabel = `${label}-${attempt}`;
        if (attempt > 0) await writeFile(path.join(directory, 'child-trace.jsonl'), '');
        const run = await start();
        if (previousStrictRun) assert.notEqual(run.runId, previousStrictRun);
        previousStrictRun = run.runId;
        assert.deepEqual(
          run.coreState.resources.filter((item) => item.resourceType === 'message'),
          [],
        );
        assert.deepEqual(await visibleMessageContents(), []);
        await expectNoDiagnostics();
        let messageId;
        const eventIds = new Set();
        const operations = profileCase === 'allow' ? ['create', 'edit', 'delete'] : ['create'];
        for (const operation of operations) {
          const callbackBefore = await snapshot();
          const beforeRows = await visibleMessageContents();
          await send(`/feed-${operation}`);
          // Ephemeral callbacks commit hidden core resources too. Finish that
          // separate diagnostic before measuring the ordinary HTTP operation.
          await expectDiagnostic(
            'G1 callback diagnostic only.',
            '3000',
            '2001',
            false,
            `/feed-${operation}`,
          );
          await until(
            async () =>
              (await snapshot()).coreState.stateRevision ===
              callbackBefore.coreState.stateRevision + 1,
            'strict callback committed before ordinary operation',
          );
          const before = await snapshot();
          assert.deepEqual(before.coreState.resources, callbackBefore.coreState.resources);
          assert.deepEqual(await visibleMessageContents(), beforeRows);
          const pending = (await trace(directory))
            .filter((item) => item.event === 'command')
            .at(-1);
          assert.equal(pending.command, `feed-${operation}`);
          await save(`${runLabel}-${operation}-callback-state.json`, {
            callbackBefore,
            before,
            pending,
          });
          await capture(`${runLabel}-${operation}-before`);
          await writeFile(
            path.join(directory, 'operation-permit.json'),
            JSON.stringify({ interactionId: pending.interactionId, operation }),
          );
          await until(
            async () =>
              (await trace(directory)).some(
                (item) =>
                  item.event === (profileCase === 'allow' ? 'rest-operation' : 'rest-denial') &&
                  item.operation === operation,
              ),
            `strict ${profileCase} ${operation}`,
          );
          const events = await trace(directory);
          const bootstrap = events.find((item) => item.event === 'bootstrap');
          const command = events.filter((item) => item.event === 'command').at(-1);
          const record = events.find(
            (item) =>
              item.event === (profileCase === 'allow' ? 'rest-operation' : 'rest-denial') &&
              item.operation === operation,
          );
          assert.equal(bootstrap.authorId, '4000');
          assert.equal(bootstrap.authenticatedRequest, true);
          assert.deepEqual(
            [command.actorId, command.guildId, command.channelId],
            ['3000', '1000', '2001'],
          );
          assert.equal(command.authenticatedRequest, true);
          assert.equal(command.applicationIdMatches, true);
          assert.equal(command.applicationId, bootstrap.applicationId);
          assert.equal(record.applicationId, bootstrap.applicationId);
          const expectedText =
            operation === 'create' ? 'G1 public message created.' : 'G1 public message edited.';
          if (profileCase === 'allow') {
            await until(
              async () => (await snapshot()).coreState.stateRevision === record.stateRevision,
              'strict committed state publication',
            );
            const row = page.locator(`.chat-message[data-message-id="${record.messageId}"]`);
            await until(
              async () =>
                operation === 'delete'
                  ? (await row.count()) === 0
                  : (await row.count()) === 1 &&
                    (await row.isVisible()) &&
                    (await row.locator('.message-content').textContent()) === expectedText,
              'strict ordinary renderer mutation',
            );
            if (operation !== 'delete')
              assert.equal(await row.locator('.chat-avatar.bot').isVisible(), true);
          }
          const after = await snapshot();
          if (profileCase === 'allow') {
            assertStrictMutation(before, after, record, messageId);
            assert.equal(
              eventIds.has(record.eventId),
              false,
              'distinct committed event per mutation',
            );
            eventIds.add(record.eventId);
            messageId = record.messageId;
            const retained = after.coreState.resources.filter(
              (item) => item.resourceType === 'message',
            );
            if (operation === 'delete') assert.deepEqual(retained, []);
            else {
              assert.equal(retained.length, 1);
              assert.deepEqual(
                [
                  retained[0].id,
                  retained[0].author.id,
                  retained[0].channel_id,
                  retained[0].guild_id,
                  retained[0].content,
                ],
                [messageId, '4000', '2001', '1000', expectedText],
              );
            }
            assert.deepEqual(
              await visibleMessageContents(),
              operation === 'delete' ? [] : [expectedText],
            );
          } else {
            assertStrictDenial(before, after, record, beforeRows, await visibleMessageContents());
            assert.equal(
              events.some((item) => item.event === 'rest-operation'),
              false,
            );
          }
          await save(`${runLabel}-${operation}-http-state.json`, {
            record,
            before,
            after,
            command,
            committedEventObservation:
              'HTTP event header plus public core revision; private dispatch bus not observed',
          });
          await capture(`${runLabel}-${operation}-after`);
        }
        // Preserve trace before clearing it for the next fresh run.
        await save(`${runLabel}-trace.json`, await trace(directory));
        await stop(directory);
        await save(`${runLabel}-cleanup.json`, {
          trace: await trace(directory),
          directChildDeadAndOwnedPortsClosed: true,
        });
        await capture(`${runLabel}-stopped`);
      }
      results.push({
        surface: 'packaged-electron',
        mode: `strict-${profileCase}`,
        outcome: 'control-passed',
        sameProjectRestart: true,
        privateCommitDispatchObserved: false,
      });
    }
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
    strictPermissionMatrixPassed:
      !cliOnly &&
      process.exitCode !== 1 &&
      results.filter((item) => item.mode.startsWith('strict-')).length === 3,
    completeParity: false, // Stronger late-success stale-result qualification remains pending.
  });
}
