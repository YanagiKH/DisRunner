import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

import {
  createWebhookServer,
  loadServerOptionsFromEnvironment,
} from '../../../examples/raw-webhook-bot/src/server.mjs';
import {
  sendSignedInteraction,
  WebhookPeerAuthenticationError,
} from '../dist/interaction-transport.js';
import {
  verifyWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from '../dist/interaction-peer-auth.js';

// Exercise the private readiness functions verbatim, without exporting a test API.
// The real transport, signing, fixture replay cache and response verifier are used.
const source = await readFile(new URL('../src/runtime-manager.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runtime-manager.ts', source, ts.ScriptTarget.Latest, true);
const selected = ['waitForSignedPing', 'verifySignedPing', 'isRecord']
  .map((name) => {
    const declaration = ast.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(declaration, `Missing readiness function: ${name}`);
    return declaration.getText(ast);
  })
  .join('\n');
const compiled = ts.transpileModule(selected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
function readiness(wait = delay) {
  return new Function(
    'delay',
    'sendSignedInteraction',
    'WebhookPeerAuthenticationError',
    `${compiled}\nreturn waitForSignedPing;`,
  )(wait, sendSignedInteraction, WebhookPeerAuthenticationError);
}

async function fixture(run) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secret = randomBytes(32).toString('hex');
  const publicKeyHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  let now = 1_792_691_200_100;
  const server = createWebhookServer({
    ...loadServerOptionsFromEnvironment({
      DISRUNNER_OFFLINE: '1',
      DISRUNNER_PUBLIC_KEY: publicKeyHex,
      DISRUNNER_WEBHOOK_PEER_SECRET: secret,
      DISRUNNER_BOT_PORT: '0',
    }),
    now: () => now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/interactions`;
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => now;
  try {
    await run({
      privateKey,
      secret,
      endpoint,
      originalFetch,
      get now() {
        return now;
      },
      set now(value) {
        now = value;
      },
    });
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function loseFirstAcceptedResponse(f, attempts) {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, f.endpoint);
    assert.ok(attempts.length < 2, 'Unexpected third attempt');
    const response = await f.originalFetch(url, init);
    const body = Buffer.from(await response.clone().arrayBuffer());
    const timestamp = init.headers['x-signature-timestamp'];
    attempts.push({
      timestamp,
      signature: init.headers['x-signature-ed25519'],
      body: Buffer.from(init.body).toString(),
      status: response.status,
    });
    if (attempts.length === 1) {
      assert.equal(response.status, 200);
      assert.equal(
        verifyWebhookResponseAuthentication(response.headers.get(WEBHOOK_RESPONSE_AUTH_HEADER), {
          peerSecretHex: f.secret,
          timestamp,
          status: response.status,
          requestBody: Buffer.from(init.body),
          responseBody: body,
        }),
        true,
      );
      await response.arrayBuffer();
      throw new TypeError('fetch failed');
    }
    return response;
  };
}

test('lost authenticated response waits through unchanged seconds before retrying unchanged PING', async () => {
  await fixture(async (f) => {
    const attempts = [];
    loseFirstAcceptedResponse(f, attempts);
    let waits = 0;
    const wait = async (ms, value, { signal }) => {
      signal.throwIfAborted();
      assert.equal(attempts.length, 1, 'No retry before a new signing second');
      assert.equal(ms, 50, 'Preserve cancellable bounded polling');
      if (++waits === 3) f.now += 1_000;
    };
    await readiness(wait)(f.endpoint, f.privateKey, f.secret, AbortSignal.timeout(2_000), () => {});
    assert.equal(waits, 3);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].timestamp, attempts[1].timestamp);
    assert.notEqual(attempts[0].signature, attempts[1].signature);
    assert.equal(attempts[0].body, '{"type":1}');
    assert.equal(attempts[1].body, attempts[0].body);
    assert.equal(attempts[1].status, 200);
  });
});

test('retry uses actual signed second even when signing crosses a clock boundary', async () => {
  await fixture(async (f) => {
    const attempts = [];
    const realTransport = sendSignedInteraction;
    // Change time exactly as transport is entered, not when readiness samples it.
    const crossingTransport = (...args) => {
      if (attempts.length === 0) f.now += 1_000;
      return realTransport(...args);
    };
    const run = new Function(
      'delay',
      'sendSignedInteraction',
      'WebhookPeerAuthenticationError',
      `${compiled}\nreturn waitForSignedPing;`,
    )(
      async () => {
        assert.equal(attempts.length, 1);
        f.now += 1_000;
      },
      crossingTransport,
      WebhookPeerAuthenticationError,
    );
    loseFirstAcceptedResponse(f, attempts);
    await run(f.endpoint, f.privateKey, f.secret, AbortSignal.timeout(2_000), () => {});
    assert.equal(Number(attempts[1].timestamp) - Number(attempts[0].timestamp), 1);
  });
});

for (const mode of ['stalled', 'backwards']) {
  test(`${mode} wall clock remains bounded by original startup deadline`, async () => {
    await fixture(async (f) => {
      const attempts = [];
      loseFirstAcceptedResponse(f, attempts);
      const controller = new AbortController();
      const reason = new Error('Original startup deadline');
      const timer = setTimeout(() => controller.abort(reason), 150);
      let waits = 0;
      try {
        await assert.rejects(
          readiness(async (ms, value, options) => {
            if (mode === 'backwards') f.now -= 1_000;
            waits++;
            return delay(ms, value, options);
          })(f.endpoint, f.privateKey, f.secret, controller.signal, () => {}),
          (error) => error === reason || (error.name === 'AbortError' && error.cause === reason),
        );
        assert.ok(waits >= 1);
        assert.equal(attempts.length, 1);
      } finally {
        clearTimeout(timer);
      }
    });
  });
}

test('cancellation during retry wait prevents another request', async () => {
  await fixture(async (f) => {
    const attempts = [];
    loseFirstAcceptedResponse(f, attempts);
    const controller = new AbortController();
    const reason = new Error('Caller cancelled');
    await assert.rejects(
      readiness(async (ms, value, options) => {
        controller.abort(reason);
        return delay(ms, value, options);
      })(f.endpoint, f.privateKey, f.secret, controller.signal, () => {}),
      (error) => error.name === 'AbortError' && error.cause === reason,
    );
    assert.equal(attempts.length, 1);
  });
});

test('pre-aborted readiness does not sign or dispatch', async () => {
  await fixture(async (f) => {
    globalThis.fetch = () => {
      assert.fail('Must not dispatch');
    };
    const reason = new Error('Already cancelled');
    await assert.rejects(
      readiness()(f.endpoint, f.privateKey, f.secret, AbortSignal.abort(reason), () => {}),
      (error) => error === reason,
    );
  });
});

test('peer-auth rejection stays fail-closed without retrying', async () => {
  await fixture(async (f) => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response('{"type":1}', { status: 409 });
    };
    await assert.rejects(
      readiness(async () => assert.fail('Must not retry authentication rejection'))(
        f.endpoint,
        f.privateKey,
        f.secret,
        AbortSignal.timeout(2_000),
        () => {},
      ),
      WebhookPeerAuthenticationError,
    );
    assert.equal(attempts, 1);
  });
});

test('other transport errors are not retried', async () => {
  await fixture(async (f) => {
    const reason = new TypeError('different failure');
    globalThis.fetch = async () => {
      throw reason;
    };
    await assert.rejects(
      readiness(async () => assert.fail('Must not retry other errors'))(
        f.endpoint,
        f.privateKey,
        f.secret,
        AbortSignal.timeout(2_000),
        () => {},
      ),
      (error) => error === reason,
    );
  });
});

test('a throwing timestamp observer prevents dispatch and propagates unchanged', async () => {
  await fixture(async (f) => {
    globalThis.fetch = () => assert.fail('Observer failure must precede dispatch');
    const reason = new Error('Observer failed');
    await assert.rejects(
      sendSignedInteraction(
        f.endpoint,
        f.privateKey,
        f.secret,
        { type: 1 },
        {
          onSignedTimestamp(timestamp) {
            assert.equal(timestamp, String(Math.floor(f.now / 1_000)));
            throw reason;
          },
        },
      ),
      (error) => error === reason,
    );
  });
});

test('rollback between wait check and signing is vetoed before a duplicate wire request', async () => {
  await fixture(async (f) => {
    const attempts = [];
    loseFirstAcceptedResponse(f, attempts);
    let signingCalls = 0;
    let waits = 0;
    const crossingTransport = (...args) => {
      if (++signingCalls === 2) f.now -= 1_000;
      return sendSignedInteraction(...args);
    };
    const run = new Function(
      'delay',
      'sendSignedInteraction',
      'WebhookPeerAuthenticationError',
      `${compiled}\nreturn waitForSignedPing;`,
    )(
      async () => {
        assert.equal(attempts.length, 1);
        f.now += 1_000;
        waits++;
      },
      crossingTransport,
      WebhookPeerAuthenticationError,
    );
    await run(f.endpoint, f.privateKey, f.secret, AbortSignal.timeout(2_000), () => {});
    assert.equal(signingCalls, 3);
    assert.equal(waits, 2);
    assert.equal(attempts.length, 2);
    assert.equal(Number(attempts[1].timestamp) - Number(attempts[0].timestamp), 1);
  });
});

test('real cancellable polling recovers after a lost response once wall time advances', async () => {
  await fixture(async (f) => {
    const attempts = [];
    loseFirstAcceptedResponse(f, attempts);
    let waits = 0;
    await readiness(async (ms, value, options) => {
      await delay(ms, value, options);
      assert.equal(attempts.length, 1);
      if (++waits === 2) f.now += 1_000;
    })(f.endpoint, f.privateKey, f.secret, AbortSignal.timeout(2_000), () => {});
    assert.equal(waits, 2);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].status, 200);
  });
});
