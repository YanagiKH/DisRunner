import type { SessionSnapshot, ShutdownResult } from '@disrunner/runtime';

// This intentionally treats all runtime errors conservatively. Null PID/endpoints
// are not evidence that the runtime released its owned resources.
export function runtimeControls(
  runtime: SessionSnapshot,
  pending: 'start' | 'stop' | 'select' | 'sync' | null,
  blocked: boolean,
) {
  return {
    canStart:
      !pending &&
      !blocked &&
      !runtime.disposed &&
      runtime.phase === 'ready' &&
      runtime.project !== null,
    canStop:
      (pending === null || pending === 'start') &&
      (blocked || ['running', 'starting', 'error'].includes(runtime.phase)),
    canSelect:
      !pending && !blocked && !runtime.disposed && ['idle', 'ready'].includes(runtime.phase),
    recovery: runtime.phase === 'error' || blocked,
  };
}

export {
  cleanupConfirmed as confirmsCleanup,
  cleanupMessage as shutdownDetails,
} from '../../electron/shutdown-policy.js';

// Intermediate events from this operation are expected to advance revision.
// Accept a same-run response unless newer conflicting terminal evidence exists.
// Never use the response to overwrite a newer snapshot (App enforces revision).
export function currentStopResult(
  started: SessionSnapshot,
  latest: SessionSnapshot,
  result: ShutdownResult,
): boolean {
  if (
    started.sessionId !== latest.sessionId ||
    started.runId !== latest.runId ||
    result.snapshot.sessionId !== started.sessionId ||
    result.snapshot.runId !== started.runId
  )
    return false;
  if (result.snapshot.revision < latest.revision) {
    return (
      latest.phase === result.snapshot.phase &&
      latest.error === result.snapshot.error &&
      latest.disposed === result.snapshot.disposed
    );
  }
  return true;
}
