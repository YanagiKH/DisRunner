import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  createWebhookPeerSecret,
  signWebhookResponseAuthentication,
  verifyWebhookResponseAuthentication,
  WEBHOOK_PEER_SECRET_ENV,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from '../../electron/interaction-peer-auth.cts';
import {
  sendSignedInteraction,
  WebhookPeerAuthenticationError,
} from '../../electron/interaction-transport.cts';

const VECTOR = Object.freeze({
  peerSecretHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  timestamp: '1788230400',
  status: 200,
  requestBody: Buffer.from([1, 2, 3]),
  responseBody: Buffer.from([4, 5, 6]),
});
const VECTOR_SIGNATURE = 'b499b4ad675524b89aadecf1d2887531bd0fe8ebf725267f1b6228f72e401d61';

test('uses an explicit protected environment variable and response header contract', () => {
  assert.equal(WEBHOOK_PEER_SECRET_ENV, 'DISRUNNER_WEBHOOK_PEER_SECRET');
  assert.equal(WEBHOOK_RESPONSE_AUTH_HEADER, 'x-disrunner-webhook-response-auth');
});

test('creates independent 32-byte per-run peer secrets', () => {
  const first = createWebhookPeerSecret();
  const second = createWebhookPeerSecret();
  assert.match(first, /^[a-f\d]{64}$/u);
  assert.match(second, /^[a-f\d]{64}$/u);
  assert.notEqual(first, second);
});

test('matches the canonical response-authentication vector', () => {
  assert.equal(signWebhookResponseAuthentication(VECTOR), VECTOR_SIGNATURE);
  assert.equal(verifyWebhookResponseAuthentication(VECTOR_SIGNATURE, VECTOR), true);
});

test('rejects missing, malformed, wrong-key, and tampered response authentication', () => {
  assert.equal(verifyWebhookResponseAuthentication(undefined, VECTOR), false);
  assert.equal(verifyWebhookResponseAuthentication('not-hex', VECTOR), false);
  assert.equal(verifyWebhookResponseAuthentication('00'.repeat(32), VECTOR), false);
  assert.equal(
    verifyWebhookResponseAuthentication(VECTOR_SIGNATURE, {
      ...VECTOR,
      peerSecretHex: 'ff'.repeat(32),
    }),
    false,
  );
  assert.equal(
    verifyWebhookResponseAuthentication(VECTOR_SIGNATURE, {
      ...VECTOR,
      status: 201,
    }),
    false,
  );
  assert.equal(
    verifyWebhookResponseAuthentication(VECTOR_SIGNATURE, {
      ...VECTOR,
      requestBody: Buffer.from([1, 2, 4]),
    }),
    false,
  );
  assert.equal(
    verifyWebhookResponseAuthentication(VECTOR_SIGNATURE, {
      ...VECTOR,
      responseBody: Buffer.from([4, 5, 7]),
    }),
    false,
  );
});

test('fails closed for invalid internal secret, timestamp, and HTTP status inputs', () => {
  assert.throws(
    () => signWebhookResponseAuthentication({ ...VECTOR, peerSecretHex: 'short' }),
    /32-byte hexadecimal/u,
  );
  assert.throws(
    () => signWebhookResponseAuthentication({ ...VECTOR, timestamp: '-1' }),
    /Unix seconds/u,
  );
  assert.throws(() => signWebhookResponseAuthentication({ ...VECTOR, status: 99 }), /HTTP status/u);
});

test('runtime transport accepts only a request-bound authenticated response', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const peerSecretHex = '42'.repeat(32);
  const payload = { id: 'runtime-transport', type: 1 };
  const accepted = await withTransportServer(
    { mode: 'valid', peerSecretHex, publicKey },
    (endpoint) => sendSignedInteraction(endpoint, privateKey, peerSecretHex, payload),
  );
  assert.deepEqual(accepted, { type: 1 });

  for (const mode of ['missing', 'wrong', 'response-tampered', 'status-tampered']) {
    await assert.rejects(
      withTransportServer({ mode, peerSecretHex, publicKey }, (endpoint) =>
        sendSignedInteraction(endpoint, privateKey, peerSecretHex, payload),
      ),
      WebhookPeerAuthenticationError,
    );
  }
});

test('runtime transport authenticates error envelopes before interpreting them', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const peerSecretHex = '24'.repeat(32);
  const payload = { id: 'runtime-error-envelope', type: 1 };
  await assert.rejects(
    withTransportServer({ mode: 'http-error', peerSecretHex, publicKey }, (endpoint) =>
      sendSignedInteraction(endpoint, privateKey, peerSecretHex, payload),
    ),
    /returned HTTP 500/u,
  );
  await assert.rejects(
    withTransportServer({ mode: 'invalid-json', peerSecretHex, publicKey }, (endpoint) =>
      sendSignedInteraction(endpoint, privateKey, peerSecretHex, payload),
    ),
    /returned invalid JSON/u,
  );
});

async function withTransportServer(options, operation) {
  let observedValidRequest = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const requestBody = Buffer.concat(chunks);
      const timestamp = request.headers['x-signature-timestamp'];
      const requestSignature = request.headers['x-signature-ed25519'];
      observedValidRequest =
        typeof timestamp === 'string' &&
        typeof requestSignature === 'string' &&
        verify(
          null,
          Buffer.concat([Buffer.from(timestamp, 'utf8'), requestBody]),
          options.publicKey,
          Buffer.from(requestSignature, 'hex'),
        );

      const genuineBody = Buffer.from(
        options.mode === 'invalid-json' ? 'not-json' : '{"type":1}',
        'utf8',
      );
      const transmittedBody =
        options.mode === 'response-tampered'
          ? Buffer.from('{"type":4,"data":{}}', 'utf8')
          : genuineBody;
      const transmittedStatus = options.mode === 'http-error' ? 500 : 200;
      const authenticatedStatus = options.mode === 'status-tampered' ? 201 : transmittedStatus;
      const headers = {
        'content-length': String(transmittedBody.byteLength),
        'content-type': 'application/json',
      };
      if (options.mode === 'wrong') {
        headers[WEBHOOK_RESPONSE_AUTH_HEADER] = '00'.repeat(32);
      } else if (options.mode !== 'missing' && typeof timestamp === 'string') {
        headers[WEBHOOK_RESPONSE_AUTH_HEADER] = signWebhookResponseAuthentication({
          peerSecretHex: options.peerSecretHex,
          timestamp,
          status: authenticatedStatus,
          requestBody,
          responseBody: genuineBody,
        });
      }
      response.writeHead(transmittedStatus, headers);
      response.end(transmittedBody);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    return await operation(`http://127.0.0.1:${String(address.port)}/interactions`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.equal(observedValidRequest, true, 'runtime must send a genuine Ed25519 request');
  }
}
