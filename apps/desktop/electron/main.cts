import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import type { IpcMainInvokeEvent, Session } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanupConfirmed, cleanupMessage } from './shutdown-policy.js';

import type {
  BotScenarioV2Result,
  RuntimeActionRequest,
  InvocationContext,
  InvocationRequest,
  RuntimeEndpoints,
  WindowAction,
} from './runtime-contract.cjs';

const applicationRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(applicationRoot, 'dist');
const applicationIndexPath = path.join(rendererRoot, 'index.html');
const applicationIndexUrl = pathToFileURL(applicationIndexPath).href;
const allowedDevelopmentOrigin = 'http://127.0.0.1:5173';
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
const runtimeOrigins = new Set<string>();

let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let sessionConfigured = false;
let quitAfterCleanup = false;
let cleanupInProgress = false;

// Cache the ESM runtime once; Electron-specific IPC and origin policy stay here.
const runtimeApi = import('@disrunner/runtime');
let scenarioAbort: AbortController | null = null;
let scenarioResult: BotScenarioV2Result | null = null;
let scenarioOrigin: { root: string; source: string } | null = null;
let scenarioCompletion: Promise<BotScenarioV2Result> | null = null;
const runtime = runtimeApi.then(({ createSession }) => {
  const instance = createSession({ onEndpoints: setRuntimeEndpoints });
  instance.subscribe((event) => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('runtime:state', event);
    }
  });
  return instance;
});

let projectOperation = false;
async function atomicExport(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.disrunner-export-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function withProjectOperation<T>(work: () => Promise<T>): Promise<T> {
  if (projectOperation)
    throw new Error(
      'Another project operation is in progress. Wait for it to finish or cancel the scenario.',
    );
  projectOperation = true;
  try {
    return await work();
  } finally {
    projectOperation = false;
  }
}

async function rememberProject(directory: string): Promise<void> {
  try {
    const preferences = path.join(app.getPath('userData'), 'preferences.json');
    await mkdir(path.dirname(preferences), { recursive: true });
    const temporary = `${preferences}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, lastProject: directory }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, preferences);
  } catch {
    console.warn('The recent project could not be saved.');
  }
}

async function restoreRecentProject(): Promise<void> {
  try {
    const file = await open(path.join(app.getPath('userData'), 'preferences.json'), 'r');
    let source: string;
    try {
      const bytes = Buffer.alloc(8193);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 8192) return;
      source = bytes.subarray(0, result.bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(source);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('lastProject' in value) ||
      typeof value.lastProject !== 'string' ||
      value.lastProject.length > 4096
    )
      return;
    // Reopening restores editable project data only. A bot always requires an explicit Start.
    await (await runtime).selectProject(value.lastProject);
  } catch {
    /* First launch and a removed preferences file both start with no project. */
  }
}

async function openBundledExample() {
  const version = app.getVersion();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))
    throw new Error('The application version is invalid.');
  const parent = path.join(app.getPath('userData'), 'examples', version);
  const destination = path.join(parent, 'raw-webhook-bot');
  await mkdir(parent, { recursive: true });
  let exists = false;
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('The example directory must be a regular directory.');
    exists = true;
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
  }
  if (!exists) {
    const source = app.isPackaged
      ? path.join(process.resourcesPath, 'examples', 'raw-webhook-bot')
      : path.resolve(applicationRoot, '../../examples/raw-webhook-bot');
    const temporary = await mkdtemp(path.join(parent, '.raw-example-'));
    try {
      const staged = path.join(temporary, 'project');
      await cp(source, staged, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (entry) =>
          path.basename(entry) !== 'node_modules' && path.basename(entry) !== 'tests',
      });
      await rename(staged, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const selected = await (await runtime).selectProject(destination);
  if (selected.project !== null) await rememberProject(selected.project.root);
  return selected;
}

async function stoppedProjectRoot(): Promise<string> {
  const snapshot = (await runtime).snapshot();
  if (
    scenarioAbort !== null ||
    snapshot.phase !== 'ready' ||
    snapshot.pid !== null ||
    snapshot.endpoints !== null ||
    snapshot.project === null
  ) {
    throw new Error(
      'Stop the bot and finish cleanup before editing the project or running a scenario.',
    );
  }
  return snapshot.project.root;
}

function requireNoScenario(): void {
  if (scenarioAbort !== null)
    throw new Error('Stop the running scenario before changing the runtime.');
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return false;
  const senderUrl = event.senderFrame.url;
  if (app.isPackaged) return senderUrl === applicationIndexUrl;
  try {
    return new URL(senderUrl).origin === allowedDevelopmentOrigin;
  } catch {
    return false;
  }
}

function isAllowedNavigation(candidate: string): boolean {
  if (app.isPackaged) return candidate === applicationIndexUrl;
  try {
    return new URL(candidate).origin === allowedDevelopmentOrigin;
  } catch {
    return false;
  }
}

function isAllowedRequest(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (app.isPackaged && parsed.protocol === 'file:') {
      return isWithin(rendererRoot, fileURLToPath(parsed));
    }
    if (!app.isPackaged && isExactDevelopmentEndpoint(parsed)) return true;
    return runtimeOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function isExactDevelopmentEndpoint(url: URL): boolean {
  const development = new URL(allowedDevelopmentOrigin);
  return (
    url.hostname === development.hostname &&
    url.port === development.port &&
    (url.protocol === development.protocol || url.protocol === 'ws:') &&
    url.username === '' &&
    url.password === ''
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function setRuntimeEndpoints(endpoints: RuntimeEndpoints | null): void {
  runtimeOrigins.clear();
  if (endpoints === null) return;
  for (const candidate of [
    endpoints.restBaseUrl,
    endpoints.gatewayUrl,
    endpoints.interactionEndpoint,
  ]) {
    if (candidate === undefined) continue;
    const parsed = new URL(candidate);
    if (
      parsed.hostname === '127.0.0.1' &&
      ['http:', 'ws:'].includes(parsed.protocol) &&
      parsed.port !== ''
    ) {
      runtimeOrigins.add(parsed.origin);
    }
  }
}

function requireTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender.');
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('runtime:get-info', (event) => {
    requireTrustedSender(event);
    return Object.freeze({
      platform: process.platform,
      version: app.getVersion(),
      packaged: app.isPackaged,
      offline: true,
    });
  });
  ipcMain.handle('runtime:get-state', async (event, actorId: unknown) => {
    requireTrustedSender(event);
    const instance = await runtime;
    if (actorId === undefined) return instance.snapshot();
    if (typeof actorId !== 'string') throw new TypeError('Actor ID must be a string.');
    return instance.snapshotForActor(actorId);
  });
  ipcMain.handle('runtime:start', async (event) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      requireNoScenario();
      return (await runtime).start();
    });
  });
  ipcMain.handle('runtime:commands', async (event, context: InvocationContext, runId: unknown) => {
    requireTrustedSender(event);
    const instance = await runtime;
    const captured = instance.snapshot();
    if (
      typeof runId !== 'string' ||
      captured.runId !== runId ||
      captured.phase !== 'running' ||
      instance.commandsForContext === undefined
    )
      throw new Error('Start a run before reading its registered commands.');
    return instance.commandsForContext(instance.validateContext(context));
  });
  ipcMain.handle('runtime:stop', async (event) => {
    requireTrustedSender(event);
    return (await runtime).stop();
  });
  ipcMain.handle('runtime:invoke', async (event, request: InvocationRequest) => {
    requireTrustedSender(event);
    // The shared session validates and copies the complete untrusted IPC request.
    return (await runtime).invoke(request);
  });
  ipcMain.handle('runtime:dispatch', async (event, request: RuntimeActionRequest) => {
    requireTrustedSender(event);
    requireNoScenario();
    return (await runtime).dispatch(request);
  });
  ipcMain.handle('project:open', async (event, directory: unknown) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      requireNoScenario();
      if (typeof directory !== 'string' || directory.length > 4096)
        throw new TypeError('Enter a project directory.');
      const selected = await (await runtime).selectProject(directory);
      if (selected.project !== null) await rememberProject(selected.project.root);
      return selected;
    });
  });
  ipcMain.handle('project:example', async (event) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      requireNoScenario();
      return openBundledExample();
    });
  });
  ipcMain.handle('attachment:pick', async (event, context: InvocationContext) => {
    requireTrustedSender(event);
    requireNoScenario();
    const instance = await runtime;
    const captured = instance.snapshot();
    if (
      captured.phase !== 'running' ||
      captured.project === null ||
      instance.importAttachment === undefined
    )
      throw new Error('Start a bot project before choosing an attachment.');
    const validated = instance.validateContext(context);
    const chosen = await dialog.showOpenDialog({
      title: 'Choose a local project attachment',
      defaultPath: captured.project.root,
      properties: ['openFile'],
    });
    if (chosen.canceled || chosen.filePaths[0] === undefined) return null;
    const latest = instance.snapshot();
    if (
      latest.sessionId !== captured.sessionId ||
      latest.runId !== captured.runId ||
      latest.phase !== 'running'
    )
      throw new Error('The run changed while choosing an attachment. Choose the file again.');
    if (!isWithin(captured.project.root, chosen.filePaths[0]))
      throw new Error('Choose a file inside the selected project directory.');
    return instance.importAttachment(
      path.relative(captured.project.root, chosen.filePaths[0]),
      validated,
    );
  });
  ipcMain.handle(
    'attachment:import',
    async (event, relativePath: unknown, context: InvocationContext) => {
      requireTrustedSender(event);
      requireNoScenario();
      if (typeof relativePath !== 'string' || relativePath.length > 4096)
        throw new TypeError('Enter a project-relative file path.');
      const instance = await runtime;
      if (instance.importAttachment === undefined)
        throw new Error('Attachment import is unavailable.');
      return instance.importAttachment(relativePath, instance.validateContext(context));
    },
  );
  ipcMain.handle('attachment:save', async (event, request: unknown) => {
    requireTrustedSender(event);
    requireNoScenario();
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request) ||
      !('runId' in request) ||
      !('attachmentId' in request) ||
      !('context' in request) ||
      typeof request.runId !== 'string' ||
      typeof request.attachmentId !== 'string'
    )
      throw new TypeError('Attachment save requires a run, attachment ID and actor context.');
    const instance = await runtime;
    const captured = instance.snapshot();
    if (
      captured.runId !== request.runId ||
      captured.phase !== 'running' ||
      instance.readAttachment === undefined
    )
      throw new Error('The attachment belongs to an inactive run.');
    const context = instance.validateContext(request.context as InvocationContext);
    const file = await instance.readAttachment(request.attachmentId, context);
    const chosen = await dialog.showSaveDialog({
      title: 'Save local attachment',
      defaultPath: path.basename(file.metadata.filename),
    });
    if (chosen.canceled || chosen.filePath === undefined) return false;
    await writeFile(chosen.filePath, file.data, { mode: 0o600 });
    return true;
  });
  ipcMain.handle('workspace:read', async (event) => {
    requireTrustedSender(event);
    const instance = await runtime;
    const project = instance.snapshot().project;
    if (project === null) throw new Error('Open a project first.');
    const api = await runtimeApi;
    const workspace = await api.openWorkspace(project.root);
    if (workspace.status !== 'missing') return workspace;
    const config = await api.loadProjectConfiguration(project.root);
    return {
      ...workspace,
      document: {
        version: 1,
        resources: config.resources,
        scenarios: [],
        options: { seed: config.profile.seed, mode: config.profile.mode },
      },
    };
  });
  ipcMain.handle('workspace:save', async (event, document: unknown, expectedHash: unknown) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      const root = await stoppedProjectRoot();
      if (expectedHash !== null && typeof expectedHash !== 'string')
        throw new TypeError('Workspace hash must be a string or null.');
      const api = await runtimeApi;
      const saved = await api.saveWorkspace(root, api.parseWorkspace(document), { expectedHash });
      await (await runtime).selectProject(root);
      return saved;
    });
  });
  ipcMain.handle('workspace:recover', async (event, expectedHash: unknown) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      const root = await stoppedProjectRoot();
      if (expectedHash !== null && typeof expectedHash !== 'string')
        throw new TypeError('Workspace hash must be a string or null.');
      const restored = await (await runtimeApi).recoverWorkspace(root, { expectedHash });
      await (await runtime).selectProject(root);
      return restored;
    });
  });
  ipcMain.handle('scenario:run', async (event, source: unknown) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      const root = await stoppedProjectRoot();
      if (typeof source !== 'string' || Buffer.byteLength(source) > 1_048_576)
        throw new TypeError('Scenario exceeds the supported size.');
      const api = await runtimeApi;
      const scenario = api.parseBotScenarioV2(source);
      // Reserve synchronously after parsing and before the first run await.
      requireNoScenario();
      const controller = new AbortController();
      scenarioAbort = controller;
      scenarioResult = null;
      scenarioOrigin = null;
      try {
        const completion = api.runBotScenarioV2(scenario, {
          baseDirectory: root,
          signal: controller.signal,
        });
        scenarioCompletion = completion;
        scenarioResult = await completion;
        scenarioOrigin = { root, source };
        return scenarioResult;
      } finally {
        if (scenarioAbort === controller) {
          scenarioAbort = null;
          scenarioCompletion = null;
        }
      }
    });
  });
  ipcMain.handle('scenario:cancel', (event) => {
    requireTrustedSender(event);
    if (scenarioAbort === null) return false;
    scenarioAbort.abort();
    return true;
  });
  ipcMain.handle('scenario:export', async (event, format: unknown) => {
    requireTrustedSender(event);
    if (
      typeof format !== 'string' ||
      !['json', 'junit', 'html', 'sarif'].includes(format) ||
      scenarioResult === null
    )
      throw new TypeError('Run a scenario before exporting a report.');
    const report = scenarioResult;
    const extension = format === 'junit' ? 'xml' : format;
    const result = await dialog.showSaveDialog({ defaultPath: `disrunner-report.${extension}` });
    if (result.canceled || result.filePath === undefined) return false;
    const content = (await runtimeApi).renderBotScenarioV2Report(
      report,
      format as 'json' | 'junit' | 'html' | 'sarif',
    );
    await atomicExport(result.filePath, content);
    return true;
  });
  ipcMain.handle('scenario:reproduction', async (event) => {
    requireTrustedSender(event);
    if (scenarioResult === null || scenarioOrigin === null)
      throw new Error('Run a scenario before exporting a reproduction bundle.');
    const origin = scenarioOrigin;
    const report = scenarioResult;
    const bundle = await (
      await runtimeApi
    ).createReproductionBundle(origin.root, origin.source, report);
    const selected = await dialog.showSaveDialog({ defaultPath: 'disrunner-reproduction.json' });
    if (selected.canceled || selected.filePath === undefined) return false;
    await atomicExport(selected.filePath, `${JSON.stringify(bundle, null, 2)}\n`);
    return true;
  });
  ipcMain.handle('project:select', async (event) => {
    requireTrustedSender(event);
    return withProjectOperation(async () => {
      requireNoScenario();
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner
        ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || result.filePaths[0] === undefined) return null;
      const selected = await (await runtime).selectProject(result.filePaths[0]);
      if (selected.project !== null) await rememberProject(selected.project.root);
      return selected;
    });
  });
  ipcMain.handle('window:control', (event, action: unknown) => {
    requireTrustedSender(event);
    if (!['minimize', 'maximize', 'close'].includes(String(action))) {
      throw new TypeError('Unsupported window action.');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return false;
    switch (action as WindowAction) {
      case 'minimize':
        window.minimize();
        break;
      case 'maximize':
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case 'close':
        window.close();
        break;
    }
    return true;
  });
}

function configureSession(target: Session): void {
  if (sessionConfigured) return;
  sessionConfigured = true;
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'DisRunner',
    width: 1678,
    height: 941,
    minWidth: 720,
    minHeight: 640,
    backgroundColor: '#14161B',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(applicationRoot, 'dist-electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('will-prevent-unload', (event) => {
    const discard = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved workspace changes',
      message: 'Close without saving your workspace changes?',
    });
    if (discard === 1) event.preventDefault();
    else {
      quitAfterCleanup = false;
      cleanupInProgress = false;
    }
  });
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
    scenarioAbort?.abort();
    void runtime.then((manager) => manager.stop());
  });

  if (!app.isPackaged && developmentUrl === allowedDevelopmentOrigin) {
    void window.loadURL(allowedDevelopmentOrigin);
  } else {
    void window.loadURL(applicationIndexUrl);
  }
  return window;
}

app.on('before-quit', (event) => {
  if (quitAfterCleanup) return;
  event.preventDefault();
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  void runtime
    .then(async (instance) => {
      scenarioAbort?.abort();
      await scenarioCompletion?.catch(() => undefined);
      // Keep the session usable if the renderer's unsaved-changes prompt cancels quitting.
      return instance.stop();
    })
    .then((result) => {
      if (!cleanupConfirmed(result)) {
        cleanupInProgress = false;
        dialog.showErrorBox('Runtime cleanup incomplete', cleanupMessage(result));
        return;
      }
      if (!result.ok) console.error('Runtime exited unexpectedly before cleanup.');
      quitAfterCleanup = true;
      app.quit();
    })
    .catch(() => {
      cleanupInProgress = false;
      dialog.showErrorBox(
        'Runtime cleanup incomplete',
        'Runtime cleanup could not be confirmed. DisRunner has not completed shutdown. Another cleanup attempt may not resolve this; inspect the runtime diagnostics before restarting.',
      );
    });
});

if (!app.requestSingleInstanceLock()) {
  quitAfterCleanup = true;
  app.quit();
} else {
  Promise.all([app.whenReady(), runtime])
    .then(async () => {
      await restoreRecentProject();
      Menu.setApplicationMenu(null);
      configureSession(session.defaultSession);
      registerIpc();
      const window = createWindow();
      app.on('second-instance', () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.focus();
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to initialize DisRunner', error);
      quitAfterCleanup = true;
      app.quit();
    });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
