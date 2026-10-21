// Lifecycle fixture: an owned grandchild that stays in its parent's process group.
// argv[2] === 'ignore-term' makes it ignore SIGTERM. It reports its own identity
// as one JSON line on stdout (inherited from the runner) and signals readiness on fd 3.
import { readFileSync, writeSync } from 'node:fs';

const ignoreTerm = process.argv[2] === 'ignore-term';
if (ignoreTerm) process.on('SIGTERM', () => undefined);

function identity(role) {
  const record = { role, pid: process.pid, ppid: process.ppid, pgid: null, starttime: null };
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    record.pgid = Number(fields[2]);
    record.starttime = fields[19];
  } catch {
    /* Non-Linux platform: /proc identity unavailable. */
  }
  return record;
}

process.stdout.write(`${JSON.stringify({ ...identity('grandchild'), ignoreTerm })}\n`);
try {
  writeSync(3, 'ready\n');
} catch {
  /* No readiness pipe supplied. */
}
setInterval(() => undefined, 1_000);
