// Real child fixture using the same request verification and response authentication
// as bot.mjs. Credentials and ordinary-message identity remain in child memory.
import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requireWebhookPeerSecret,
  signWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './peer-auth.mjs';

const diagnostic = 'G1 callback diagnostic only.';
const snowflake = /^[1-9]\d{0,19}$/u;
function requireId(value) {
  if (typeof value !== 'string' || !snowflake.test(value)) throw Error('Invalid fixture identity.');
  return value;
}

export function commandOperation(command, messageId = null) {
  if (command === 'feed-create') {
    if (messageId !== null) throw Error('A fixture message already exists.');
    return {
      operation: 'create',
      method: 'POST',
      path: '/channels/2001/messages',
      body: { content: 'G1 public message created.' },
    };
  }
  if (command !== 'feed-edit' && command !== 'feed-delete')
    throw Error('Unsupported fixture command.');
  requireId(messageId);
  return command === 'feed-edit'
    ? {
        operation: 'edit',
        method: 'PATCH',
        path: `/channels/2001/messages/${messageId}`,
        body: { content: 'G1 public message edited.' },
      }
    : { operation: 'delete', method: 'DELETE', path: `/channels/2001/messages/${messageId}` };
}

export function safeRestEvidence(input) {
  if (!['create', 'edit', 'delete'].includes(input.operation))
    throw Error('Unsupported evidence operation.');
  if (input.status !== (input.operation === 'delete' ? 204 : 200))
    throw Error('Unexpected REST status.');
  if (!Number.isSafeInteger(input.stateRevision) || input.stateRevision < 0)
    throw Error('Invalid state revision.');
  if (
    typeof input.eventId !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(input.eventId)
  )
    throw Error('Invalid message event identity.');
  return {
    operation: input.operation,
    status: input.status,
    messageId: requireId(input.messageId),
    authorId: requireId(input.authorId),
    applicationId: requireId(input.applicationId),
    stateRevision: input.stateRevision,
    eventId: input.eventId,
  };
}

export function validateRestBase(value, restPort) {
  if (typeof value !== 'string') throw Error('Missing fixture REST base.');
  const expected = `http://127.0.0.1:${restPort}/api/v10`;
  if (!Number.isInteger(restPort) || restPort < 1 || restPort > 65535 || value !== expected)
    throw Error('Invalid fixture REST base.');
  return expected;
}

async function main() {
  if (process.env.DISRUNNER_OFFLINE !== '1') throw Error('Offline fixture only.');
  const port = Number(process.env.DISRUNNER_BOT_PORT);
  const restPort = Number(process.env.DISRUNNER_REST_PORT);
  const gatewayPort = Number(process.env.DISRUNNER_GATEWAY_PORT);
  for (const candidate of [port, restPort, gatewayPort])
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535)
      throw Error('Invalid fixture port.');
  const restBase = validateRestBase(process.env.DISCORD_API_BASE_URL, restPort);
  const token = process.env.DISRUNNER_FAKE_TOKEN;
  if (typeof token !== 'string' || !/^disrunner\.offline\.[A-Za-z0-9_-]{16,256}$/u.test(token))
    throw Error('Missing fixture credential.');
  const keyHex = process.env.DISRUNNER_PUBLIC_KEY;
  if (typeof keyHex !== 'string' || !/^[a-f\d]{64}$/iu.test(keyHex))
    throw Error('Invalid public key.');
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(keyHex, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  const peerSecretHex = requireWebhookPeerSecret(process.env.DISRUNNER_WEBHOOK_PEER_SECRET);
  const trace = (event, fields = {}) =>
    appendFileSync(
      'child-trace.jsonl',
      JSON.stringify({ event, pid: process.pid, ...fields }) + '\n',
    );
  const procStarttime =
    process.platform === 'linux'
      ? readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[19]
      : null;
  trace('launch', { mode: 'normal', port, restPort, gatewayPort, procStarttime });
  const lifetime = new AbortController();
  const sockets = new Set();
  let stopping = false;
  let messageId = null;
  let busy = false;
  async function rest(path, method = 'GET', body) {
    const response = await fetch(`${restBase}${path}`, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bot ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
    });
    const payload = response.status === 204 ? null : await response.json();
    return { response, payload };
  }
  // Both bootstrap reads use the real Session-issued credential and complete before
  // any interaction is accepted. Parallel reads share the bounded startup window.
  const [application, user] = await Promise.all([
    rest('/oauth2/applications/@me'),
    rest('/users/@me'),
  ]);
  if (
    application.response.status !== 200 ||
    user.response.status !== 200 ||
    user.payload?.bot !== true
  )
    throw Error('Fixture bootstrap failed.');
  const applicationId = requireId(application.payload?.id);
  const authorId = requireId(user.payload?.id);
  trace('bootstrap', { applicationId, authorId, authenticatedRequest: true });
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 250 },
    (request, response) => {
      request.setTimeout(5000, () => request.destroy());
      response.setTimeout(5000, () => response.destroy());
      request.on('error', () => {});
      response.on('error', () => {});
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
      request.on('end', () => {
        void handle().catch(() => {
          trace('request-failed', { reason: 'invalid-or-failed-operation' });
          if (!response.headersSent) response.writeHead(500).end();
          else response.destroy();
        });
      });
      async function handle() {
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
        // Session readiness is the signed minimal { type: 1 } PING. Commands
        // carry the application identity and must match authenticated bootstrap.
        if (!ping) {
          if (interaction.application_id !== applicationId)
            throw Error('Unexpected interaction application.');
          if (
            interaction.type !== 2 ||
            !['3000', '3001'].includes(interaction.member?.user?.id) ||
            interaction.guild_id !== '1000' ||
            interaction.channel_id !== '2001'
          )
            throw Error('Unexpected interaction context.');
          const operation = commandOperation(interaction.data?.name, messageId);
          if (busy) throw Error('Concurrent fixture operation.');
          busy = true;
          try {
            trace('command', {
              authenticatedRequest: true,
              command: interaction.data.name,
              actorId: interaction.member.user.id,
              guildId: '1000',
              channelId: '2001',
              applicationId,
              applicationIdMatches: true,
              hasInventedRoles: Object.hasOwn(interaction.member ?? {}, 'roles'),
            });
            const { response: result, payload } = await rest(
              operation.path,
              operation.method,
              operation.body,
            );
            const id = operation.operation === 'delete' ? messageId : requireId(payload?.id);
            if (
              operation.operation !== 'delete' &&
              (payload?.author?.id !== authorId ||
                payload?.channel_id !== '2001' ||
                payload?.content !== operation.body.content ||
                (messageId !== null && id !== messageId))
            )
              throw Error('Unexpected message representation.');
            const revision = result.headers.get('x-disrunner-state-revision');
            if (revision === null || !/^\d+$/u.test(revision))
              throw Error('Missing message revision.');
            trace(
              'rest-operation',
              safeRestEvidence({
                operation: operation.operation,
                status: result.status,
                messageId: id,
                authorId,
                applicationId,
                stateRevision: Number(revision),
                eventId: result.headers.get('x-disrunner-event-id'),
              }),
            );
            messageId = operation.operation === 'delete' ? null : id;
          } finally {
            busy = false;
          }
        } else trace('readiness', { authenticatedRequest: true, applicationId });
        const body = Buffer.from(
          JSON.stringify(ping ? { type: 1 } : { type: 4, data: { content: diagnostic } }),
        );
        const authentication = signWebhookResponseAuthentication({
          peerSecretHex,
          timestamp,
          status: 200,
          requestBody: rawBody,
          responseBody: body,
        });
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(body.length),
          [WEBHOOK_RESPONSE_AUTH_HEADER]: authentication,
        });
        response.end(body, () =>
          trace(ping ? 'readiness-response' : 'callback', {
            responseType: ping ? 'pong' : 'message',
            authenticatedResponse: true,
            ...(ping ? {} : { content: diagnostic }),
          }),
        );
      }
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    trace('shutdown', { signal });
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
    server.close(() => {
      trace('exit', { code: 0 });
      process.exit(0);
    });
  }
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  server.listen(port, '127.0.0.1', () => trace('listening', { port }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Never print network errors, credentials, URLs, headers or untrusted payloads.
    appendFileSync(
      'child-trace.jsonl',
      JSON.stringify({ event: 'exit', pid: process.pid, code: 1 }) + '\n',
    );
    process.exit(1);
  });
}
