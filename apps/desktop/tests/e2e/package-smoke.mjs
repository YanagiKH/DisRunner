import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureLinuxSandbox, requireLinuxNonRoot } from './linux-sandbox.mjs';

const HARNESS_TIMEOUT_MS = 60_000;
const INSPECTOR_READY_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseRoot = path.join(desktopRoot, 'release');

function sandboxEvidencePath(name) {
  const directory = process.env.DISRUNNER_LINUX_SANDBOX_EVIDENCE;
  return directory === undefined ? undefined : path.join(directory, name);
}

// The Windows branch attaches to the renderer over Chromium CDP. It never evaluates native
// BrowserWindow operations through the main-process inspector.
async function runWindowsSmoke(signal) {
  const executablePath = await findExecutable();
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'disrunner-package-smoke-'));
  const negativeRoot = path.join(desktopRoot, 'tests', 'fixtures', 'package-smoke-project');
  let applicationProcess;
  let browser;
  let processOutput = '';
  let page;
  try {
    const launched = await launchApplication(executablePath, userDataDirectory, signal, (chunk) => {
      processOutput = appendBounded(processOutput, chunk, MAX_PROCESS_OUTPUT_BYTES);
    });
    applicationProcess = launched.process;
    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP(launched.devtoolsUrl, { timeout: 15000 });
    const context = browser.contexts()[0];
    assert.ok(context, 'packaged renderer must expose a browser context');
    page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 15000 }));
    await page.waitForURL(/^file:/u);
    await page.waitForLoadState('domcontentloaded');
    await captureLinuxSandbox({
      mainPid: applicationProcess.pid,
      browser,
      evidencePath: sandboxEvidencePath('raw-cdp.json'),
    });
    assert.deepEqual(
      await page.evaluate(() => ({
        bridge: typeof window.disrunnerDesktop,
        process: typeof globalThis.process,
        require: typeof globalThis.require,
      })),
      { bridge: 'object', process: 'undefined', require: 'undefined' },
    );
    const identity = await page.evaluate(() => window.disrunnerDesktop.getRuntimeInfo());
    assert.equal(identity.packaged, true);
    if (process.env.RELEASE_VERSION !== undefined)
      assert.equal(
        identity.version,
        process.env.RELEASE_VERSION,
        'installed desktop version must match the release version',
      );
    assert.equal(identity.offline, true);
    assert.equal(identity.platform, process.platform);
    const archivePath =
      process.platform === 'darwin'
        ? path.resolve(path.dirname(executablePath), '../Resources/app.asar')
        : path.join(path.dirname(executablePath), 'resources', 'app.asar');
    const archive = await stat(archivePath);
    assert.equal(archive.isFile(), true);
    assert.ok(archive.size > 100000);
    assert.equal(
      await page.evaluate(async () => {
        try {
          await fetch('https://discord.com/api/v10/gateway');
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );

    // Exercise the regular project-directory field, then start through the real controls.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Open bundled example', exact: true }).click();
    await page.getByRole('button', { name: 'Start bot', exact: true }).click();
    await page
      .getByRole('status', { name: 'Runtime phase', exact: true })
      .getByText('running', { exact: true })
      .waitFor();
    const started = await page.evaluate(() => window.disrunnerDesktop.getRuntimeState());
    assert.equal(started.phase, 'running');
    assert.equal(typeof started.pid, 'number');
    await page.getByRole('button', { name: 'Back to simulator', exact: true }).click();
    const composer = page.getByRole('textbox', { name: new RegExp('^Message #') });
    await composer.fill('/ping');
    await composer.press('Enter');
    await assertCallbackDiagnostic(page, started, '/ping', 'Pong! Offline and deterministic.', 1);
    const secret = await invokeSessionCommand(page, '/secret');
    assert.equal(secret.response?.data.flags, 64);
    const stopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
    assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
    assert.equal(stopped.snapshot.pid, null);
    assert.equal(stopped.snapshot.endpoints, null);
    await runScenarioRoundTrip(page, started.contexts[0]);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project directory', exact: true }).fill(negativeRoot);
    await page.getByRole('button', { name: 'Open directory', exact: true }).click();
    await page.getByRole('button', { name: 'Start bot', exact: true }).click();
    await page
      .getByRole('status', { name: 'Runtime phase', exact: true })
      .getByText('running', { exact: true })
      .waitFor();
    assert.equal(
      (await invokeSessionCommand(page, '/context')).response?.data.content,
      'Pong from package smoke bot.',
    );
    await assert.rejects(invokeSessionCommand(page, '/invalid'), /Bot interaction failed/u);
    const evidence = await page.evaluate(() => window.disrunnerDesktop.getRuntimeState());
    assert.ok(
      evidence.traces.some((trace) => trace.name === '/invalid' && trace.status === 'error'),
    );
    assert.ok(evidence.risks.some((risk) => risk.ruleId === 'INVALID_INTERACTION_CALLBACK'));
    assert.equal((await page.evaluate(() => window.disrunnerDesktop.stopRuntime())).ok, true);
    assert.equal(
      (await page.evaluate(() => window.disrunnerDesktop.startRuntime())).phase,
      'running',
    );
    // Closing an active app must complete normal runtime and process-tree cleanup.
    await page
      .evaluate(() => window.disrunnerDesktop.controlWindow('close'))
      .catch(() => undefined);
    await waitForExit(applicationProcess, 10000, signal);
    applicationProcess = undefined;
    await browser.close().catch(() => undefined);
    browser = undefined;
  } catch (error) {
    const diagnostic = sanitizeDiagnostic(processOutput);
    if (error instanceof Error && diagnostic !== '')
      error.message += `\nPackaged process output (sanitized):\n${diagnostic}`;
    throw error;
  } finally {
    if (page && !page.isClosed())
      await page.evaluate(() => window.disrunnerDesktop.stopRuntime()).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await terminateProcessTree(applicationProcess);
    await removeDirectory(userDataDirectory);
  }
}

async function runFullPackagedSmoke(signal) {
  requireLinuxNonRoot();
  const executablePath = await findExecutable();
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'disrunner-package-smoke-'));
  const negativeProjectRoot = path.join(desktopRoot, 'tests', 'fixtures', 'package-smoke-project');
  const forgedPeerProjectRoot = path.join(
    desktopRoot,
    'tests',
    'fixtures',
    'package-smoke-forged-peer-project',
  );
  let electronApplication;
  const onAbort = () => void electronApplication?.close().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    signal.throwIfAborted();
    const { _electron: electron } = await import('playwright');
    electronApplication = await electron.launch({
      chromiumSandbox: true,
      args: ['--remote-allow-origins=*', `--user-data-dir=${userDataDirectory}`],
      env: sanitizedEnvironment(),
      executablePath,
      timeout: 45_000,
    });
    const page = await electronApplication.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.match(page.url(), /^file:/u, 'packaged renderer must load from a file URL');
    if (process.platform === 'linux') {
      const window = await electronApplication.browserWindow(page);
      const rendererPid = await window.evaluate((window) => window.webContents.getOSProcessId());
      await window.dispose();
      await captureLinuxSandbox({
        mainPid: electronApplication.process().pid,
        rendererPids: [rendererPid],
        evidencePath: sandboxEvidencePath('raw-native.json'),
      });
    }

    const isolation = await page.evaluate(() => ({
      bridge: typeof window.disrunnerDesktop,
      process: typeof globalThis.process,
      require: typeof globalThis.require,
    }));
    assert.deepEqual(isolation, { bridge: 'object', process: 'undefined', require: 'undefined' });

    const runtimeInfo = await page.evaluate(() => window.disrunnerDesktop.getRuntimeInfo());
    assert.equal(runtimeInfo.packaged, true);
    if (process.env.RELEASE_VERSION !== undefined)
      assert.equal(
        runtimeInfo.version,
        process.env.RELEASE_VERSION,
        'packaged desktop version must match the release version',
      );
    assert.equal(runtimeInfo.offline, true);

    const discordRequestBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://discord.com/api/v10/gateway');
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(discordRequestBlocked, true, 'Discord network request must be blocked');

    const selected = await page.evaluate(() => window.disrunnerDesktop.openExample());
    assert.equal(selected?.phase, 'ready', selected?.error ?? 'bundled example should validate');
    assert.equal(path.basename(selected?.project?.root ?? ''), 'raw-webhook-bot');
    const marker = path.join(selected.project.root, 'user-copy-marker.txt');
    await writeFile(marker, 'keep user changes', 'utf8');
    const reopened = await page.evaluate(() => window.disrunnerDesktop.openExample());
    assert.equal(reopened.project.root, selected.project.root);
    assert.equal(
      await readFile(marker, 'utf8'),
      'keep user changes',
      'opening the example again must not overwrite user files',
    );
    assert.equal(reopened.pid, null, 'opening the bundled example must never start the bot');

    const started = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
    assert.equal(started.phase, 'running', started.error ?? 'runtime should start');
    assert.equal(typeof started.pid, 'number');

    const composer = page.locator('.composer input');
    await composer.fill('/ping');
    await composer.press('Enter');
    const pingDiagnostic = await assertCallbackDiagnostic(
      page,
      started,
      '/ping',
      'Pong! Offline and deterministic.',
      1,
    );

    const ping = await invokeSessionCommand(page, '/ping');
    assert.equal(ping.ok, true, ping.error ?? 'signed /ping should succeed');
    assert.equal(ping.response?.data.content, 'Pong! Offline and deterministic.');

    const secret = await invokeSessionCommand(page, '/secret');
    assert.equal(secret.ok, true, secret.error ?? 'signed /secret should succeed');
    assert.equal(secret.response?.data.content, 'Only you can see this.');
    assert.equal(secret.response?.data.flags, 64);
    await composer.fill('/secret');
    await composer.press('Enter');
    const secretDiagnostic = await assertCallbackDiagnostic(
      page,
      started,
      '/secret',
      'Only you can see this.',
      2,
    );
    assert.notEqual(secretDiagnostic.requestId, pingDiagnostic.requestId);
    await invokeSessionCommand(page, '/attachment');
    await page.getByRole('button', { name: 'Save note.txt', exact: true }).waitFor();
    const attachment = await page.evaluate(async (actorId) => {
      const current = await window.disrunnerDesktop.getRuntimeState(actorId);
      const message = current.coreState.resources.find(
        (resource) =>
          resource.resourceType === 'message' &&
          resource.attachments?.some((attachment) => attachment.filename === 'note.txt'),
      );
      return message?.attachments?.find((attachment) => attachment.filename === 'note.txt');
    }, started.contexts[0].actorId);
    assert.equal(typeof attachment?.id, 'string');
    const attachmentTarget = path.join(userDataDirectory, 'saved-note.txt');
    await electronApplication.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, attachmentTarget);
    assert.equal(
      await page.evaluate((request) => window.disrunnerDesktop.saveAttachment(request), {
        runId: started.runId,
        attachmentId: attachment.id,
        context: started.contexts[0],
      }),
      true,
    );
    assert.equal(await readFile(attachmentTarget, 'utf8'), 'Offline attachment ✓\n');

    const stopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
    assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
    assert.equal(stopped.snapshot.phase, 'ready', stopped.snapshot.error ?? 'runtime should stop');
    assert.equal(stopped.snapshot.pid, null);
    await runScenarioRoundTrip(page, started.contexts[0]);
    for (const format of ['json', 'junit', 'html', 'sarif']) {
      const target = path.join(
        userDataDirectory,
        `scenario-report.${format === 'junit' ? 'xml' : format}`,
      );
      await electronApplication.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, target);
      assert.equal(
        await page.evaluate(
          (selectedFormat) => window.disrunnerDesktop.exportScenario(selectedFormat),
          format,
        ),
        true,
      );
      const encoded = await readFile(target, 'utf8');
      if (format === 'json') assert.equal(JSON.parse(encoded).status, 'failed');
      else if (format === 'sarif') assert.equal(JSON.parse(encoded).version, '2.1.0');
      else assert.match(encoded, format === 'junit' ? /<testsuites?\b/u : /<!doctype html>/iu);
    }
    const reproductionTarget = path.join(userDataDirectory, 'reproduction.json');
    await electronApplication.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, reproductionTarget);
    assert.equal(await page.evaluate(() => window.disrunnerDesktop.exportReproduction()), true);
    const reproduction = JSON.parse(await readFile(reproductionTarget, 'utf8'));
    assert.equal(reproduction.version, 1);
    assert.equal(reproduction.kind, 'bot-rerun');
    assert.equal(reproduction.replayable, false);
    assert.equal(reproduction.requiresOriginalProject, true);
    assert.equal(reproduction.report.status, 'failed');
    await page.getByRole('button', { name: 'Guild Editor', exact: true }).click();
    const resourceEditor = page.getByRole('textbox', {
      name: 'Fixture resources JSON',
      exact: true,
    });
    const editedResources = JSON.parse(await resourceEditor.inputValue());
    editedResources.find((resource) => resource.resourceType === 'guild').name =
      'Saved after cancelling quit';
    await resourceEditor.fill(JSON.stringify(editedResources, null, 2));
    await electronApplication.evaluate(({ app, dialog }) => {
      globalThis.disrunnerQuitPrompted = false;
      dialog.showMessageBoxSync = () => {
        globalThis.disrunnerQuitPrompted = true;
        return 0;
      };
      setImmediate(() => app.quit());
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await electronApplication.evaluate(() => globalThis.disrunnerQuitPrompted)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      await electronApplication.evaluate(() => globalThis.disrunnerQuitPrompted),
      true,
      'the unsaved-changes prompt must allow cancelling quit',
    );
    await page.getByText('Unsaved changes', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Workspace saved.' }).waitFor();
    assert.equal(
      (await page.evaluate(() => window.disrunnerDesktop.getRuntimeState())).disposed,
      false,
      'cancelling quit must leave the session usable',
    );

    await electronApplication.evaluate(async ({ dialog }, selectedProject) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
    }, negativeProjectRoot);
    const negativeSelected = await page.evaluate(() => window.disrunnerDesktop.selectProject());
    assert.equal(
      negativeSelected?.phase,
      'ready',
      negativeSelected?.error ?? 'negative project should validate',
    );
    const negativeStarted = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
    assert.equal(
      negativeStarted.phase,
      'running',
      negativeStarted.error ?? 'negative runtime should start',
    );

    const context = await invokeSessionCommand(page, '/context');
    assert.equal(
      context.ok,
      true,
      context.error ?? 'fixture guild/channel and independent application ID are required',
    );
    assert.equal(context.response?.data.content, 'Pong from package smoke bot.');

    // Session failures crossing IPC expose safe messages, not raw callback details.
    // The distinct trace and risk assertions below establish each failure's cause.
    await assert.rejects(
      invokeSessionCommand(page, '/invalid'),
      /SessionError: Bot interaction failed\.$/u,
    );
    await assert.rejects(
      invokeSessionCommand(page, '/timeout'),
      /SessionError: Interaction deadline exceeded\.$/u,
    );
    const evidence = await page.evaluate(() => window.disrunnerDesktop.getRuntimeState());
    assert.ok(
      evidence.traces.some((trace) => trace.name === '/invalid' && trace.status === 'error'),
      'invalid callback must produce an error trace',
    );
    assert.ok(
      evidence.traces.some((trace) => trace.name === '/timeout' && trace.status === 'error'),
      'timeout must produce an error trace',
    );
    assert.ok(
      evidence.risks.some((risk) => risk.ruleId === 'INVALID_INTERACTION_CALLBACK'),
      'invalid callback must produce risk evidence',
    );
    assert.ok(
      evidence.risks.some((risk) => risk.ruleId === 'INTERACTION_TIMEOUT'),
      'timeout must produce risk evidence',
    );
    assert.equal(
      evidence.traces.some(
        (trace) => ['/invalid', '/timeout'].includes(trace.name) && trace.status === 'ok',
      ),
      false,
      'rejected callbacks must not produce successful interaction traces',
    );
    const negativeStopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
    assert.equal(negativeStopped.ok, true, JSON.stringify(negativeStopped.errors));
    assert.equal(
      negativeStopped.snapshot.phase,
      'ready',
      negativeStopped.snapshot.error ?? 'negative runtime should stop',
    );

    await electronApplication.evaluate(async ({ dialog }, selectedProject) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
    }, forgedPeerProjectRoot);
    const forgedPeerSelected = await page.evaluate(() => window.disrunnerDesktop.selectProject());
    assert.equal(
      forgedPeerSelected?.phase,
      'ready',
      forgedPeerSelected?.error ?? 'forged-peer project should validate',
    );
    await assert.rejects(
      page.evaluate(() => window.disrunnerDesktop.startRuntime()),
      /response authentication failed/iu,
      'forged readiness response must reject with peer-authentication failure',
    );
    const forgedPeerStarted = await page.evaluate(() => window.disrunnerDesktop.getRuntimeState());
    assert.equal(
      forgedPeerStarted.phase,
      'error',
      'a fixed forged listener must fail authenticated readiness',
    );
    assert.equal(forgedPeerStarted.pid, null);
    assert.equal(forgedPeerStarted.endpoints, null);

    await electronApplication.evaluate(async ({ dialog }, selectedProject) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
    }, negativeProjectRoot);
    const closeProjectSelected = await page.evaluate(() => window.disrunnerDesktop.selectProject());
    assert.equal(
      closeProjectSelected?.phase,
      'ready',
      closeProjectSelected?.error ?? 'close-cleanup project should validate',
    );
    const closeStarted = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
    assert.equal(
      closeStarted.phase,
      'running',
      closeStarted.error ?? 'runtime should restart before close cleanup',
    );

    // Closing a running packaged app exercises the main-process child/server cleanup path.
    await electronApplication.close();
    electronApplication = undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await electronApplication?.close().catch(() => undefined);
    await removeDirectory(userDataDirectory);
  }
}

async function runScenarioRoundTrip(page, context) {
  await page.getByRole('button', { name: 'Scenario Lab', exact: true }).click();
  const source = {
    version: 2,
    name: 'packaged-bot-roundtrip',
    execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10000 },
    context: { actor: context.actorId, guild: context.guildId, channel: context.channelId },
    steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }],
    assertions: [
      {
        type: 'message-content',
        interaction: '${ping.id}',
        equals: 'Pong! Offline and deterministic.',
      },
    ],
  };
  const editor = page.getByRole('textbox', { name: 'Scenario source', exact: true });
  await editor.fill(JSON.stringify(source, null, 2));
  await page.getByRole('button', { name: 'Run scenario', exact: true }).click();
  await page.getByRole('heading', { name: 'passed', exact: true }).waitFor();
  source.assertions[0].equals = 'Deliberately incorrect expectation.';
  await editor.fill(JSON.stringify(source, null, 2));
  await page.getByRole('button', { name: 'Run scenario', exact: true }).click();
  await page.getByRole('heading', { name: 'failed', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Workspace saved.' }).waitFor();
}

// Inspector callbacks remain diagnostics; chat rows come from authoritative viewer-filtered state.
async function assertCallbackDiagnostic(page, started, command, content, expectedPublicOriginals) {
  // Wait for this composer invocation before selecting Trace: ephemeral replies select Payload.
  await page
    .locator('.toast')
    .getByText(`${command} returned by local bot`, { exact: true })
    .waitFor();
  const expand = page.getByRole('button', { name: 'Expand inspector', exact: true });
  const restoreCollapsed = (await expand.count()) === 1;
  if (restoreCollapsed) await expand.click();
  try {
    await page.getByRole('tab', { name: 'Trace', exact: true }).click();
    const details = page
      .locator('.outcome-panel section')
      .filter({ has: page.getByRole('heading', { name: 'Details', exact: true }) })
      .locator('p');
    await page.locator('.outcome-panel').getByText(content, { exact: true }).waitFor();
    assert.equal(await details.isVisible(), true);
    assert.equal(await details.textContent(), content);
    assert.equal(await page.locator('.trace-details dd').first().textContent(), command);
    assert.equal(await page.locator('.outcome-badge:visible').textContent(), 'Passed');
    await page.getByRole('tab', { name: 'Payload', exact: true }).click();
    const payloadElement = page.locator('.payload-view pre code');
    await payloadElement.waitFor({ state: 'visible' });
    const payload = JSON.parse(await payloadElement.textContent());
    assert.equal(payload.command, command);
    assert.equal(payload.callbackType, 'message');
    assert.equal(payload.signed, true);
    assert.equal(payload.runId, started.runId);
    assert.equal(typeof payload.requestId, 'string');
    assert.ok(payload.requestId.length > 0);
    assert.deepEqual(
      { actorId: payload.actorId, guildId: payload.guildId, channelId: payload.channelId },
      started.contexts[0],
    );
    const snapshot = await page.evaluate(() => window.disrunnerDesktop.getRuntimeState());
    assert.equal(snapshot.runId, started.runId);
    assert.equal(snapshot.coreState?.runId, started.runId);
    const originals = snapshot.coreState.resources.filter(
      (resource) => resource.resourceType === 'message',
    );
    assert.equal(originals.length, expectedPublicOriginals);
    assert.equal(new Set(originals.map((resource) => resource.id)).size, expectedPublicOriginals);
    for (const resource of originals) {
      assert.equal(resource.type, 20, 'public replies must be retained original messages');
      assert.equal(resource.visibility, 'channel');
      assert.equal(resource.flags, 0);
      assert.equal(resource.content, 'Pong! Offline and deterministic.');
      assert.equal(resource.guild_id, started.contexts[0].guildId);
      assert.equal(resource.channel_id, started.contexts[0].channelId);
      const row = page.locator(`.chat-message[data-message-id="${resource.id}"]`);
      await row.waitFor({ state: 'visible' });
      assert.equal(await row.count(), 1);
      assert.equal(await row.locator('.message-content').textContent(), resource.content);
    }
    assert.equal(
      originals.some((resource) => resource.content === 'Only you can see this.'),
      false,
      'public snapshots must never expose private responses',
    );
    if (command === '/secret')
      await page
        .locator('.chat-message.ephemeral')
        .getByText('Only you can see this.', { exact: true })
        .first()
        .waitFor();
    await page.getByRole('tab', { name: 'Trace', exact: true }).click();
    return payload;
  } finally {
    if (restoreCollapsed)
      await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
  }
}

async function invokeSessionCommand(page, input) {
  const request = await page.evaluate(async (command) => {
    const snapshot = await window.disrunnerDesktop.getRuntimeState();
    if (snapshot.runId === null || snapshot.contexts.length === 0)
      throw new Error('No active validated invocation context.');
    return {
      runId: snapshot.runId,
      requestId: crypto.randomUUID(),
      input: command,
      context: { ...snapshot.contexts[0] },
    };
  }, input);
  const result = await page.evaluate(
    (captured) => window.disrunnerDesktop.invokeCommand(captured),
    request,
  );
  assert.equal(result.runId, request.runId);
  assert.equal(result.requestId, request.requestId);
  assert.deepEqual(result.context, request.context);
  return result;
}

async function findExecutable() {
  const override = process.env.DISRUNNER_PACKAGED_EXECUTABLE;
  if (override !== undefined) {
    assert.ok(path.isAbsolute(override), 'DISRUNNER_PACKAGED_EXECUTABLE must be an absolute path');
    const info = await stat(override);
    assert.equal(
      info.isFile(),
      true,
      'packaged executable override must identify a regular executable file',
    );
    await access(override, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (process.platform === 'win32')
      assert.equal(
        path.extname(override).toLowerCase(),
        '.exe',
        'Windows packaged executable override must be an .exe file',
      );
    return override;
  }
  const preferred =
    process.platform === 'win32'
      ? [path.join(releaseRoot, 'win-unpacked', 'DisRunner.exe')]
      : process.platform === 'darwin'
        ? [
            path.join(releaseRoot, 'mac', 'DisRunner.app', 'Contents', 'MacOS', 'DisRunner'),
            path.join(releaseRoot, 'mac-arm64', 'DisRunner.app', 'Contents', 'MacOS', 'DisRunner'),
            path.join(releaseRoot, 'mac-x64', 'DisRunner.app', 'Contents', 'MacOS', 'DisRunner'),
          ]
        : [
            path.join(releaseRoot, 'linux-unpacked', 'disrunner'),
            path.join(releaseRoot, 'linux-unpacked', 'DisRunner'),
          ];
  for (const candidate of preferred) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the bounded unpacked-directory search below.
    }
  }
  const found = await searchUnpacked(releaseRoot, 0);
  if (found !== null) return found;
  throw new Error(`No unpacked DisRunner executable was found beneath ${releaseRoot}.`);
}

async function searchUnpacked(directory, depth) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (
      entry.isFile() &&
      isExecutableName(entry.name) &&
      /(?:unpacked|\.app[\\/])/iu.test(candidate)
    ) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await searchUnpacked(candidate, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function isExecutableName(name) {
  if (process.platform === 'win32') return name === 'DisRunner.exe';
  return name === 'DisRunner' || name === 'disrunner';
}

async function launchApplication(executable, userData, signal, onOutput) {
  requireLinuxNonRoot();
  signal.throwIfAborted();
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userData}`,
  ];
  const child = spawn(executable, args, {
    detached: process.platform !== 'win32',
    env: sanitizedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const devtoolsUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Packaged app did not expose its renderer CDP endpoint within ${INSPECTOR_READY_TIMEOUT_MS} ms.`,
        ),
      );
    }, INSPECTOR_READY_TIMEOUT_MS);
    const onAbort = () => finish(signal.reason ?? new Error('Packaged smoke test was aborted.'));
    const onExit = (code, exitSignal) => {
      finish(
        new Error(
          `Packaged app exited before inspector startup (code ${String(code)}, signal ${String(exitSignal)}).`,
        ),
      );
    };
    const onData = (chunk) => {
      const text = Buffer.from(chunk).toString('utf8');
      onOutput(text);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/u.exec(text);
      if (match?.[1]) finish(null, match[1]);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  return { process: child, devtoolsUrl };
}

function waitForExit(child, timeoutMs, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Packaged app did not exit after close.')),
      timeoutMs,
    );
    const onAbort = () => finish(signal.reason ?? new Error('Packaged smoke test was aborted.'));
    const onExit = (code, exitSignal) => finish(null, { code, signal: exitSignal });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(result);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('exit', onExit);
  });
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForExit(killer, 5_000, new AbortController().signal).catch(() => undefined);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The application already exited.
      }
    }
  }
  await waitForExit(child, 5_000, new AbortController().signal).catch(() => undefined);
}

async function removeDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|AUTHORIZATION|COOKIE)/iu.test(
        name,
      )
    ) {
      delete environment[name];
    }
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.SSH_AUTH_SOCK;
  delete environment.VITE_DEV_SERVER_URL;
  return environment;
}

function appendBounded(previous, next, maxBytes) {
  const combined = `${previous}${next}`;
  const encoded = Buffer.from(combined, 'utf8');
  if (encoded.byteLength <= maxBytes) return combined;
  return encoded
    .subarray(encoded.byteLength - maxBytes)
    .toString('utf8')
    .replace(/^\uFFFD/u, '');
}

function sanitizeDiagnostic(value) {
  return value
    .replace(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/gu, 'ws://127.0.0.1:[REDACTED]')
    .replace(/\b(?:mfa\.)?[A-Za-z\d_-]{24,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/gu, '[REDACTED]')
    .replace(/\b(Bot|Bearer)\s+[A-Za-z\d._~+/-]{16,}\b/giu, '$1 [REDACTED]')
    .trim();
}

export {
  findExecutable,
  launchApplication,
  terminateProcessTree,
  waitForExit,
  sanitizedEnvironment,
  sanitizeDiagnostic,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const harnessController = new AbortController();
  const harnessTimer = setTimeout(() => {
    harnessController.abort(new Error(`Packaged smoke test exceeded ${HARNESS_TIMEOUT_MS} ms.`));
  }, HARNESS_TIMEOUT_MS);
  try {
    if (process.platform === 'win32' || process.env.DISRUNNER_SMOKE_RENDERER_CDP === '1')
      await runWindowsSmoke(harnessController.signal);
    else await runFullPackagedSmoke(harnessController.signal);
  } finally {
    clearTimeout(harnessTimer);
  }
}
