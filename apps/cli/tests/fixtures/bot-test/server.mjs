// Test-owned real child. Peer authentication is copied from the unchanged
// examples/raw-webhook-bot/src/peer-auth.mjs (MIT); this is not a runtime stub.
import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  requireWebhookPeerSecret,
  signWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './peer-auth.mjs';

if (process.env.DISRUNNER_OFFLINE !== '1') throw Error('Offline fixture only.');
const mode = process.env.DISRUNNER_TEST_MODE ?? 'normal';
const modes = new Set([
  'normal',
  'wrong',
  'wrong-safe',
  'pong-only',
  'early-zero',
  'early-crash',
  'startup-stall',
  'body-stall',
  'invalid-auth',
  'foreign-listener',
  'exit-after-observed-response',
]);
if (!modes.has(mode)) throw Error('Unsupported fixture mode.');
const port = Number(process.env.DISRUNNER_BOT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid fixture port.');
const keyHex = process.env.DISRUNNER_PUBLIC_KEY;
if (typeof keyHex !== 'string' || !/^[a-f\d]{64}$/iu.test(keyHex))
  throw Error('Invalid public key.');
const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyHex, 'hex')]),
  format: 'der',
  type: 'spki',
});
const peerSecretHex = requireWebhookPeerSecret(process.env.DISRUNNER_WEBHOOK_PEER_SECRET);
const tracePath = process.env.DISRUNNER_TEST_TRACE;
function trace(event, fields = {}) {
  // Never retain headers, credentials, environment or raw signed payloads.
  if (tracePath)
    appendFileSync(tracePath, JSON.stringify({ event, pid: process.pid, ...fields }) + '\n');
}
trace('launch', {
  mode,
  port,
  restPort: Number(process.env.DISRUNNER_REST_PORT),
  gatewayPort: Number(process.env.DISRUNNER_GATEWAY_PORT),
});
if (mode === 'early-zero' || mode === 'early-crash') {
  trace('exit', { code: mode === 'early-zero' ? 0 : 17 });
  process.exit(mode === 'early-zero' ? 0 : 17);
}
const sockets = new Set();
const server = createServer(
  { requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 250 },
  (request, response) => {
    if (request.method !== 'POST' || request.url !== '/interactions') {
      response.writeHead(404).end();
      return;
    }
    let count = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      count += chunk.length;
      if (count > 1048576) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {});
    response.on('error', () => {});
    response.on('close', () => trace('response-closed'));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const timestamp = request.headers['x-signature-timestamp'];
      const signature = request.headers['x-signature-ed25519'];
      if (
        typeof timestamp !== 'string' ||
        !/^\d{1,16}$/u.test(timestamp) ||
        typeof signature !== 'string' ||
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
      let interaction;
      try {
        interaction = JSON.parse(rawBody.toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const ping = interaction.type === 1;
      trace(ping ? 'readiness' : 'command', {
        authenticatedRequest: true,
        ...(ping
          ? {}
          : {
              command: interaction.data?.name,
              actorId: interaction.member?.user?.id,
              actorName: interaction.member?.user?.username,
              guildId: interaction.guild_id,
              channelId: interaction.channel_id,
              hasInventedRoles: Object.hasOwn(interaction.member ?? {}, 'roles'),
            }),
      });
      if ((ping && mode === 'startup-stall') || (!ping && mode === 'pong-only')) return;
      const content =
        mode === 'wrong'
          ? 'WRONG BOT RESPONSE'
          : mode === 'wrong-safe'
            ? 'Different offline reply.'
            : 'Pong! Offline and deterministic.';
      const body = Buffer.from(JSON.stringify(ping ? { type: 1 } : { type: 4, data: { content } }));
      const authentication = signWebhookResponseAuthentication({
        peerSecretHex,
        timestamp,
        status: 200,
        requestBody: rawBody,
        responseBody: body,
      });
      const headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
      if (mode !== 'foreign-listener')
        headers[WEBHOOK_RESPONSE_AUTH_HEADER] =
          mode === 'invalid-auth' ? '0'.repeat(64) : authentication;
      response.writeHead(200, headers);
      if (!ping && mode === 'body-stall') {
        response.flushHeaders();
        response.write(body.subarray(0, 1));
        trace('body-started', { bytesSent: 1, advertisedBytes: body.length });
        return;
      }
      response.end(body, () => {
        trace(ping ? 'readiness-response' : 'callback', {
          responseType: ping ? 'pong' : 'message',
          ...(ping || mode === 'wrong' ? {} : { content }),
          authenticatedResponse: mode !== 'invalid-auth' && mode !== 'foreign-listener',
        });
        if (!ping && mode === 'exit-after-observed-response') {
          const gate = process.env.DISRUNNER_TEST_EXIT_GATE;
          if (!gate) throw Error('Observed-response fixture requires a test-owned exit gate.');
          setInterval(() => {
            if (existsSync(gate)) {
              trace('exit', { code: 0, gateAcknowledged: true });
              process.exit(0);
            }
          }, 5);
          setTimeout(() => {
            trace('gate-timeout', { code: 17 });
            process.exit(17);
          }, 3000);
        }
      });
    });
  },
);
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.listen(port, '127.0.0.1', () => trace('listening', { port }));
function stop(signal) {
  trace('shutdown', { signal });
  for (const socket of sockets) socket.destroy();
  server.close(() => {
    trace('exit', { code: 0 });
    process.exit(0);
  });
}
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
