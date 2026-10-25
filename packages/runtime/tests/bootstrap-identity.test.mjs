// Literal integration oracles frozen before shared-runtime bootstrap wiring.
// Only IDs and live public keys are read from responses; all other expected fields are literal.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BotRunner } from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';

const requireCore = createRequire(import.meta.resolve('@disrunner/core'));
const { WebSocket } = requireCore('ws');
const fixture = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };

function copyFixture(directory) {
  cpSync(fixture, directory, { recursive: true });
  const userPath = join(directory, 'fixtures/developer.discord-fixture.json');
  const user = JSON.parse(readFileSync(userPath, 'utf8'));
  user.user.bot = true;
  user.user.username = 'Fixture must not own bootstrap identity';
  writeFileSync(userPath, JSON.stringify(user));
  const configPath = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.bot.name = 'Project name must not own bootstrap display';
  config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
  config.bot.entryPoint = 'src/legacy-session-entry.mjs';
  config.bot.startCommand = 'node src/legacy-session-entry.mjs';
  writeFileSync(configPath, JSON.stringify(config));
  // Keep this transport oracle on the legacy profile without the example's v2 registration.
  writeFileSync(
    join(directory, 'src/legacy-session-entry.mjs'),
    `import {createWebhookServer,loadServerOptionsFromEnvironment} from './server.mjs';
const options=loadServerOptionsFromEnvironment();
const server=createWebhookServer(options);
server.listen(options.port,options.host);
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
  );

  const serverPath = join(directory, 'src/server.mjs');
  const source = readFileSync(serverPath, 'utf8');
  const anchor = '        void handleInteraction(sendAuthenticated, interaction, {';
  assert.equal(source.split(anchor).length, 2, 'one authenticated fixture handler insertion point');
  // Keep the fixture's signature gate and response peer authentication intact. Independently
  // reconstruct SPKI and verify original and byte-tampered messages, returning only safe facts.
  const instrumentation = `        if (interaction.type === 2 && interaction.data?.name === 'identity') {
          const observedKey = createPublicKey({
            key: Buffer.concat([
              Buffer.from('302a300506032b6570032100', 'hex'),
              Buffer.from(process.env.DISRUNNER_PUBLIC_KEY, 'hex'),
            ]),
            format: 'der',
            type: 'spki',
          });
          const timestampBytes = Buffer.from(request.headers['x-signature-timestamp'], 'utf8');
          const signatureBytes = Buffer.from(request.headers['x-signature-ed25519'], 'hex');
          const tampered = Buffer.from(rawBody);
          tampered[tampered.length - 1] ^= 1;
          sendAuthenticated(200, {
            type: 4,
            data: { content: JSON.stringify({
              application_id: interaction.application_id,
              signature_valid: verify(null, Buffer.concat([timestampBytes, rawBody]), observedKey, signatureBytes),
              tampered_body_invalid: !verify(null, Buffer.concat([timestampBytes, tampered]), observedKey, signatureBytes),
            }) },
          });
          return;
        }
`;
  writeFileSync(serverPath, source.replace(anchor, instrumentation + anchor));
}

function harness() {
  const runs = [];
  const events = [];
  const session = createSessionWithDependencies(
    {},
    {
      wrapBot(original) {
        assert.ok(original instanceof BotRunner, 'use the real BotRunner');
        return {
          start(config) {
            // Keep credentials only in test memory, never in fixture files or diagnostics.
            runs.push({
              token: config.fakeToken,
              publicKey: config.env.DISRUNNER_PUBLIC_KEY,
              peerSecret: config.interactionPeerSecret,
            });
            return original.start(config);
          },
          stop: (...args) => original.stop(...args),
          snapshot: () => original.snapshot(),
          observeExit: () => original.observeExit(),
        };
      },
    },
  );
  session.subscribe((event) => events.push(event));
  return { session, runs, events };
}

async function get(endpoints, route, token) {
  const response = await fetch(`${endpoints.restBaseUrl}${route}`, {
    headers: token === undefined ? {} : { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

function canonicalId(id) {
  assert.equal(typeof id, 'string');
  assert.match(id, /^[1-9]\d*$/u);
  assert.ok(BigInt(id) <= 18_446_744_073_709_551_615n);
}

async function profile(endpoints, credentials) {
  const user = await get(endpoints, '/users/@me', credentials.token);
  const application = await get(endpoints, '/oauth2/applications/@me', credentials.token);
  assert.equal(user.status, 200);
  assert.equal(application.status, 200);
  const ids = [user.body.id, application.body.id, application.body.owner.id];
  ids.forEach(canonicalId);
  assert.equal(new Set(ids).size, 3, 'three distinct identities within this run');
  assert.equal(ids.includes('3000'), false, 'fixture bot does not override any runtime identity');
  assert.deepEqual(user.body, {
    id: ids[0],
    username: 'DisRunner Bot',
    discriminator: '0',
    avatar: null,
    bot: true,
  });
  assert.match(credentials.publicKey, /^[0-9a-f]{64}$/u);
  assert.deepEqual(application.body, {
    id: ids[1],
    name: 'DisRunner Test Application',
    description: 'Synthetic application profile for local tests.',
    icon: null,
    bot_public: false,
    bot_require_code_grant: false,
    owner: { id: ids[2], username: 'test-owner', discriminator: '0', avatar: null, bot: false },
    verify_key: credentials.publicKey,
    flags: 0,
    team: null,
  });
  assert.deepEqual(await get(endpoints, '/gateway/bot', credentials.token), {
    status: 200,
    body: {
      url: endpoints.gatewayUrl,
      shards: 1,
      session_start_limit: {
        total: 1_000,
        remaining: 1_000,
        reset_after: 86_400_000,
        max_concurrency: 1,
      },
    },
  });
  return { user: user.body, application: application.body };
}

async function rejectCredentials(endpoints, tokens) {
  for (const route of ['/users/@me', '/oauth2/applications/@me']) {
    for (const token of tokens) {
      assert.deepEqual(await get(endpoints, route, token), {
        status: 401,
        body: { code: 0, message: '401: Unauthorized' },
      });
    }
  }
}

function gatewayClient(url, sockets) {
  const socket = new WebSocket(`${url}?v=10&encoding=json`);
  sockets.push(socket);
  const queue = [];
  let waiting;
  let failure;
  socket.on('message', (bytes) => {
    const packet = JSON.parse(bytes.toString());
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(packet);
    } else queue.push(packet);
  });
  socket.on('error', (error) => {
    failure = error;
  });
  return {
    send: (packet) => socket.send(JSON.stringify(packet)),
    async next() {
      if (failure) throw failure;
      if (queue.length) return queue.shift();
      let timer;
      try {
        return await Promise.race([
          new Promise((resolve) => {
            waiting = resolve;
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Gateway packet timeout')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        waiting = undefined;
      }
    },
  };
}

async function assertTransports(h, started, expected, sockets, requestId) {
  const credentials = h.runs.at(-1);
  const client = gatewayClient(started.endpoints.gatewayUrl, sockets);
  const hello = await client.next();
  assert.equal(hello.op, 10);
  assert.ok(Number.isInteger(hello.d.heartbeat_interval) && hello.d.heartbeat_interval > 0);
  client.send({ op: 1, d: null });
  assert.deepEqual(await client.next(), { op: 11, d: null });
  client.send({
    op: 2,
    d: {
      token: credentials.token,
      intents: 0,
      properties: { os: 'linux', browser: 'bootstrap-test', device: 'bootstrap-test' },
    },
  });
  const ready = await client.next();
  assert.equal(ready.op, 0);
  assert.equal(ready.t, 'READY');
  assert.equal(ready.d.user.id, expected.user.id);
  assert.equal(ready.d.application.id, expected.application.id);
  assert.equal(ready.d.resume_gateway_url, started.endpoints.gatewayUrl);
  const result = await h.session.invoke({
    runId: started.runId,
    requestId,
    input: '/identity',
    context,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.response.data.content), {
    application_id: expected.application.id,
    signature_valid: true,
    tampered_body_invalid: true,
  });
  return result;
}

async function assertClosed(url) {
  const outcome = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error) => resolve(error.code));
  });
  assert.equal(outcome, 'ECONNREFUSED');
}

function assertNoSecrets(h, values) {
  const serialized = JSON.stringify({ events: h.events, snapshot: h.session.snapshot(), values });
  for (const run of h.runs) {
    assert.equal(typeof run.token, 'string');
    assert.equal(typeof run.peerSecret, 'string');
    assert.equal(serialized.includes(run.token), false, 'synthetic token is not exported');
    assert.equal(serialized.includes(run.peerSecret), false, 'peer secret is not exported');
  }
  assert.doesNotMatch(serialized, /PRIVATE KEY|privateKey|interactionPrivateKey/u);
}

test(
  'real Session owns coherent REST, Gateway and signed-interaction bootstrap identities',
  { timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'disrunner-bootstrap-'));
    const sessions = [];
    const sockets = [];
    // Teardown owns everything from before selection/start, including partial startup failure.
    try {
      copyFixture(directory);
      const a = harness();
      sessions.push(a.session);
      const b = harness();
      sessions.push(b.session);
      await a.session.selectProject(directory);
      await b.session.selectProject(directory);
      const first = await a.session.start();
      const second = await b.session.start();
      assert.equal(first.phase, 'running');
      assert.equal(second.phase, 'running');
      assert.equal(a.runs[0].token === b.runs[0].token, false);
      assert.notEqual(a.runs[0].publicKey, b.runs[0].publicKey);
      // REST is usable before any IDENTIFY; no READY-derived identity discovery.
      const firstProfile = await profile(first.endpoints, a.runs[0]);
      const secondProfile = await profile(second.endpoints, b.runs[0]);
      await rejectCredentials(first.endpoints, [undefined, 'wrong-token', b.runs[0].token]);
      await rejectCredentials(second.endpoints, [undefined, 'wrong-token', a.runs[0].token]);
      const firstResult = await assertTransports(a, first, firstProfile, sockets, 'identity-a');
      const secondResult = await assertTransports(b, second, secondProfile, sockets, 'identity-b');
      const mutated = await get(first.endpoints, '/oauth2/applications/@me', a.runs[0].token);
      mutated.body.id = '1';
      mutated.body.owner.username = 'mutated';
      const mutatedUser = await get(first.endpoints, '/users/@me', a.runs[0].token);
      mutatedUser.body.id = '2';
      assert.deepEqual(await profile(first.endpoints, a.runs[0]), firstProfile);
      assert.deepEqual(await profile(second.endpoints, b.runs[0]), secondProfile);
      assertNoSecrets(a, [firstProfile, firstResult]);
      assertNoSecrets(b, [secondProfile, secondResult]);

      for (const socket of sockets.splice(0)) socket.terminate();
      assert.equal((await a.session.stop()).ok, true);
      for (const endpoint of Object.values(first.endpoints)) await assertClosed(endpoint);
      const restarted = await a.session.start();
      assert.notEqual(restarted.runId, first.runId);
      assert.equal(a.runs.length, 2);
      assert.equal(a.runs[0].token === a.runs[1].token, false);
      assert.notEqual(a.runs[0].publicKey, a.runs[1].publicKey);
      await rejectCredentials(restarted.endpoints, [a.runs[0].token, b.runs[0].token]);
      const restartedProfile = await profile(restarted.endpoints, a.runs[1]);
      const restartedResult = await assertTransports(
        a,
        restarted,
        restartedProfile,
        sockets,
        'identity-restart',
      );
      assert.deepEqual(await profile(second.endpoints, b.runs[0]), secondProfile);
      assertNoSecrets(a, [firstProfile, restartedProfile, restartedResult]);
      // No cross-run snowflake uniqueness assertion: the runtime clock is realtime.
    } finally {
      for (const socket of sockets) socket.terminate();
      const results = await Promise.allSettled(sessions.map((session) => session.dispose()));
      rmSync(directory, { recursive: true, force: true });
      for (const result of results) {
        assert.equal(result.status, 'fulfilled');
        assert.equal(result.value.ok, true);
      }
    }
  },
);
