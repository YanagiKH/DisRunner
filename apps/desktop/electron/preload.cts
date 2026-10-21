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
  getRuntimeState: (): Promise<SessionSnapshot> => ipcRenderer.invoke('runtime:get-state'),
  selectProject: (): Promise<SessionSnapshot | null> => ipcRenderer.invoke('project:select'),
  startRuntime: (): Promise<SessionSnapshot> => ipcRenderer.invoke('runtime:start'),
  stopRuntime: (): Promise<ShutdownResult> => ipcRenderer.invoke('runtime:stop'),
  invokeCommand: (request: InvocationRequest): Promise<SessionInvocationResult> =>
    ipcRenderer.invoke('runtime:invoke', request),
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
