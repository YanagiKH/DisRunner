import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { sendSignedInteraction } from '../dist/interaction-transport.js';
import { signWebhookResponseAuthentication } from '../dist/interaction-peer-auth.js';

const { privateKey } = generateKeyPairSync('ed25519');
const secret = 'ab'.repeat(32);
const send = (options) =>
  sendSignedInteraction('https://bot.invalid', privateKey, secret, { type: 1 }, options);

function authenticatedResponse(init) {
  const body = Buffer.from('{"type":4}');
  const auth = signWebhookResponseAuthentication({
    peerSecretHex: secret,
    timestamp: init.headers['x-signature-timestamp'],
    status: 200,
    requestBody: init.body,
    responseBody: body,
  });
  return new Response(body, { headers: { 'x-disrunner-webhook-response-auth': auth } });
}

test('legacy calls still authenticate and decode their response', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => authenticatedResponse(init));
  assert.deepEqual(await send(), { type: 4 });
});

test('already aborted calls do not dispatch a request', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) =>
    authenticatedResponse(init),
  );
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  controller.abort(reason);
  await assert.rejects(send({ signal: controller.signal }), (error) => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const phase of ['fetch', 'body']) {
  for (const trigger of ['abort', 'timeout']) {
    test(
      `${trigger} bounds stalled ${phase}, even if the transport ignores its signal`,
      { timeout: 500 },
      async (t) => {
        const controller = new AbortController();
        const reason = new Error('caller stopped');
        let signal;
        let cancelled = false;
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          signal = init.signal;
          if (phase === 'fetch') return new Promise(() => {});
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
              getReader: () => ({
                read: () => new Promise(() => {}),
                cancel: () => {
                  cancelled = true;
                  return new Promise(() => {});
                },
              }),
            },
          };
        });
        const timer =
          trigger === 'abort' ? setTimeout(() => controller.abort(reason), 10) : undefined;
        try {
          await assert.rejects(
            send({ signal: controller.signal, timeoutMs: trigger === 'timeout' ? 10 : 200 }),
            (error) => (trigger === 'abort' ? error === reason : error.name === 'TimeoutError'),
          );
          assert.equal(signal.aborted, true);
          if (phase === 'body') assert.equal(cancelled, true);
        } finally {
          clearTimeout(timer);
        }
      },
    );
  }
}

test('rejects invalid deadlines before dispatch', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) =>
    authenticatedResponse(init),
  );
  for (const timeoutMs of [-1, NaN, Infinity, 1.5, 2 ** 31]) {
    await assert.rejects(send({ timeoutMs }), RangeError);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('clears its timeout and detaches caller abort after success', async (t) => {
  const controller = new AbortController();
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return authenticatedResponse(init);
  });
  assert.deepEqual(await send({ signal: controller.signal, timeoutMs: 10 }), { type: 4 });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});
