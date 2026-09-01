export type SimulationMode = 'strict' | 'lenient';

export interface SimulationProfile {
  readonly seed: number;
  readonly mode: SimulationMode;
  readonly apiVersion: 10;
  readonly interactionDeadlineMs: 3_000;
  readonly interactionTokenTtlMs: 900_000;
  readonly networkPolicy: 'offline';
}

export interface TraceSpan {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly kind:
    | 'user-action'
    | 'gateway'
    | 'interaction'
    | 'bot-handler'
    | 'rest'
    | 'state-mutation'
    | 'database'
    | 'external'
    | 'render';
  readonly name: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'warning' | 'error';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RiskFinding {
  readonly ruleId: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly confidence: number;
  readonly title: string;
  readonly evidence: string;
  readonly impact: string;
  readonly recommendation: string;
  readonly traceId?: string;
  readonly eventId?: string;
  readonly sourceLocation?: string;
  readonly reproductionSteps?: readonly string[];
  readonly documentationReference?: string;
  readonly suppressionReason?: string;
  readonly firstSeenAtMs?: number;
  readonly lastSeenAtMs?: number;
}

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly effective: bigint;
  readonly requested: bigint;
  readonly sources: readonly {
    readonly source: string;
    readonly effect: 'allow' | 'deny' | 'neutral';
    readonly bits: bigint;
    readonly reason: string;
  }[];
  readonly reason: string;
}

export interface SimulationReport {
  readonly runId: string;
  readonly seed: number;
  readonly startedAt: string;
  readonly passed: boolean;
  readonly spans: readonly TraceSpan[];
  readonly risks: readonly RiskFinding[];
  readonly stateHash: string;
  readonly status?: 'passed' | 'failed' | 'warning' | 'cancelled';
  readonly assertions?: readonly ScenarioAssertionResult[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type DiscordResourceType =
  | 'application'
  | 'user'
  | 'guild'
  | 'member'
  | 'role'
  | 'channel'
  | 'thread'
  | 'message'
  | 'interaction'
  | 'webhook'
  | 'reaction'
  | 'emoji'
  | 'sticker'
  | 'poll'
  | 'invite'
  | 'ban'
  | 'presence'
  | 'voice-state'
  | 'scheduled-event'
  | 'stage-instance'
  | 'automod-rule'
  | 'entitlement'
  | 'subscription'
  | 'sku'
  | 'soundboard-sound'
  | (string & {});

export interface ResourceRecord {
  readonly id: string;
  readonly resourceType: DiscordResourceType;
  readonly [field: string]: unknown;
}

export interface StateSnapshot {
  readonly version: 1;
  readonly takenAtMs: number;
  readonly resources: readonly ResourceRecord[];
  readonly hash: string;
}

export interface StateDiff {
  readonly added: readonly ResourceRecord[];
  readonly updated: readonly {
    readonly before: ResourceRecord;
    readonly after: ResourceRecord;
    readonly changedFields: readonly string[];
  }[];
  readonly deleted: readonly ResourceRecord[];
}

export interface GatewayDispatch {
  readonly op: 0;
  readonly t: string;
  readonly s: number;
  readonly d: unknown;
}

export type ScenarioAction =
  | {
      readonly type: 'advance-time';
      readonly ms: number;
    }
  | {
      readonly type: 'create-resource';
      readonly resourceType: DiscordResourceType;
      readonly data: Readonly<Record<string, unknown>>;
      readonly saveAs?: string;
    }
  | {
      readonly type: 'update-resource';
      readonly resourceType: DiscordResourceType;
      readonly id: string;
      readonly changes: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'delete-resource';
      readonly resourceType: DiscordResourceType;
      readonly id: string;
    }
  | {
      readonly type: 'send-message';
      readonly channelId: string;
      readonly authorId: string;
      readonly content: string;
      readonly saveAs?: string;
    }
  | {
      readonly type: 'gateway-dispatch';
      readonly event: string;
      readonly data: unknown;
    }
  | {
      readonly type: 'gateway-disconnect';
    }
  | {
      readonly type: 'gateway-resume';
      readonly sequence?: number;
    }
  | {
      readonly type: 'interaction-create';
      readonly interactionType?: string;
      readonly data?: Readonly<Record<string, unknown>>;
      readonly saveAs?: string;
    }
  | {
      readonly type: 'interaction-respond';
      readonly interactionId: string;
      readonly responseType:
        'message' | 'defer' | 'update' | 'defer-update' | 'autocomplete' | 'modal';
      readonly data?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'interaction-followup';
      readonly interactionId: string;
      readonly data?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'rate-limit-request';
      readonly method: string;
      readonly path: string;
    }
  | {
      readonly type: 'timeline-interaction';
      readonly at: number;
      readonly command: string;
      readonly acknowledgeAfterMs: number;
      readonly followUpAfterMs?: number;
    }
  | {
      readonly type: 'timeline-gateway-disconnect';
      readonly at: number;
      readonly resumable?: boolean;
    }
  | {
      readonly type: 'timeline-gateway-resume';
      readonly at: number;
    }
  | {
      readonly type: 'timeline-permission-check';
      readonly at: number;
      readonly permission: string;
      readonly expected?: 'allowed' | 'denied';
    }
  | {
      readonly type: 'timeline-rest-request';
      readonly at: number;
      readonly method: string;
      readonly path: string;
      readonly repeat?: number;
    };

export type ScenarioAssertion =
  | {
      readonly type: 'resource-exists';
      readonly resourceType: DiscordResourceType;
      readonly id: string;
    }
  | {
      readonly type: 'resource-field-equals';
      readonly resourceType: DiscordResourceType;
      readonly id: string;
      readonly field: string;
      readonly expected: unknown;
    }
  | {
      readonly type: 'event-received';
      readonly event: string;
      readonly count?: number;
    }
  | {
      readonly type: 'risk-present' | 'risk-absent';
      readonly ruleId: string;
    }
  | {
      readonly type: 'interaction-state';
      readonly interactionId: string;
      readonly state: string;
    }
  | {
      readonly type: 'state-hash';
      readonly expected: string;
    }
  | {
      readonly type: 'interaction-acknowledged';
      readonly command: string;
      readonly withinMs?: number;
    }
  | {
      readonly type: 'risk-detected';
      readonly ruleId: string;
    }
  | {
      readonly type: 'gateway-resumed' | 'no-secret-leak';
    };

export interface ScenarioDefinition {
  readonly version?: 1;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly seed?: number;
  readonly mode?: SimulationMode;
  readonly initialState?: readonly (Readonly<Record<string, unknown>> & {
    readonly resourceType: DiscordResourceType;
  })[];
  readonly steps: readonly ScenarioAction[];
  readonly assertions?: readonly ScenarioAssertion[];
}

export interface ScenarioAssertionResult {
  readonly assertion: ScenarioAssertion;
  readonly type: string;
  readonly description?: string;
  readonly passed: boolean;
  readonly message: string;
  readonly actual?: unknown;
}

export interface ScenarioRunResult {
  readonly report: SimulationReport;
  readonly assertions: readonly ScenarioAssertionResult[];
  readonly finalState: StateSnapshot;
  readonly events: readonly GatewayDispatch[];
}
