import { contextBridge, ipcRenderer } from 'electron';

import type {
  SessionSnapshot,
  RuntimeInfo,
  InvocationRequest,
  SessionEvent,
  ShutdownResult,
  SessionInvocationResult,
  WindowAction,
} from './runtime-contract.cjs';

type RuntimeListener = (state: SessionEvent) => void;

const desktopBridge = Object.freeze({
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('runtime:get-info'),
  getRuntimeState: (actorId?: string): Promise<SessionSnapshot> =>
    ipcRenderer.invoke('runtime:get-state', actorId),
  getCommands: (context: unknown, runId: string) =>
    ipcRenderer.invoke('runtime:commands', context, runId),
  selectProject: (): Promise<SessionSnapshot | null> => ipcRenderer.invoke('project:select'),
  openProject: (directory: string): Promise<SessionSnapshot> =>
    ipcRenderer.invoke('project:open', directory),
  openExample: (): Promise<SessionSnapshot> => ipcRenderer.invoke('project:example'),
  pickAttachment: (context: unknown) => ipcRenderer.invoke('attachment:pick', context),
  importAttachment: (relativePath: string, context: unknown) =>
    ipcRenderer.invoke('attachment:import', relativePath, context),
  startRuntime: (): Promise<SessionSnapshot> => ipcRenderer.invoke('runtime:start'),
  stopRuntime: (): Promise<ShutdownResult> => ipcRenderer.invoke('runtime:stop'),
  invokeCommand: (request: InvocationRequest): Promise<SessionInvocationResult> =>
    ipcRenderer.invoke('runtime:invoke', request),
  dispatchAction: (request: unknown): Promise<SessionInvocationResult> =>
    ipcRenderer.invoke('runtime:dispatch', request),
  getWorkspace: () => ipcRenderer.invoke('workspace:read'),
  saveAttachment: (request: unknown) => ipcRenderer.invoke('attachment:save', request),
  saveWorkspace: (document: unknown, expectedHash: string | null) =>
    ipcRenderer.invoke('workspace:save', document, expectedHash),
  recoverWorkspace: (expectedHash: string | null) =>
    ipcRenderer.invoke('workspace:recover', expectedHash),
  runScenario: (source: string) => ipcRenderer.invoke('scenario:run', source),
  cancelScenario: () => ipcRenderer.invoke('scenario:cancel'),
  exportScenario: (format: string) => ipcRenderer.invoke('scenario:export', format),
  exportReproduction: () => ipcRenderer.invoke('scenario:reproduction'),
  onRuntimeState: (listener: RuntimeListener): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Runtime listener must be a function.');
    const handler = (_event: Electron.IpcRendererEvent, state: SessionEvent): void => {
      listener(structuredClone(state));
    };
    ipcRenderer.on('runtime:state', handler);
    return () => ipcRenderer.removeListener('runtime:state', handler);
  },
  controlWindow: (action: WindowAction): Promise<boolean> =>
    ipcRenderer.invoke('window:control', action),
});

contextBridge.exposeInMainWorld('disrunnerDesktop', desktopBridge);
