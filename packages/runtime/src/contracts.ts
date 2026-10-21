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

export interface InvocationContext {
  readonly actorId: string;
  readonly guildId: string;
  readonly channelId: string;
}
export type SessionErrorCode =
  | 'invalid'
  | 'cancelled'
  | 'timeout'
  | 'not-running'
  | 'start-failed'
  | 'child-exited'
  | 'transport'
  | 'peer-auth'
  | 'cleanup';
export interface SessionIssue {
  readonly code: SessionErrorCode;
  readonly message: string;
}
export class SessionError extends Error {
  public constructor(
    public readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}
export interface SessionSnapshot extends DesktopRuntimeState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly revision: number;
  readonly disposed: boolean;
  readonly contexts: readonly InvocationContext[];
}
export interface SessionEvent {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly sequence: number;
  readonly kind: 'snapshot';
  readonly snapshot: SessionSnapshot;
}
export interface InvocationRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly input: string;
  readonly context: InvocationContext;
}
export interface SessionInvocationResult extends RuntimeInvocationResult {
  readonly runId: string;
  readonly requestId: string;
  readonly context: InvocationContext;
}
export interface ShutdownResult {
  readonly ok: boolean;
  readonly errors: readonly SessionIssue[];
  readonly snapshot: SessionSnapshot;
}
export interface Session {
  selectProject(directory: string): Promise<SessionSnapshot>;
  validateContext(context: InvocationContext): InvocationContext;
  start(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SessionSnapshot>;
  invoke(
    request: InvocationRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionInvocationResult>;
  snapshot(): SessionSnapshot;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  stop(): Promise<ShutdownResult>;
  dispose(): Promise<ShutdownResult>;
}
