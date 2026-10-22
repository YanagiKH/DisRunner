/**
 * Internal resource lifecycle types and the instance-scoped dependency seam.
 *
 * The structural resource shapes below are the ones the runtime manager owns. The optional
 * wrappers let an internal caller observe or decorate each real resource after it has been
 * constructed and assigned to its owned field, and before it is started. Production supplies no
 * wrappers (identity). This module is not exported from the package entry point.
 */

export interface BotSnapshotLike {
  readonly status: string;
  readonly pid?: number;
  readonly startedAtMs?: number;
  readonly exitedAtMs?: number;
}

export interface BotRunnerLike {
  start(config: Readonly<Record<string, unknown>>): Promise<BotSnapshotLike>;
  stop(graceMs?: number): Promise<BotSnapshotLike>;
  snapshot(): BotSnapshotLike;
  observeExit?(): 'alive' | 'exited' | 'unknown';
}

export interface RestServerLike {
  start(port?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export interface GatewayServerLike {
  readonly address?: unknown;
  start(port?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export interface RuntimeResourceDependencies {
  readonly wrapBot?: (resource: BotRunnerLike) => BotRunnerLike;
  readonly wrapRest?: (resource: RestServerLike) => RestServerLike;
  readonly wrapGateway?: (resource: GatewayServerLike) => GatewayServerLike;
}

/** Copies and freezes the selected callbacks so later mutation cannot change the seam. */
export function freezeResourceDependencies(
  dependencies: RuntimeResourceDependencies,
): Required<RuntimeResourceDependencies> {
  const wrapBot = dependencies.wrapBot;
  const wrapRest = dependencies.wrapRest;
  const wrapGateway = dependencies.wrapGateway;
  return Object.freeze({
    wrapBot: typeof wrapBot === 'function' ? wrapBot : identity,
    wrapRest: typeof wrapRest === 'function' ? wrapRest : identity,
    wrapGateway: typeof wrapGateway === 'function' ? wrapGateway : identity,
  });
}

function identity<T>(resource: T): T {
  return resource;
}
