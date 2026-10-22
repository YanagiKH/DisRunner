import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BotRunner, InteractionEngine, RateLimitEngine } from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';

const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2100' };

test(
  'real Session binds stored interaction identity to bootstrap application and selected live context',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-bound-identity-'));
    const originalCreate = InteractionEngine.prototype.create;
    const originalAcquire = RateLimitEngine.prototype.acquire;
    const created = [];
    const runs = [];
    const events = [];
    let limiter;
    let acquisitions = 0;
    // Observe actual instances while preserving the production method inputs and outputs.
    // Credentials and interaction tokens stay in test memory, never diagnostic artifacts.
    InteractionEngine.prototype.create = function (...args) {
      const result = originalCreate.apply(this, args);
      created.push({ engine: this, id: result.id });
      return result;
    };
    RateLimitEngine.prototype.acquire = function (...args) {
      limiter = { instance: this };
      acquisitions += 1;
      return originalAcquire.apply(this, args);
    };
    const session = createSessionWithDependencies(
      {},
      {
        wrapBot(bot) {
          assert.ok(bot instanceof BotRunner);
          return {
            start(config) {
              runs.push({ token: config.fakeToken, peerSecret: config.interactionPeerSecret });
              return bot.start(config);
            },
            stop: (...args) => bot.stop(...args),
            snapshot: () => bot.snapshot(),
            observeExit: () => bot.observeExit(),
          };
        },
      },
    );
    session.subscribe((event) => events.push(event));
    const request = (started, path, method = 'GET', body, token) =>
      fetch(`${started.endpoints.restBaseUrl}${path}`, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bot ${token}` }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(5000),
      });
    const readApplication = async (started) => {
      const response = await request(
        started,
        '/oauth2/applications/@me',
        'GET',
        undefined,
        runs.at(-1).token,
      );
      assert.equal(response.status, 200);
      const application = await response.json();
      assert.match(application.id, /^[1-9]\d*$/u);
      return application.id;
    };
    const invoke = async (started, requestId) => {
      const inputContext = { actorId: '3000', guildId: '1000', channelId: '2100' };
      const pending = session.invoke({
        runId: started.runId,
        requestId,
        input: '/ping',
        context: inputContext,
        applicationId: '999999999999999999',
      });
      inputContext.actorId = 'not-the-selected-actor';
      const result = await pending;
      assert.deepEqual(result.context, { actorId: '3000', guildId: '1000', channelId: '2100' });
      const observed = created.find((entry) => entry.id === result.interactionId);
      assert.ok(observed, 'The runtime must create its interaction on the actual core engine.');
      const stored = observed.engine.require(result.interactionId);
      return { result, observed, stored };
    };
    const assertNoSecrets = (interactions) => {
      const exported = JSON.stringify({ events, snapshot: session.snapshot() });
      for (const run of runs) {
        assert.equal(
          exported.includes(run.token),
          false,
          'Synthetic Bot credential reached Session DTO.',
        );
        assert.equal(exported.includes(run.peerSecret), false, 'Peer secret reached Session DTO.');
      }
      for (const interaction of interactions)
        assert.equal(
          exported.includes(interaction.token),
          false,
          'Interaction token reached Session DTO.',
        );
    };
    try {
      await cp(project, directory, { recursive: true });
      const server = join(directory, 'src/server.mjs');
      const source = await readFile(server, 'utf8');
      const literal = "'Pong! Offline and deterministic.'";
      assert.equal(
        source.split(literal).length,
        2,
        'Expected one fixture callback insertion point.',
      );
      await writeFile(
        server,
        source.replace(
          literal,
          'JSON.stringify({ applicationId: interaction.application_id, actorId: interaction.member.user.id, guildId: interaction.guild_id, channelId: interaction.channel_id })',
        ),
      );
      await session.selectProject(directory);
      const first = await session.start();
      const firstApplication = await readApplication(first);
      const firstInvocation = await invoke(first, 'first-identity');
      assert.equal(firstInvocation.stored.applicationId, firstApplication);
      assert.notEqual(firstInvocation.stored.applicationId, '999999999999999999');
      assert.deepEqual(firstInvocation.stored.context, {
        actorId: '3000',
        guildId: '1000',
        channelId: '2100',
      });
      assert.deepEqual(JSON.parse(firstInvocation.result.response.data.content), {
        applicationId: firstApplication,
        actorId: '3000',
        guildId: '1000',
        channelId: '2100',
      });
      firstInvocation.stored.context.actorId = 'mutated-observer';
      assert.deepEqual(
        firstInvocation.observed.engine.require(firstInvocation.result.interactionId).context,
        context,
      );
      assert.ok(limiter?.instance instanceof RateLimitEngine);
      const firstLimiter = limiter.instance;
      firstLimiter.configure({
        id: 'identity-followup-control',
        method: 'POST',
        route: '/webhooks/:webhookId/:token',
        limit: 1,
        windowMs: 60_000,
        scope: 'user',
      });
      const token = firstInvocation.stored.token;
      const pathFor = (applicationId) => `/webhooks/${applicationId}/${encodeURIComponent(token)}`;
      const wrongApplication = firstApplication === '1' ? '2' : '1';
      const bucketsBefore = firstLimiter.buckets();
      const acquisitionsBefore = acquisitions;
      const invalid = await request(first, pathFor(wrongApplication), 'POST', '{invalid-json');
      assert.equal(invalid.status, 404);
      assert.equal((await invalid.json()).code, 10015);
      assert.equal(
        acquisitions,
        acquisitionsBefore,
        'Invalid application must be rejected before quota.',
      );
      assert.deepEqual(firstLimiter.buckets(), bucketsBefore);
      const valid = await request(
        first,
        pathFor(firstApplication),
        'POST',
        JSON.stringify({ content: 'bound followup' }),
      );
      assert.equal(valid.status, 200);
      assert.equal((await valid.json()).data.content, 'bound followup');
      const exhausted = await request(
        first,
        pathFor(firstApplication),
        'POST',
        JSON.stringify({ content: 'exhausted followup' }),
      );
      assert.equal(exhausted.status, 429);
      const exhaustion = await exhausted.json();
      assert.equal(exhaustion.global, false);
      assert.ok(exhaustion.retry_after > 0 && exhaustion.retry_after <= 60);
      assertNoSecrets([firstInvocation.stored]);
      assert.equal((await session.stop()).ok, true);
      assert.equal(session.snapshot().coreState, null);

      const second = await session.start();
      const secondApplication = await readApplication(second);
      assert.notEqual(second.runId, first.runId);
      assert.notEqual(secondApplication, firstApplication);
      const secondInvocation = await invoke(second, 'second-identity');
      assert.notEqual(secondInvocation.observed.engine, firstInvocation.observed.engine);
      assert.equal(secondInvocation.stored.applicationId, secondApplication);
      assert.deepEqual(secondInvocation.stored.context, {
        actorId: '3000',
        guildId: '1000',
        channelId: '2100',
      });
      assert.deepEqual(JSON.parse(secondInvocation.result.response.data.content), {
        applicationId: secondApplication,
        actorId: '3000',
        guildId: '1000',
        channelId: '2100',
      });
      const beforeOldIdentity = acquisitions;
      const old = await request(second, pathFor(firstApplication), 'POST', '{invalid-json');
      assert.equal(old.status, 404);
      assert.equal((await old.json()).code, 10015);
      assert.equal(acquisitions, beforeOldIdentity);
      assertNoSecrets([firstInvocation.stored, secondInvocation.stored]);
    } finally {
      InteractionEngine.prototype.create = originalCreate;
      RateLimitEngine.prototype.acquire = originalAcquire;
      const shutdown = await session.dispose();
      await rm(directory, { recursive: true, force: true });
      assert.equal(shutdown.ok, true, 'Actual runtime cleanup must succeed.');
    }
  },
);
