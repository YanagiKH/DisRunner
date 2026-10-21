// Lifecycle fixture: the direct child started by BotRunner.
// Modes (argv[2]):
//   stubborn         ignores SIGTERM, no descendants
//   tree-clean-exit  starts a same-pgid grandchild, then exits 0 unexpectedly
//   tree-term-exit   exits 0 on SIGTERM; its same-pgid grandchild ignores SIGTERM
//   stubborn-tree    parent and same-pgid grandchild both ignore SIGTERM
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'stubborn';
const grandchildPath = fileURLToPath(new URL('./grandchild.mjs', import.meta.url));

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

function startGrandchild(ignoreTerm) {
  return new Promise((resolvePromise, reject) => {
    // Not detached: the grandchild stays in the runner-owned process group.
    const grandchild = spawn(process.execPath, [grandchildPath, ignoreTerm ? 'ignore-term' : ''], {
      stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
    });
    grandchild.once('error', reject);
    grandchild.stdio[3].once('data', () => {
      grandchild.stdio[3].destroy();
      resolvePromise(grandchild);
    });
  });
}

process.stdout.write(`${JSON.stringify({ ...identity('parent'), mode })}\n`);
setInterval(() => undefined, 1_000);

if (mode === 'stubborn') {
  process.on('SIGTERM', () => undefined);
} else if (mode === 'tree-clean-exit') {
  await startGrandchild(false);
  process.stdout.write(`${JSON.stringify({ role: 'parent', event: 'exiting', code: 0 })}\n`);
  process.exit(0);
} else if (mode === 'tree-term-exit') {
  process.on('SIGTERM', () => process.exit(0));
  await startGrandchild(true);
  process.stdout.write(`${JSON.stringify({ role: 'parent', event: 'tree-ready' })}\n`);
} else if (mode === 'stubborn-tree') {
  process.on('SIGTERM', () => undefined);
  await startGrandchild(true);
  process.stdout.write(`${JSON.stringify({ role: 'parent', event: 'tree-ready' })}\n`);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
