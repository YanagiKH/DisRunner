import type { ShutdownResult } from './runtime-contract.cjs';

export function cleanupConfirmed(result: ShutdownResult): boolean {
  return (
    ['ready', 'idle'].includes(result.snapshot.phase) &&
    result.errors.every((issue) => issue.code === 'child-exited') &&
    (result.ok || result.errors.length > 0)
  );
}

export function cleanupMessage(result: ShutdownResult): string {
  return (
    result.errors.map((issue) => issue.message).join('; ') ||
    'Session cleanup did not confirm success.'
  );
}
