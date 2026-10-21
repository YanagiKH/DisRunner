export type {
  InvocationRequest,
  InvocationContext,
  SessionSnapshot,
  SessionEvent,
  SessionInvocationResult,
  ShutdownResult,
  RuntimePhase,
  ProjectSummary,
  RuntimeOutputEntry,
  RuntimeTraceEntry,
  RuntimeRiskEntry,
  RuntimeEndpoints,
  DesktopRuntimeState,
  RuntimeInvocationResult,
} from '@disrunner/runtime';

export interface RuntimeInfo {
  readonly platform: string;
  readonly version: string;
  readonly packaged: boolean;
  readonly offline: true;
}

export type WindowAction = 'minimize' | 'maximize' | 'close';
