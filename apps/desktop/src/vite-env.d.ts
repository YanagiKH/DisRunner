/// <reference types="vite/client" />

interface DisRunnerRuntimeInfo {
  readonly platform: string;
  readonly version: string;
  readonly packaged: boolean;
  readonly offline: true;
}

type DisRunnerRuntimePhase = 'idle' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';

interface DisRunnerProjectSummary {
  readonly root: string;
  readonly configPath: string;
  readonly botName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly adapter: string;
  readonly mode: 'strict' | 'lenient';
  readonly seed: number;
  readonly environmentNames: readonly string[];
}

interface DisRunnerRuntimeState {
  readonly phase: DisRunnerRuntimePhase;
  readonly project: DisRunnerProjectSummary | null;
  readonly error: string | null;
  readonly pid: number | null;
  readonly endpoints: {
    readonly restBaseUrl: string;
    readonly gatewayUrl: string;
    readonly interactionEndpoint?: string;
  } | null;
  readonly output: readonly {
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
    readonly atMs: number;
  }[];
  readonly traces: readonly {
    readonly id: string;
    readonly traceId: string;
    readonly kind: string;
    readonly name: string;
    readonly status: string;
    readonly startedAtMs: number;
    readonly durationMs: number;
  }[];
  readonly risks: readonly {
    readonly ruleId: string;
    readonly severity: string;
    readonly title: string;
    readonly evidence: string;
  }[];
}

interface DisRunnerInvocationResult {
  readonly ok: boolean;
  readonly command: string;
  readonly interactionId: string | null;
  readonly durationMs: number;
  readonly response: {
    readonly type:
      'pong' | 'message' | 'defer' | 'update' | 'defer-update' | 'autocomplete' | 'modal';
    readonly data: Readonly<Record<string, unknown>>;
  } | null;
  readonly error: string | null;
}

interface DisRunnerDesktopBridge {
  readonly getRuntimeInfo: () => Promise<DisRunnerRuntimeInfo>;
  readonly getRuntimeState: () => Promise<DisRunnerRuntimeState>;
  readonly selectProject: () => Promise<DisRunnerRuntimeState | null>;
  readonly startRuntime: () => Promise<DisRunnerRuntimeState>;
  readonly stopRuntime: () => Promise<DisRunnerRuntimeState>;
  readonly invokeCommand: (input: string) => Promise<DisRunnerInvocationResult>;
  readonly onRuntimeState: (listener: (state: DisRunnerRuntimeState) => void) => () => void;
  readonly controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<boolean>;
}

interface Window {
  readonly disrunnerDesktop?: DisRunnerDesktopBridge;
}
