import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { interactionReply } from './commands.mjs';
import {
  completeAfterAcknowledgement,
  createLocalApiClient,
  loadLocalApiConfiguration,
  registerLocalCommands,
} from './local-api.mjs';

import {
  requireWebhookPeerSecret,
  signWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './peer-auth.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 1_048_576,
  requestTimeoutMs: 5_000,
  maxSignatureAgeMs: 300_000,
  maxFutureSkewMs: 30_000,
  maxReplayEntries: 4_096,
  maxConnections: 32,
  maxRequestsPerSocket: 100,
  maxHeaderBytes: 16_384,
  keepAliveTimeoutMs: 2_000,
});

export function loadServerOptionsFromEnvironment(environment = process.env) {
  if (environment.DISRUNNER_OFFLINE !== '1') {
    throw new Error('This example only runs with DISRUNNER_OFFLINE=1.');
  }

  const publicKeyHex = requirePublicKey(environment.DISRUNNER_PUBLIC_KEY);
  const peerSecretHex = requireWebhookPeerSecret(environment.DISRUNNER_WEBHOOK_PEER_SECRET);
  const host = requireLoopbackHost(environment.DISRUNNER_BOT_HOST ?? '127.0.0.1');
  return {
    localApi: loadLocalApiConfiguration(environment),
    host,
    port: readInteger(environment.DISRUNNER_BOT_PORT, 'DISRUNNER_BOT_PORT', 39_001, 0, 65_535),
    publicKeyHex,
    peerSecretHex,
    maxBodyBytes: readInteger(
      environment.DISRUNNER_MAX_BODY_BYTES,
      'DISRUNNER_MAX_BODY_BYTES',
      DEFAULT_LIMITS.maxBodyBytes,
      1,
      16_777_216,
    ),
    requestTimeoutMs: readInteger(
      environment.DISRUNNER_REQUEST_TIMEOUT_MS,
      'DISRUNNER_REQUEST_TIMEOUT_MS',
      DEFAULT_LIMITS.requestTimeoutMs,
      1,
      60_000,
    ),
    maxSignatureAgeMs: readInteger(
      environment.DISRUNNER_MAX_SIGNATURE_AGE_MS,
      'DISRUNNER_MAX_SIGNATURE_AGE_MS',
      DEFAULT_LIMITS.maxSignatureAgeMs,
      1,
      3_600_000,
    ),
    maxFutureSkewMs: readInteger(
      environment.DISRUNNER_MAX_FUTURE_SKEW_MS,
      'DISRUNNER_MAX_FUTURE_SKEW_MS',
      DEFAULT_LIMITS.maxFutureSkewMs,
      0,
      300_000,
    ),
    maxReplayEntries: readInteger(
      environment.DISRUNNER_MAX_REPLAY_ENTRIES,
      'DISRUNNER_MAX_REPLAY_ENTRIES',
      DEFAULT_LIMITS.maxReplayEntries,
      1,
      65_536,
    ),
    maxConnections: readInteger(
      environment.DISRUNNER_MAX_CONNECTIONS,
      'DISRUNNER_MAX_CONNECTIONS',
      DEFAULT_LIMITS.maxConnections,
      1,
      10_000,
    ),
    maxRequestsPerSocket: readInteger(
      environment.DISRUNNER_MAX_REQUESTS_PER_SOCKET,
      'DISRUNNER_MAX_REQUESTS_PER_SOCKET',
      DEFAULT_LIMITS.maxRequestsPerSocket,
      1,
      10_000,
    ),
    maxHeaderBytes: readInteger(
      environment.DISRUNNER_MAX_HEADER_BYTES,
      'DISRUNNER_MAX_HEADER_BYTES',
      DEFAULT_LIMITS.maxHeaderBytes,
      1_024,
      65_536,
    ),
    keepAliveTimeoutMs: DEFAULT_LIMITS.keepAliveTimeoutMs,
  };
}

export function createWebhookServer(options) {
  const settings = normalizeServerOptions(options);
  const publicKey = ed25519PublicKey(settings.publicKeyHex);
  const replayCache = new Map();
  const lifecycle = new AbortController();
  const localApi = createLocalApiClient(settings.localApi, lifecycle.signal);

  const server = createServer(
    {
      maxHeaderSize: settings.maxHeaderBytes,
      requestTimeout: settings.requestTimeoutMs,
      headersTimeout: settings.requestTimeoutMs,
      keepAliveTimeout: settings.keepAliveTimeoutMs,
    },
    (request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, { ok: true, offline: true });
        return;
      }

      if (request.method !== 'POST' || request.url !== '/interactions') {
        sendJson(response, 404, { code: 10003, message: 'Unknown endpoint' });
        return;
      }

      const advertisedLength = parseContentLength(request.headers['content-length']);
      if (advertisedLength === undefined) {
        rejectRequest(request, response, 411, {
          code: 50035,
          message: 'Content-Length is required',
        });
        return;
      }
      if (advertisedLength > settings.maxBodyBytes) {
        rejectRequest(request, response, 413, {
          code: 40005,
          message: 'Request body is too large',
        });
        return;
      }

      let completed = false;
      let receivedBytes = 0;
      const chunks = [];
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        rejectRequest(request, response, 408, {
          code: 0,
          message: 'Request body timed out',
        });
      }, settings.requestTimeoutMs);
      timer.unref();

      request.on('data', (chunk) => {
        if (completed) return;
        receivedBytes += chunk.length;
        if (receivedBytes > settings.maxBodyBytes || receivedBytes > advertisedLength) {
          completed = true;
          clearTimeout(timer);
          rejectRequest(request, response, 413, {
            code: 40005,
            message: 'Request body is too large',
          });
          return;
        }
        chunks.push(chunk);
      });

      request.on('aborted', () => {
        completed = true;
        clearTimeout(timer);
      });

      request.on('error', () => {
        completed = true;
        clearTimeout(timer);
        if (!response.headersSent) {
          sendJson(response, 400, { code: 50035, message: 'Request body could not be read' });
        }
      });

      request.on('end', () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        if (receivedBytes !== advertisedLength) {
          sendJson(response, 400, {
            code: 50035,
            message: 'Content-Length did not match the body',
          });
          return;
        }

        const rawBody = Buffer.concat(chunks, receivedBytes);
        const signatureResult = authenticateRequest(
          request.headers,
          rawBody,
          publicKey,
          settings,
          replayCache,
        );
        if (!signatureResult.ok) {
          sendJson(response, signatureResult.status, {
            code: 40001,
            message: signatureResult.message,
          });
          return;
        }

        const sendAuthenticated = (status, body) =>
          sendJson(response, status, body, {
            peerSecretHex: settings.peerSecretHex,
            timestamp: signatureResult.timestamp,
            requestBody: rawBody,
          });

        let interaction;
        try {
          interaction = JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendAuthenticated(400, { code: 50035, message: 'Invalid Form Body' });
          return;
        }
        void handleInteraction(sendAuthenticated, interaction, {
          response,
          localApi,
          signal: lifecycle.signal,
          waitUntilReady: settings.waitUntilReady,
        }).catch(() => sendAuthenticated(503, { code: 0, message: 'Local Bot is not ready.' }));
      });
    },
  );

  server.maxConnections = settings.maxConnections;
  server.maxRequestsPerSocket = settings.maxRequestsPerSocket;
  server.once('close', () => lifecycle.abort());
  return server;
}

export async function startFromEnvironment(environment = process.env) {
  const options = loadServerOptionsFromEnvironment(environment);
  let ready;
  const readiness = new Promise((resolve) => {
    ready = resolve;
  });
  const server = createWebhookServer({ ...options, waitUntilReady: () => readiness });
  try {
    await listen(server, options.port, options.host);
    if (options.localApi !== null) {
      await registerLocalCommands(createLocalApiClient(options.localApi));
      process.stdout.write('Commands registered.\n');
    }
    ready(true);
    return server;
  } catch (error) {
    ready(false);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

function normalizeServerOptions(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Webhook server options are required.');
  }
  return {
    localApi: options.localApi ?? null,
    waitUntilReady:
      typeof options.waitUntilReady === 'function' ? options.waitUntilReady : undefined,
    publicKeyHex: requirePublicKey(options.publicKeyHex),
    peerSecretHex: requireWebhookPeerSecret(options.peerSecretHex),
    maxBodyBytes: requireInteger(options.maxBodyBytes, 'maxBodyBytes', 1),
    requestTimeoutMs: requireInteger(options.requestTimeoutMs, 'requestTimeoutMs', 1),
    maxSignatureAgeMs: requireInteger(options.maxSignatureAgeMs, 'maxSignatureAgeMs', 1),
    maxFutureSkewMs: requireInteger(options.maxFutureSkewMs, 'maxFutureSkewMs', 0),
    maxReplayEntries: requireInteger(options.maxReplayEntries, 'maxReplayEntries', 1),
    maxConnections: requireInteger(options.maxConnections, 'maxConnections', 1),
    maxRequestsPerSocket: requireInteger(options.maxRequestsPerSocket, 'maxRequestsPerSocket', 1),
    maxHeaderBytes: requireInteger(options.maxHeaderBytes, 'maxHeaderBytes', 1_024),
    keepAliveTimeoutMs: requireInteger(options.keepAliveTimeoutMs, 'keepAliveTimeoutMs', 1),
    now: typeof options.now === 'function' ? options.now : Date.now,
  };
}

function authenticateRequest(headers, rawBody, publicKey, settings, replayCache) {
  const signature = singleHeader(headers['x-signature-ed25519']);
  const timestamp = singleHeader(headers['x-signature-timestamp']);
  if (signature === undefined || timestamp === undefined) {
    return { ok: false, status: 401, message: 'Missing request signature' };
  }
  if (!/^[a-f\d]{128}$/i.test(signature) || !/^\d{1,16}$/.test(timestamp)) {
    return { ok: false, status: 401, message: 'Invalid request signature' };
  }
  const normalizedSignature = signature.toLowerCase();

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { ok: false, status: 401, message: 'Invalid request signature' };
  }
  const nowMs = settings.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('The injected clock returned an invalid timestamp.');
  }
  const signedAtMs = timestampSeconds * 1_000;
  if (
    nowMs - signedAtMs > settings.maxSignatureAgeMs ||
    signedAtMs - nowMs > settings.maxFutureSkewMs
  ) {
    return { ok: false, status: 401, message: 'Expired request signature' };
  }

  pruneReplayCache(replayCache, nowMs);
  const replayKey = createHash('sha256')
    .update(timestamp)
    .update('\0')
    .update(normalizedSignature)
    .digest('hex');
  if (replayCache.has(replayKey)) {
    return { ok: false, status: 409, message: 'Replayed request signature' };
  }

  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      publicKey,
      Buffer.from(normalizedSignature, 'hex'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, message: 'Invalid request signature' };

  while (replayCache.size >= settings.maxReplayEntries) {
    const oldest = replayCache.keys().next().value;
    if (oldest === undefined) break;
    replayCache.delete(oldest);
  }
  replayCache.set(replayKey, Math.max(nowMs, signedAtMs) + settings.maxSignatureAgeMs);
  return { ok: true, timestamp };
}

function pruneReplayCache(replayCache, nowMs) {
  for (const [key, expiresAtMs] of replayCache) {
    if (expiresAtMs <= nowMs) replayCache.delete(key);
  }
}

async function handleInteraction(send, interaction, runtime) {
  if (typeof interaction !== 'object' || interaction === null || Array.isArray(interaction)) {
    send(400, { code: 50035, message: 'Invalid Form Body' });
    return;
  }
  if (interaction.type === 1) {
    if (runtime.waitUntilReady !== undefined && !(await runtime.waitUntilReady())) {
      send(503, { code: 0, message: 'Local Bot could not register its commands.' });
      return;
    }
    send(200, { type: 1 });
    return;
  }
  const reply = interactionReply(interaction);
  if (reply.afterAck !== undefined && runtime.localApi !== null) {
    runtime.response.once('finish', () => {
      const handlerId = `raw-${interaction.id}`;
      process.stdout.write(
        'DISRUNNER_HANDLER ' + JSON.stringify({ id: handlerId, phase: 'start' }) + '\n',
      );
      setImmediate(() => {
        void completeAfterAcknowledgement(
          runtime.localApi,
          interaction,
          reply.afterAck,
          runtime.signal,
        )
          .catch(() => {
            if (!runtime.signal.aborted) {
              process.stderr.write('Local response could not complete.\n');
              process.stdout.write(
                'DISRUNNER_DIAGNOSTIC ' +
                  JSON.stringify({
                    code: 'bot-error',
                    message: 'The local response did not complete after acknowledgement.',
                  }) +
                  '\n',
              );
            }
          })
          .finally(() => {
            process.stdout.write(
              'DISRUNNER_HANDLER ' + JSON.stringify({ id: handlerId, phase: 'end' }) + '\n',
            );
          });
      });
    });
  }
  send(200, reply.callback);
}

function sendJson(response, status, body, authentication) {
  if (response.writableEnded) return;
  const contents = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'cache-control': 'no-store',
    'content-length': String(contents.length),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  };
  if (authentication !== undefined) {
    headers[WEBHOOK_RESPONSE_AUTH_HEADER] = signWebhookResponseAuthentication({
      ...authentication,
      status,
      responseBody: contents,
    });
  }
  response.writeHead(status, headers);
  response.end(contents);
}

function rejectRequest(request, response, status, body) {
  response.setHeader('connection', 'close');
  sendJson(response, status, body);
  request.resume();
}

function parseContentLength(value) {
  const header = singleHeader(value);
  if (header === undefined || !/^(?:0|[1-9]\d*)$/.test(header)) return undefined;
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function singleHeader(value) {
  return typeof value === 'string' ? value : undefined;
}

function requirePublicKey(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) {
    throw new Error('DISRUNNER_PUBLIC_KEY must be a 32-byte Ed25519 public key in hex.');
  }
  return value.toLowerCase();
}

function requireLoopbackHost(value) {
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new Error('DISRUNNER_BOT_HOST must be the loopback address 127.0.0.1 or ::1.');
  }
  return value;
}

function ed25519PublicKey(rawHex) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(rawHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

function readInteger(raw, label, fallback, minimum, maximum) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new RangeError(`${label} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requireInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function runAsMain() {
  try {
    const server = await startFromEnvironment();
    const address = server.address();
    process.stdout.write(
      `DisRunner example bot listening on http://${address.address}:${String(address.port)}\n`,
    );

    const shutdown = () => {
      server.close(() => {
        process.exitCode = 0;
      });
      setTimeout(() => server.closeAllConnections(), 1_000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(
      `DisRunner example failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsMain();
}
