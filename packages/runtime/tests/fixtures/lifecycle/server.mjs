// Lifecycle fixture bot for packages/runtime/tests/lifecycle.test.mjs (offline, loopback only).
//
// Mode selection uses an ordinary, non-secret control file: <TMPDIR>/disrunner-lifecycle-control.json
// containing {"mode": string, "reportPath": string}. TMPDIR is one of BotRunner's default inherited
// environment keys; no credentials, tokens or network addresses are carried by the control file.
//
// Every process (this bot and its same-process-group grandchild) appends its own identity
// {role,pid,ppid,pgid,starttime} and lifecycle events as JSON lines to reportPath.
import { spawn } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, readFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signWebhookResponseAuthentication, WEBHOOK_RESPONSE_AUTH_HEADER } from './peer-auth.mjs';

const CONTROL_NAME = 'disrunner-lifecycle-control.json';

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

function reporter(reportPath) {
  return (entry) => {
    const line = `${JSON.stringify({ ...entry, atMs: Date.now() })}\n`;
    if (reportPath) appendFileSync(reportPath, line);
  };
}

if (process.argv[2] === '--grandchild') {
  const report = reporter(process.argv[3]);
  if (process.argv[4] === 'ignore-term') {
    process.on('SIGTERM', () => report({ role: 'grandchild', pid: process.pid, event: 'sigterm' }));
  }
  report({ ...identity('grandchild'), event: 'identity' });
  try {
    writeSync(3, 'ready\n');
  } catch {
    /* No readiness pipe supplied. */
  }
  setInterval(() => undefined, 1_000);
} else {
  await runBot();
}

function readControl() {
  const directory = process.env.TMPDIR;
  if (!directory) return { mode: 'normal', reportPath: null };
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONTROL_NAME), 'utf8'));
    return {
      mode: typeof parsed.mode === 'string' ? parsed.mode : 'normal',
      reportPath: typeof parsed.reportPath === 'string' ? parsed.reportPath : null,
    };
  } catch {
    return { mode: 'normal', reportPath: null };
  }
}

function startGrandchild(reportPath, ignoreTerm) {
  return new Promise((resolvePromise, reject) => {
    // Not detached: the grandchild stays in the runner-owned process group.
    const grandchild = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        '--grandchild',
        reportPath ?? '',
        ignoreTerm ? 'ignore-term' : '',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
    );
    grandchild.once('error', reject);
    grandchild.stdio[3].once('data', () => {
      grandchild.stdio[3].destroy();
      resolvePromise();
    });
  });
}

async function runBot() {
  const { mode, reportPath } = readControl();
  const report = reporter(reportPath);
  report({ ...identity('parent'), event: 'identity', mode });

  const stubborn = mode === 'stubborn-tree';
  let server = null;
  process.on('SIGTERM', () => {
    report({ role: 'parent', pid: process.pid, event: 'sigterm' });
    if (stubborn) return;
    server?.closeAllConnections();
    process.exit(0);
  });
  setInterval(() => undefined, 1_000);

  await startGrandchild(reportPath, stubborn);

  if (mode === 'exit-startup-0' || mode === 'exit-startup-1') {
    const code = mode === 'exit-startup-0' ? 0 : 1;
    report({ role: 'parent', pid: process.pid, event: 'exiting', code });
    process.exit(code);
  }
  if (mode === 'stall-tcp') {
    report({ role: 'parent', pid: process.pid, event: 'not-listening' });
    return;
  }

  const publicKey = ed25519PublicKey(process.env.DISRUNNER_PUBLIC_KEY ?? '');
  const peerSecretHex = process.env.DISRUNNER_WEBHOOK_PEER_SECRET ?? '';
  const port = Number(process.env.DISRUNNER_BOT_PORT);
  server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/interactions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const timestamp = String(request.headers['x-signature-timestamp'] ?? '');
      const signature = String(request.headers['x-signature-ed25519'] ?? '');
      if (
        !/^\d{1,16}$/u.test(timestamp) ||
        !/^[a-f\d]{128}$/iu.test(signature) ||
        !verify(
          null,
          Buffer.concat([Buffer.from(timestamp), rawBody]),
          publicKey,
          Buffer.from(signature, 'hex'),
        )
      ) {
        response.writeHead(401).end();
        return;
      }
      const interaction = JSON.parse(rawBody.toString('utf8'));
      const auth = { peerSecretHex, timestamp, requestBody: rawBody };
      if (interaction.type === 1) {
        if (mode === 'stall-ping') {
          report({ role: 'parent', pid: process.pid, event: 'ping-held' });
          return;
        }
        report({ role: 'parent', pid: process.pid, event: 'ping' });
        sendJson(response, { type: 1 }, auth);
        return;
      }
      const name = interaction.data?.name;
      report({ role: 'parent', pid: process.pid, event: 'command', name });
      if (name === 'stall-body') {
        const body = Buffer.from(
          JSON.stringify({ type: 4, data: { content: 'never completed' } }),
          'utf8',
        );
        response.on('close', () =>
          report({ role: 'parent', pid: process.pid, event: 'stall-body-socket-closed' }),
        );
        response.writeHead(200, headersFor(body, auth));
        response.write(body.subarray(0, 5));
        report({ role: 'parent', pid: process.pid, event: 'stall-body-headers' });
        return;
      }
      if (name === 'slow') {
        setTimeout(() => {
          sendJson(response, { type: 4, data: { content: 'late' } }, auth);
          report({ role: 'parent', pid: process.pid, event: 'slow-sent' });
        }, 400);
        return;
      }
      if (name === 'exit0' || name === 'exit1') {
        sendJson(response, { type: 4, data: { content: `exiting ${name}` } }, auth);
        setTimeout(() => {
          const code = name === 'exit0' ? 0 : 1;
          report({ role: 'parent', pid: process.pid, event: 'exiting', code });
          process.exit(code);
        }, 100);
        return;
      }
      sendJson(response, { type: 4, data: { content: `pong:${String(name)}` } }, auth);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    report({ role: 'parent', pid: process.pid, event: 'listening', port });
  });
}

function headersFor(body, auth) {
  return {
    'content-type': 'application/json',
    'content-length': String(body.length),
    [WEBHOOK_RESPONSE_AUTH_HEADER]: signWebhookResponseAuthentication({
      ...auth,
      status: 200,
      responseBody: body,
    }),
  };
}

function sendJson(response, value, auth) {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(200, headersFor(body, auth));
  response.end(body);
}

function ed25519PublicKey(rawHex) {
  if (!/^[a-f\d]{64}$/iu.test(rawHex)) throw new Error('DISRUNNER_PUBLIC_KEY is required.');
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(rawHex, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
}
