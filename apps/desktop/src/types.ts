export type Surface =
  'simulator' | 'guild-editor' | 'scenario-lab' | 'command-explorer' | 'risk-center' | 'settings';

export type InspectorTab =
  'Trace' | 'Payload' | 'State Diff' | 'Permissions' | 'Rate Limits' | 'Risks';

export type BotStatus =
  'idle' | 'ready' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export type ResponseState =
  | 'immediate'
  | 'deferred'
  | 'follow-up'
  | 'ephemeral'
  | 'timeout'
  | 'denied'
  | 'rate-limited'
  | 'resumed'
  | 'system';

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly locked?: boolean;
}

export interface ChannelGroup {
  readonly id: string;
  readonly name: string;
  readonly channels: readonly Channel[];
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly role: 'bot' | 'developer' | 'operator' | 'moderator' | 'member';
  readonly status: 'online' | 'offline';
  readonly color: string;
  readonly detail?: string;
}

export interface Guild {
  readonly id: string;
  readonly name: string;
  readonly accent: string;
  readonly mark: string;
  readonly groups: readonly ChannelGroup[];
  readonly members: readonly Member[];
}

export interface ChatMessage {
  readonly id: string;
  readonly author: string;
  readonly authorRole: Member['role'];
  readonly content: string;
  readonly time: string;
  readonly responseState?: ResponseState;
  readonly metadata?: string;
  readonly parentId?: string;
  readonly command?: string;
}

export type TraceOutcome =
  'Passed' | 'Deferred' | 'Timed out' | 'Denied' | 'Rate limited' | 'Resumed';

export interface TraceStep {
  readonly id: string;
  readonly label: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly tone: 'success' | 'info' | 'warning' | 'danger';
}

export interface InteractionTrace {
  readonly id: string;
  readonly command: string;
  readonly user: string;
  readonly channel: string;
  readonly interactionId: string;
  readonly createdAt: string;
  readonly outcome: TraceOutcome;
  readonly severity: 'none' | 'medium' | 'high';
  readonly durationMs: number;
  readonly steps: readonly TraceStep[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly details: string;
  readonly recommendation: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly response: string;
  readonly shortcut: string;
  readonly color: string;
}
