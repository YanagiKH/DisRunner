import { contextBridge, ipcRenderer } from 'electron';

import type {
  DesktopRuntimeState,
  RuntimeInfo,
  RuntimeInvocationResult,
  WindowAction,
} from './runtime-contract.cjs';

type RuntimeListener = (state: DesktopRuntimeState) => void;

const desktopBridge = Object.freeze({
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('runtime:get-info'),
  getRuntimeState: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('runtime:get-state'),
  selectProject: (): Promise<DesktopRuntimeState | null> => ipcRenderer.invoke('project:select'),
  startRuntime: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('runtime:start'),
  stopRuntime: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke('runtime:stop'),
  invokeCommand: (input: string): Promise<RuntimeInvocationResult> => {
    if (typeof input !== 'string')
      return Promise.reject(new TypeError('Interaction input must be a string.'));
    return ipcRenderer.invoke('runtime:invoke', input);
  },
  onRuntimeState: (listener: RuntimeListener): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Runtime listener must be a function.');
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopRuntimeState): void => {
      listener(structuredClone(state));
    };
    ipcRenderer.on('runtime:state', handler);
    return () => ipcRenderer.removeListener('runtime:state', handler);
  },
  controlWindow: (action: WindowAction): Promise<boolean> =>
    ipcRenderer.invoke('window:control', action),
});

contextBridge.exposeInMainWorld('disrunnerDesktop', desktopBridge);
