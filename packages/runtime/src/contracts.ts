import type { LocalAttachmentMetadata, FaultPlan, FaultEvidence } from '@disrunner/core';
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
  readonly guildId?: string;
  readonly channelId: string;
}
export type SessionErrorCode =
  | 'bot-error'
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
  readonly inputs?: {
    readonly schemaVersion: 1;
    readonly fixtureHash: string;
    readonly profileHash: string;
    readonly sourceHash: string | null;
  };
  readonly activeHandlers?: number;
  readonly diagnostics?: readonly SessionIssue[];
  readonly evidenceComplete?: boolean;
  readonly droppedOutput?: number;
  readonly droppedTraces?: number;
  readonly droppedRisks?: number;
  readonly faults?: FaultEvidence;
  readonly interactions?: readonly { readonly id: string; readonly status: string }[];
  readonly commandsTruncated?: boolean;
  readonly commands?: readonly Readonly<Record<string, unknown>>[];
  readonly coreState?: RuntimeCoreSnapshot | null;
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
export interface RuntimeAction {
  readonly type:
    | 'command'
    | 'autocomplete'
    | 'component'
    | 'modal-submit'
    | 'message'
    | 'message-edit'
    | 'message-delete';
  readonly name?: string;
  readonly options?: readonly Readonly<Record<string, unknown>>[];
  readonly customId?: string;
  readonly componentType?: number;
  readonly values?: readonly string[];
  readonly messageId?: string;
  readonly content?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly commandType?: number;
  readonly targetId?: string;
}
export interface RuntimeActionRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly context: InvocationContext;
  readonly action: RuntimeAction;
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
  commandsForContext?(context: InvocationContext): readonly Readonly<Record<string, unknown>>[];
  readAttachment?(
    id: string,
    context: InvocationContext,
  ): Promise<{ metadata: LocalAttachmentMetadata; data: Uint8Array }>;
  importAttachment?(
    relativePath: string,
    context: InvocationContext,
  ): Promise<LocalAttachmentMetadata>;
  setFaults(plans: readonly FaultPlan[]): void;
  selectProject(directory: string): Promise<SessionSnapshot>;
  validateContext(context: InvocationContext): InvocationContext;
  start(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SessionSnapshot>;
  invoke(
    request: InvocationRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionInvocationResult>;
  snapshot(): SessionSnapshot;
  snapshotForActor(actorId: string): SessionSnapshot;
  dispatch(
    request: RuntimeActionRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionInvocationResult>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  stop(): Promise<ShutdownResult>;
  dispose(): Promise<ShutdownResult>;
}

/** Bounded projection of the retained core store, not Session publication revision. */
export interface RuntimeCoreSnapshot {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly stateRevision: number | null;
  readonly revisioned: boolean;
  readonly clock: { readonly domain: 'bot'; readonly mode: 'realtime'; readonly nowMs: number };
  readonly resources: readonly RuntimeResourceView[];
  readonly totalResources: number;
  readonly truncated: boolean;
  readonly evidenceComplete?: boolean;
}

/** Deliberately narrow display DTO. Arbitrary fixture fields never cross this boundary. */
export interface RuntimeAuthorView {
  readonly id: string;
  readonly username?: string;
  readonly global_name?: string | null;
  readonly bot?: boolean;
}
export interface RuntimeResourceView {
  readonly id: string;
  readonly resourceType: 'guild' | 'channel' | 'user' | 'message' | 'role' | 'member';
  readonly name?: string;
  readonly username?: string;
  readonly global_name?: string | null;
  readonly bot?: boolean;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly type?: number;
  readonly content?: string;
  readonly flags?: number;
  readonly visibility?: 'channel' | 'ephemeral';
  readonly visibleTo?: string;
  readonly interaction_id?: string;
  readonly components?: readonly Readonly<Record<string, unknown>>[];
  readonly embeds?: readonly Readonly<Record<string, unknown>>[];
  readonly attachments?: readonly Readonly<Record<string, unknown>>[];
  readonly timestamp?: string;
  readonly edited_timestamp?: string | null;
  readonly author?: RuntimeAuthorView;
}
