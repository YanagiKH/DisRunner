export type RuntimePhase = 'idle' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';

export interface ProjectSummary {
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

export interface RuntimeOutputEntry {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly atMs: number;
}

export interface RuntimeTraceEntry {
  readonly id: string;
  readonly traceId: string;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
}

export interface RuntimeRiskEntry {
  readonly ruleId: string;
  readonly severity: string;
  readonly title: string;
  readonly evidence: string;
}

export interface RuntimeEndpoints {
  readonly restBaseUrl: string;
  readonly gatewayUrl: string;
  readonly interactionEndpoint?: string;
}

export interface DesktopRuntimeState {
  readonly phase: RuntimePhase;
  readonly project: ProjectSummary | null;
  readonly error: string | null;
  readonly pid: number | null;
  readonly endpoints: RuntimeEndpoints | null;
  readonly output: readonly RuntimeOutputEntry[];
  readonly traces: readonly RuntimeTraceEntry[];
  readonly risks: readonly RuntimeRiskEntry[];
}

export interface RuntimeInfo {
  readonly platform: string;
  readonly version: string;
  readonly packaged: boolean;
  readonly offline: true;
}

export interface RuntimeInvocationResult {
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

export type WindowAction = 'minimize' | 'maximize' | 'close';

export function emptyRuntimeState(): DesktopRuntimeState {
  return {
    phase: 'idle',
    project: null,
    error: null,
    pid: null,
    endpoints: null,
    output: [],
    traces: [],
    risks: [],
  };
}
