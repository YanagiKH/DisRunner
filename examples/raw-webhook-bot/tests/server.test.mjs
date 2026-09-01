import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { after, before, test } from 'node:test';

import { createWebhookServer, loadServerOptionsFromEnvironment } from '../src/server.mjs';
import { sendSignedInteraction, signDiscordRequest } from '../src/signed-client.mjs';

const FIXED_NOW_MS = Date.parse('2026-09-01T00:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');

let server;
let baseUrl;

before(async () => {
  server = createWebhookServer(serverOptions());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

test('startup fails closed when the public key is missing', () => {
  assert.throws(
    () => loadServerOptionsFromEnvironment({ DISRUNNER_OFFLINE: '1' }),
    /DISRUNNER_PUBLIC_KEY/,
  );
});

test('startup requires explicit offline mode', () => {
  assert.throws(
    () => loadServerOptionsFromEnvironment({ DISRUNNER_PUBLIC_KEY: publicKeyHex }),
    /DISRUNNER_OFFLINE=1/,
  );
});

test('startup rejects a non-loopback bind host', () => {
  assert.throws(
    () =>
      loadServerOptionsFromEnvironment({
        DISRUNNER_OFFLINE: '1',
        DISRUNNER_PUBLIC_KEY: publicKeyHex,
        DISRUNNER_BOT_HOST: '0.0.0.0',
      }),
    /loopback address/,
  );
});

test('project fixture paths are self-contained inside the example', async () => {
  const config = JSON.parse(
    await readFile(new URL('../discord-simulator.config.json', import.meta.url), 'utf8'),
  );
  const paths = [
    config.bot.entryPoint,
    config.bot.workingDirectory,
    config.fixtures.guild,
    config.fixtures.user,
  ];
  for (const relativePath of paths) {
    assert.equal(relativePath.split(/[\\/]/).includes('..'), false);
  }
  await Promise.all(
    Object.values(config.fixtures).map((fixturePath) =>
      readFile(new URL(`../${fixturePath}`, import.meta.url), 'utf8'),
    ),
  );
});

test('accepts a genuine Ed25519-signed ping interaction', async () => {
  const response = await sendSignedInteraction({
    url: baseUrl,
    privateKey,
    timestamp: Math.floor(FIXED_NOW_MS / 1_000),
    interaction: { id: '1', type: 2, data: { name: 'ping' } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    type: 4,
    data: { content: 'Pong! Offline and deterministic.' },
  });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rejects an invalid signature', async () => {
  const rawBody = Buffer.from(JSON.stringify({ id: '2', type: 1 }));
  const timestamp = String(Math.floor(FIXED_NOW_MS / 1_000));
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
  const signature = `${signed.signature.slice(0, -2)}${signed.signature.endsWith('00') ? '01' : '00'}`;
  const response = await post(rawBody, {
    'x-signature-ed25519': signature,
    'x-signature-timestamp': timestamp,
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.message, 'Invalid request signature');
});

test('rejects missing signature headers', async () => {
  const response = await post(Buffer.from('{"type":1}'));
  assert.equal(response.status, 401);
  assert.equal(response.body.message, 'Missing request signature');
});

test('rejects expired signatures', async () => {
  const rawBody = Buffer.from('{"type":1}');
  const timestamp = String(Math.floor((FIXED_NOW_MS - 301_000) / 1_000));
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
  const response = await post(rawBody, {
    'x-signature-ed25519': signed.signature,
    'x-signature-timestamp': timestamp,
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.message, 'Expired request signature');
});

test('rejects replayed valid signatures', async () => {
  const rawBody = Buffer.from('{"id":"replay","type":1}');
  const timestamp = String(Math.floor(FIXED_NOW_MS / 1_000));
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
  const headers = {
    'x-signature-ed25519': signed.signature,
    'x-signature-timestamp': timestamp,
  };
  const first = await post(rawBody, headers);
  const second = await post(rawBody, headers);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.message, 'Replayed request signature');
});

test('requires Content-Length and enforces the configured body cap', async () => {
  const missing = await postChunked(Buffer.from('{"type":1}'));
  assert.equal(missing.status, 411);

  const oversized = await post(Buffer.alloc(257, 0x61));
  assert.equal(oversized.status, 413);
});

test('times out an incomplete request body', async () => {
  const timeoutServer = createWebhookServer(serverOptions({ requestTimeoutMs: 30 }));
  await new Promise((resolve, reject) => {
    timeoutServer.once('error', reject);
    timeoutServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = timeoutServer.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    const response = await incompletePost(address.port);
    assert.equal(response.status, 408);
    assert.equal(response.body.message, 'Request body timed out');
  } finally {
    await new Promise((resolve) => timeoutServer.close(resolve));
  }
});

test('applies connection and per-socket request limits', () => {
  const limitedServer = createWebhookServer(
    serverOptions({ maxConnections: 3, maxRequestsPerSocket: 7 }),
  );
  assert.equal(limitedServer.maxConnections, 3);
  assert.equal(limitedServer.maxRequestsPerSocket, 7);
});

function serverOptions(overrides = {}) {
  return {
    publicKeyHex,
    maxBodyBytes: 256,
    requestTimeoutMs: 1_000,
    maxSignatureAgeMs: 300_000,
    maxFutureSkewMs: 30_000,
    maxReplayEntries: 32,
    maxConnections: 8,
    maxRequestsPerSocket: 10,
    maxHeaderBytes: 8_192,
    keepAliveTimeoutMs: 100,
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

function post(rawBody, extraHeaders = {}) {
  return requestJson(baseUrl, rawBody, {
    'content-length': String(rawBody.length),
    'content-type': 'application/json',
    ...extraHeaders,
  });
}

function postChunked(rawBody) {
  return new Promise((resolve, reject) => {
    const outbound = request(
      new URL('/interactions', baseUrl),
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (response) => collectResponse(response, resolve),
    );
    outbound.once('error', reject);
    outbound.write(rawBody);
    outbound.end();
  });
}

function incompletePost(port) {
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: '127.0.0.1',
        port,
        path: '/interactions',
        method: 'POST',
        headers: { 'content-length': '20', 'content-type': 'application/json' },
      },
      (response) => {
        collectResponse(response, resolve);
        response.once('end', () => outbound.destroy());
      },
    );
    outbound.once('error', reject);
    outbound.write('{');
  });
}

function requestJson(url, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const outbound = request(
      new URL('/interactions', url),
      { method: 'POST', headers },
      (response) => collectResponse(response, resolve),
    );
    outbound.once('error', reject);
    outbound.end(rawBody);
  });
}

function collectResponse(response, resolve) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(raw) });
  });
}
