/// <reference types="vite/client" />

import type { RuntimeInfo } from '../electron/runtime-contract.cjs';
import type { LocalAttachmentMetadata } from '@disrunner/core';
import type {
  WorkspaceView,
  WorkspaceDocument,
  ScenarioView,
  ProjectAction,
} from './state/project-workspace';
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
    readonly getRuntimeState: (actorId?: string) => Promise<DisRunnerRuntimeState>;
    readonly getCommands?: (
      context: InvocationContext,
      runId: string,
    ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
    readonly selectProject: () => Promise<DisRunnerRuntimeState | null>;
    readonly startRuntime: () => Promise<DisRunnerRuntimeState>;
    readonly stopRuntime: () => Promise<ShutdownResult>;
    readonly invokeCommand: (
      request: DisRunnerInvocationRequest,
    ) => Promise<DisRunnerInvocationResult>;
    readonly openProject?: (directory: string) => Promise<DisRunnerRuntimeState>;
    readonly openExample?: () => Promise<DisRunnerRuntimeState>;
    readonly pickAttachment?: (
      context: InvocationContext,
    ) => Promise<LocalAttachmentMetadata | null>;
    readonly importAttachment?: (
      relativePath: string,
      context: InvocationContext,
    ) => Promise<LocalAttachmentMetadata>;
    readonly dispatchAction?: (request: {
      runId: string;
      requestId: string;
      context: InvocationContext;
      action: ProjectAction;
    }) => Promise<DisRunnerInvocationResult>;
    readonly getWorkspace?: () => Promise<WorkspaceView>;
    readonly saveAttachment?: (request: {
      runId: string;
      attachmentId: string;
      context: InvocationContext;
    }) => Promise<boolean>;
    readonly saveWorkspace?: (
      document: WorkspaceDocument,
      expectedHash: string | null,
    ) => Promise<WorkspaceView>;
    readonly recoverWorkspace?: (expectedHash: string | null) => Promise<WorkspaceView>;
    readonly runScenario?: (source: string) => Promise<ScenarioView>;
    readonly cancelScenario?: () => Promise<boolean>;
    readonly exportScenario?: (format: 'json' | 'junit' | 'html' | 'sarif') => Promise<boolean>;
    readonly exportReproduction?: () => Promise<boolean>;
    readonly onRuntimeState: (listener: (event: DisRunnerSessionEvent) => void) => () => void;
    readonly controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<boolean>;
  }

  interface Window {
    readonly disrunnerDesktop?: DisRunnerDesktopBridge;
  }
}
