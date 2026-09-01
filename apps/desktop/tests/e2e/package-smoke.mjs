import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_TIMEOUT_MS = 60_000;
const INSPECTOR_READY_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseRoot = path.join(desktopRoot, 'release');

/*
 * Packaged Electron on Windows hits the Electron #41325/CDP deadlock when an attached inspector
 * calls native BrowserWindow APIs, and packaged builds reject NODE_OPTIONS preload hooks. This smoke test
 * therefore limits the Windows branch to the real executable, packaged-browser identity,
 * application ASAR presence, stability, and deterministic process-tree cleanup. It does not
 * execute the packaged renderer, preload bridge, or runtime on Windows. Those behaviors are
 * exercised by the full macOS/Linux package branch and the separate desktop E2E,
 * runtime-manager, raw-webhook, and security suites.
 */

async function runWindowsSmoke(signal) {
  const executablePath = await findExecutable();
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'disrunner-package-smoke-'));

  let applicationProcess;
  let inspector;
  let processOutput = '';

  try {
    const launched = await launchApplication(executablePath, userDataDirectory, signal, (chunk) => {
      processOutput = appendBounded(processOutput, chunk, MAX_PROCESS_OUTPUT_BYTES);
    });
    applicationProcess = launched.process;
    inspector = new InspectorClient(launched.inspectorUrl, signal);
    await inspector.connect();

    const identity = await inspector.evaluate(`
      ({
        defaultApp: process.defaultApp === true,
        electron: process.versions.electron,
        execPath: process.execPath,
        node: process.versions.node,
        resourcesPath: process.resourcesPath,
        type: process.type,
        uptime: process.uptime(),
      })
    `);
    assert.equal(identity.type, 'browser');
    assert.equal(identity.defaultApp, false, 'the smoke target must be a packaged app');
    assert.match(identity.node, /^\d+\.\d+\.\d+/u);
    assert.match(identity.electron, /^\d+\.\d+\.\d+/u);
    assert.equal(path.resolve(identity.execPath), path.resolve(executablePath));
    assert.equal(path.dirname(identity.resourcesPath), path.dirname(executablePath));

    const applicationArchive = await stat(path.join(identity.resourcesPath, 'app.asar'));
    assert.equal(applicationArchive.isFile(), true);
    assert.ok(applicationArchive.size > 100_000, 'packaged ASAR must contain the application');

    await delay(500, signal);
    assert.equal(applicationProcess.exitCode, null, 'packaged app must remain alive after launch');
    inspector.close();
    inspector = undefined;
    await terminateProcessTree(applicationProcess);
    assert.ok(
      applicationProcess.exitCode !== null || applicationProcess.signalCode !== null,
      'packaged app process tree must be cleaned up',
    );
    applicationProcess = undefined;
  } catch (error) {
    const diagnostic = sanitizeDiagnostic(processOutput);
    if (error instanceof Error && diagnostic !== '') {
      error.message = `${error.message}\nPackaged process output (sanitized):\n${diagnostic}`;
    }
    throw error;
  } finally {
    inspector?.close();
    await terminateProcessTree(applicationProcess);
    await removeDirectory(userDataDirectory);
  }
}

async function runFullPackagedSmoke(signal) {
  const executablePath = await findExecutable();
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'disrunner-package-smoke-'));
  const exampleProjectRoot = path.resolve(desktopRoot, '..', '..', 'examples', 'raw-webhook-bot');
  const negativeProjectRoot = path.join(desktopRoot, 'tests', 'fixtures', 'package-smoke-project');
  let electronApplication;
  const onAbort = () => void electronApplication?.close().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    signal.throwIfAborted();
    const { _electron: electron } = await import('playwright');
    electronApplication = await electron.launch({
      args: ['--remote-allow-origins=*', `--user-data-dir=${userDataDirectory}`],
      env: sanitizedEnvironment(),
      executablePath,
      timeout: 45_000,
    });
    const page = await electronApplication.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.match(page.url(), /^file:/u, 'packaged renderer must load from a file URL');

    const isolation = await page.evaluate(() => ({
      bridge: typeof window.disrunnerDesktop,
      process: typeof globalThis.process,
      require: typeof globalThis.require,
    }));
    assert.deepEqual(isolation, { bridge: 'object', process: 'undefined', require: 'undefined' });

    const runtimeInfo = await page.evaluate(() => window.disrunnerDesktop.getRuntimeInfo());
    assert.equal(runtimeInfo.packaged, true);
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

    await electronApplication.evaluate(async ({ dialog }, selectedProject) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedProject] });
    }, exampleProjectRoot);
    const selected = await page.evaluate(() => window.disrunnerDesktop.selectProject());
    assert.equal(selected?.phase, 'ready', selected?.error ?? 'project should validate');
    assert.equal(path.basename(selected?.project?.root ?? ''), 'raw-webhook-bot');

    const started = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
    assert.equal(started.phase, 'running', started.error ?? 'runtime should start');
    assert.equal(typeof started.pid, 'number');

    const composer = page.getByRole('textbox', { name: 'Message #bot-testing' });
    await composer.fill('/ping');
    await composer.press('Enter');
    await page.getByText('Pong! Offline and deterministic.').last().waitFor();

    const ping = await page.evaluate(() => window.disrunnerDesktop.invokeCommand('/ping'));
    assert.equal(ping.ok, true, ping.error ?? 'signed /ping should succeed');
    assert.equal(ping.response?.data.content, 'Pong! Offline and deterministic.');

    const secret = await page.evaluate(() => window.disrunnerDesktop.invokeCommand('/secret'));
    assert.equal(secret.ok, true, secret.error ?? 'signed /secret should succeed');
    assert.equal(secret.response?.data.content, 'Only you can see this.');
    assert.equal(secret.response?.data.flags, 64);
    await composer.fill('/secret');
    await composer.press('Enter');
    await page
      .locator('.chat-message.ephemeral')
      .filter({ hasText: 'Only you can see this.' })
      .last()
      .waitFor();

    const stopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
    assert.equal(stopped.phase, 'ready', stopped.error ?? 'runtime should stop');
    assert.equal(stopped.pid, null);

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

    const context = await page.evaluate(() => window.disrunnerDesktop.invokeCommand('/context'));
    assert.equal(
      context.ok,
      true,
      context.error ?? 'fixture guild/channel and independent application ID are required',
    );
    assert.equal(context.response?.data.content, 'Pong from package smoke bot.');

    const unauthenticated = await page.evaluate(() =>
      window.disrunnerDesktop.invokeCommand('/unauthenticated'),
    );
    assert.equal(unauthenticated.ok, false);
    assert.match(unauthenticated.error ?? '', /response authentication failed/iu);
    const wrongAuthentication = await page.evaluate(() =>
      window.disrunnerDesktop.invokeCommand('/wrong-auth'),
    );
    assert.equal(wrongAuthentication.ok, false);
    assert.match(wrongAuthentication.error ?? '', /response authentication failed/iu);

    const invalid = await page.evaluate(() => window.disrunnerDesktop.invokeCommand('/invalid'));
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /unsupported interaction callback/iu);
    const timeout = await page.evaluate(() => window.disrunnerDesktop.invokeCommand('/timeout'));
    assert.equal(timeout.ok, false);
    assert.match(timeout.error ?? '', /timed out/iu);
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
    assert.ok(
      evidence.risks.some((risk) => risk.ruleId === 'WEBHOOK_PEER_AUTHENTICATION_FAILED'),
      'missing or forged response authentication must produce distinct risk evidence',
    );

    const negativeStopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
    assert.equal(
      negativeStopped.phase,
      'ready',
      negativeStopped.error ?? 'negative runtime should stop',
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

async function findExecutable() {
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
  signal.throwIfAborted();
  const args = ['--inspect=127.0.0.1:0', `--user-data-dir=${userData}`];
  if (process.platform !== 'win32' && process.getuid?.() === 0) args.push('--no-sandbox');
  const child = spawn(executable, args, {
    detached: process.platform !== 'win32',
    env: sanitizedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const inspectorUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Packaged app did not expose its Node inspector within ${INSPECTOR_READY_TIMEOUT_MS} ms.`,
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
      const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/u.exec(text);
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
  return { process: child, inspectorUrl };
}

class InspectorClient {
  #abortSignal;
  #commands = new Map();
  #id = 0;
  #url;
  #webSocket;

  constructor(url, abortSignal) {
    this.#url = url;
    this.#abortSignal = abortSignal;
  }

  async connect() {
    assert.equal(typeof WebSocket, 'function', 'Node 22 WebSocket support is required');
    this.#abortSignal.throwIfAborted();
    const socket = new WebSocket(this.#url);
    this.#webSocket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#rejectPending(new Error('Inspector closed.')));
    socket.addEventListener('error', () =>
      this.#rejectPending(new Error('Inspector WebSocket failed.')),
    );
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Inspector connection timed out.')), 5_000);
      const onAbort = () => finish(this.#abortSignal.reason ?? new Error('Smoke test aborted.'));
      const onOpen = () => finish();
      const onError = () => finish(new Error('Inspector connection failed.'));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#abortSignal.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      this.#abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    await this.command('Runtime.enable');
  }

  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description;
      const text = response.exceptionDetails.text;
      throw new Error(`Main-process evaluation failed: ${String(description ?? text)}`);
    }
    const result = response.result;
    if (Object.hasOwn(result, 'value')) return result.value;
    if (result.type === 'undefined') return undefined;
    throw new Error(
      `Inspector could not serialize evaluation result of type ${String(result.type)}.`,
    );
  }

  command(method, params = {}) {
    this.#abortSignal.throwIfAborted();
    const socket = this.#webSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Inspector is not connected.'));
    }
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#abortSignal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.#commands.delete(id);
        cleanup();
        reject(new Error(`Inspector command ${method} timed out.`));
      }, 5_000);
      const onAbort = () => {
        this.#commands.delete(id);
        cleanup();
        reject(this.#abortSignal.reason ?? new Error('Smoke test aborted.'));
      };
      this.#abortSignal.addEventListener('abort', onAbort, { once: true });
      this.#commands.set(id, {
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#rejectPending(new Error('Inspector client closed.'));
    this.#webSocket?.close();
    this.#webSocket = undefined;
  }

  #onMessage(event) {
    const raw =
      typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const command = this.#commands.get(message.id);
    if (!command) return;
    this.#commands.delete(message.id);
    if (message.error)
      command.reject(new Error(`Inspector error: ${String(message.error.message)}`));
    else command.resolve(message.result);
  }

  #rejectPending(error) {
    for (const command of this.#commands.values()) command.reject(error);
    this.#commands.clear();
  }
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

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error('Packaged smoke test was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

const harnessController = new AbortController();
const harnessTimer = setTimeout(() => {
  harnessController.abort(new Error(`Packaged smoke test exceeded ${HARNESS_TIMEOUT_MS} ms.`));
}, HARNESS_TIMEOUT_MS);
try {
  if (process.platform === 'win32') await runWindowsSmoke(harnessController.signal);
  else await runFullPackagedSmoke(harnessController.signal);
} finally {
  clearTimeout(harnessTimer);
}
