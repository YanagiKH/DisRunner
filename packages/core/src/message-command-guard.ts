import { DiscordApiError } from './interactions.js';
import type { VirtualState } from './state.js';

const activeStates = new WeakSet<VirtualState>();
const sequences = new WeakMap<VirtualState, Map<string, number>>();

export function messageCommandActive(state: VirtualState): boolean {
  return activeStates.has(state);
}
export function assertMessageCommandIdle(state: VirtualState): void {
  if (messageCommandActive(state))
    throw new DiscordApiError(409, 0, 'Reentrant message commands are not supported.');
}
export function withMessageCommand<T>(state: VirtualState, operation: () => T): T {
  assertMessageCommandIdle(state);
  if (typeof state.transactionActive !== 'boolean')
    throw new DiscordApiError(503, 0, 'Outermost message transaction guard is unavailable.');
  if (state.transactionActive)
    throw new DiscordApiError(409, 0, 'Message commands require an outermost transaction.');
  activeStates.add(state);
  try {
    return operation();
  } finally {
    activeStates.delete(state);
  }
}
export function nextMessageSequence(state: VirtualState, runId: string): number {
  const perRun = sequences.get(state);
  if (perRun !== undefined && !perRun.has(runId) && perRun.size >= 128)
    throw new DiscordApiError(503, 0, 'Message run registration capacity exceeded.');
  const previous = perRun?.get(runId) ?? 0;
  if (previous >= Number.MAX_SAFE_INTEGER)
    throw new DiscordApiError(503, 0, 'Message sequence capacity exceeded.');
  return previous + 1;
}
/** Called once, only after a public message transaction committed. */
export function commitMessageSequence(state: VirtualState, runId: string, sequence: number): void {
  let perRun = sequences.get(state);
  if (perRun === undefined) {
    perRun = new Map();
    sequences.set(state, perRun);
  }
  perRun.set(runId, sequence);
}
