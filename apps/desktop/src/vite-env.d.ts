/// <reference types="vite/client" />

import type { RuntimeInfo } from '../electron/runtime-contract.cjs';
import type {
  RuntimePhase,
  ProjectSummary,
  SessionSnapshot,
  SessionInvocationResult,
  InvocationRequest,
  InvocationContext,
  SessionEvent,
  ShutdownResult,
} from '@disrunner/runtime';

declare global {
  type DisRunnerRuntimeInfo = RuntimeInfo;
  type DisRunnerRuntimePhase = RuntimePhase;
  type DisRunnerProjectSummary = ProjectSummary;
  type DisRunnerRuntimeState = SessionSnapshot;
  type DisRunnerInvocationResult = SessionInvocationResult;
  type DisRunnerInvocationRequest = InvocationRequest;
  type DisRunnerInvocationContext = InvocationContext;
  type DisRunnerSessionEvent = SessionEvent;

  interface DisRunnerDesktopBridge {
    readonly getRuntimeInfo: () => Promise<DisRunnerRuntimeInfo>;
    readonly getRuntimeState: () => Promise<DisRunnerRuntimeState>;
    readonly selectProject: () => Promise<DisRunnerRuntimeState | null>;
    readonly startRuntime: () => Promise<DisRunnerRuntimeState>;
    readonly stopRuntime: () => Promise<ShutdownResult>;
    readonly invokeCommand: (
      request: DisRunnerInvocationRequest,
    ) => Promise<DisRunnerInvocationResult>;
    readonly onRuntimeState: (listener: (event: DisRunnerSessionEvent) => void) => () => void;
    readonly controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<boolean>;
  }

  interface Window {
    readonly disrunnerDesktop?: DisRunnerDesktopBridge;
  }
}
