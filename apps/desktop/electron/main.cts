import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import type { IpcMainInvokeEvent, Session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DesktopRuntimeManager } from './runtime-manager.cjs';
import type { RuntimeEndpoints, WindowAction } from './runtime-contract.cjs';

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

const runtime = new DesktopRuntimeManager((state) => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:state', state);
  }
}, setRuntimeEndpoints);

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
  ipcMain.handle('runtime:get-state', (event) => {
    requireTrustedSender(event);
    return runtime.snapshot();
  });
  ipcMain.handle('runtime:start', async (event) => {
    requireTrustedSender(event);
    return runtime.start();
  });
  ipcMain.handle('runtime:stop', async (event) => {
    requireTrustedSender(event);
    return runtime.stop();
  });
  ipcMain.handle('runtime:invoke', async (event, input: unknown) => {
    requireTrustedSender(event);
    if (typeof input !== 'string') throw new TypeError('Interaction input must be a string.');
    return runtime.invoke(input);
  });
  ipcMain.handle('project:select', async (event) => {
    requireTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths[0] === undefined) return null;
    return runtime.selectProject(result.filePaths[0]);
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
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
    void runtime.stop();
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
  void runtime.stop().finally(() => {
    quitAfterCleanup = true;
    app.quit();
  });
});

if (!app.requestSingleInstanceLock()) {
  quitAfterCleanup = true;
  app.quit();
} else {
  app
    .whenReady()
    .then(() => {
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
