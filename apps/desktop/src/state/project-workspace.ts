import type { ResourceRecord } from '@disrunner/core';

export interface WorkspaceDocument {
  readonly version: 1;
  readonly resources: readonly ResourceRecord[];
  readonly scenarios: readonly {
    readonly name: string;
    readonly format: 'json' | 'yaml';
    readonly source: string;
  }[];
  readonly options: { readonly seed: number; readonly mode: 'strict' | 'lenient' };
}

export interface WorkspaceView {
  readonly status: 'missing' | 'ready' | 'future' | 'corrupt';
  readonly path: string;
  readonly hash: string | null;
  readonly document: WorkspaceDocument | null;
  readonly version: number | null;
  readonly backupAvailable: boolean;
  readonly error: string | null;
}

export type ProjectAction = {
  readonly type:
    | 'command'
    | 'autocomplete'
    | 'component'
    | 'modal-submit'
    | 'message'
    | 'message-edit'
    | 'message-delete';
  readonly name?: string;
  readonly options?: readonly Record<string, unknown>[];
  readonly customId?: string;
  readonly componentType?: number;
  readonly values?: readonly string[];
  readonly messageId?: string;
  readonly content?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly commandType?: number;
  readonly targetId?: string;
};

export interface ScenarioView {
  readonly status: string;
  readonly exitCode: number;
  readonly name: string;
  readonly runId: string | null;
  readonly assertions: readonly unknown[];
  readonly issues: readonly unknown[];
  readonly [key: string]: unknown;
}
