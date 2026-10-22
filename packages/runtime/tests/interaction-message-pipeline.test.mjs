import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BotRunner, InteractionEngine, LocalRestEmulator, TraceCollector } from '@disrunner/core';
import { createSessionWithDependencies } from '../dist/session.js';
import { RuntimeManager } from '../dist/index.js';

const source = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2100' };
const MARK = (n) => `zz-private-marker-${n}`;

/** Real Session over a temporary copy of the example project; no generated expectations. */
async function harness(callbacks) {
  const directory = await mkdtemp(join(tmpdir(), 'interaction-message-pipeline-'));
  await cp(source, directory, { recursive: true });
  if (callbacks !== undefined) {
    const server = join(directory, 'src/server.mjs');
    const contents = await readFile(server, 'utf8');
    const insertion = '  const name = interaction.data?.name;';
    assert.equal(contents.split(insertion).length, 2);
    await writeFile(
      server,
      contents.replace(
        insertion,
        `${insertion}\n  const callbacks = ${JSON.stringify(callbacks)};\n  if (Object.hasOwn(callbacks, name)) return send(200, callbacks[name]);`,
      ),
    );
  }
  const originalCreate = InteractionEngine.prototype.create;
  const originalTraceEnd = TraceCollector.prototype.end;
  const traceEnds = [];
  TraceCollector.prototype.end = function (...args) {
    traceEnds.push(structuredClone({ status: args[1], metadata: args[2] }));
    return originalTraceEnd.apply(this, args);
  };
  const created = [];
  const runs = [];
  const rests = [];
  const events = [];
  InteractionEngine.prototype.create = function (...args) {
    const result = originalCreate.apply(this, args);
    created.push({ engine: this, id: result.id });
    return result;
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
      // Observe the real REST emulator of each run; it is returned unchanged.
      wrapRest(rest) {
        assert.ok(rest instanceof LocalRestEmulator);
        rests.push(rest);
        return rest;
      },
    },
  );
  session.subscribe((event) => events.push(event));
  const h = {
    session,
    events,
    runs,
    directory,
    traceEnds,
    lastInteraction() {
      const observed = created.at(-1);
      assert.ok(observed);
      return observed.engine.require(observed.id);
    },
    async start() {
      await session.selectProject(directory);
      const started = await session.start();
      assert.equal(started.phase, 'running');
      return started;
    },
    request(started, path, method = 'GET', body, token) {
      return fetch(`${started.endpoints.restBaseUrl}${path}`, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bot ${token}` }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(5000),
      });
    },
    async application(started) {
      const response = await h.request(
        started,
        '/oauth2/applications/@me',
        'GET',
        undefined,
        runs.at(-1).token,
      );
      assert.equal(response.status, 200);
      return (await response.json()).id;
    },
    async invoke(started, input, requestId) {
      const result = await session.invoke({ runId: started.runId, requestId, input, context });
      assert.equal(result.ok, true);
      const observed = created.find((entry) => entry.id === result.interactionId);
      assert.ok(observed, 'The runtime must create its interaction on the actual core engine.');
      return { result, stored: observed.engine.require(result.interactionId) };
    },
    /** Shared message evidence of the current run, read through the public REST method. */
    evidence() {
      const rest = rests.at(-1);
      assert.ok(rest, 'The run must own a real REST emulator.');
      return structuredClone(rest.messageEvidence());
    },
    messages() {
      const core = session.snapshot().coreState;
      assert.ok(core, 'Actual retained core snapshot is required.');
      return core.resources.filter((resource) => resource.resourceType === 'message');
    },
    exported() {
      return JSON.stringify({ events, snapshot: session.snapshot(), traceEnds });
    },
    async close() {
      InteractionEngine.prototype.create = originalCreate;
      TraceCollector.prototype.end = originalTraceEnd;
      const shutdown = await session.dispose();
      await rm(directory, { recursive: true, force: true });
      assert.equal(shutdown.ok, true, 'Actual runtime cleanup must succeed.');
    },
  };
  return h;
}

test(
  'a public chat-input reply becomes one retained type 20 message',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const { result } = await h.invoke(started, '/ping', 'public-original');
      const rows = h.messages().filter((m) => m.content === 'Pong! Offline and deterministic.');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, 20);
      assert.equal(rows[0].visibility, 'channel');
      assert.equal(rows[0].channel_id, '2100');
      assert.equal(rows[0].guild_id, '1000');
      assert.equal(rows[0].author?.bot, true);
      assert.notEqual(rows[0].id, result.interactionId);
      assert.equal('origin' in rows[0], false);
    } finally {
      await h.close();
    }
  },
);

test(
  'a public followup is returned as a Message body and retained as type 0',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const application = await h.application(started);
      const { result, stored } = await h.invoke(started, '/ping', 'followup-original');
      const original = h.messages().find((m) => m.content === 'Pong! Offline and deterministic.');
      const response = await h.request(
        started,
        `/webhooks/${application}/${encodeURIComponent(stored.token)}`,
        'POST',
        JSON.stringify({ content: 'Followup public.' }),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.content, 'Followup public.');
      assert.equal(body.data, undefined);
      assert.equal(body.type, 0);
      assert.notEqual(body.id, result.interactionId);
      assert.notEqual(body.id, original?.id);
      const rows = h.messages().filter((m) => m.content === 'Followup public.');
      assert.deepEqual(
        rows.map((m) => [m.id, m.type]),
        [[body.id, 0]],
      );
      assert.equal(h.exported().includes(stored.token), false);
    } finally {
      await h.close();
    }
  },
);

test(
  'ephemeral and deferred replies never reach the shared snapshot or session events',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const before = h.messages();
      await h.invoke(started, '/secret', 'ephemeral-original');
      await h.invoke(started, '/slow', 'deferred-original');
      assert.deepEqual(h.messages(), before);
      assert.equal(h.exported().includes('Only you can see this.'), false);
    } finally {
      await h.close();
    }
  },
);

test(
  'rejected followup payloads change nothing and never echo private markers',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const application = await h.application(started);
      const { stored } = await h.invoke(started, '/ping', 'rejected-followups');
      const path = `/webhooks/${application}/${encodeURIComponent(stored.token)}`;
      const button = (customId) => ({ type: 2, style: 1, label: 'Go', custom_id: customId });
      const bodies = [
        JSON.stringify({
          content: 'a',
          components: [{ type: 1, components: [button(MARK(1)), button(MARK(1))] }],
        }),
        JSON.stringify({ content: 'a', [MARK(2)]: 1 }),
        `{"content":"${MARK(3)}`,
      ];
      const baseline = h.session.snapshot().coreState;
      for (const body of bodies) {
        const response = await h.request(started, path, 'POST', body);
        const text = await response.text();
        assert.equal(response.status, 400);
        assert.equal(JSON.parse(text).code, 50035);
        for (const marker of [MARK(1), MARK(2), MARK(3)]) {
          assert.equal(text.includes(marker), false);
          for (const [, value] of response.headers) assert.equal(value.includes(marker), false);
        }
        const after = h.session.snapshot().coreState;
        assert.equal(after.stateRevision, baseline.stateRevision);
        assert.deepEqual(after.resources, baseline.resources);
      }
      for (const marker of [MARK(1), MARK(2), MARK(3)])
        assert.equal(h.exported().includes(marker), false);
    } finally {
      await h.close();
    }
  },
);

test(
  'stopping the session closes the bot child and both local endpoints',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const pid = started.pid;
      assert.equal(typeof pid, 'number');
      const { restBaseUrl, gatewayUrl } = started.endpoints;
      await h.invoke(started, '/ping', 'cleanup');
      assert.equal((await h.session.stop()).ok, true);
      assert.throws(() => process.kill(pid, 0));
      await assert.rejects(fetch(`${restBaseUrl}/gateway`, { signal: AbortSignal.timeout(2000) }));
      const gatewayHttp = gatewayUrl.replace(/^ws:/u, 'http:');
      await assert.rejects(fetch(gatewayHttp, { signal: AbortSignal.timeout(2000) }));
    } finally {
      await h.close();
    }
  },
);

function lastSequence(evidence) {
  return evidence.records.at(-1)?.event.sequence ?? null;
}

test(
  'a rejected interaction command at session level adds no observer call, event or evidence record',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const application = await h.application(started);
      const { stored } = await h.invoke(started, '/ping', 'rejected-followup');
      const messages = structuredClone(h.messages());
      const evidence = h.evidence();
      const response = await h.request(
        started,
        `/webhooks/${application}/${encodeURIComponent(stored.token)}`,
        'POST',
        JSON.stringify({ content: 1, tts: MARK(4) }),
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 50035);
      assert.equal(response.headers.get('x-disrunner-event-id'), null);
      assert.equal(response.headers.get('x-disrunner-delivery'), null);
      assert.deepEqual(h.messages(), messages);
      assert.deepEqual(h.evidence(), evidence);
      assert.equal(JSON.stringify(h.evidence()).includes(MARK(4)), false);
      assert.equal(h.exported().includes(MARK(4)), false);
    } finally {
      await h.close();
    }
  },
);

test(
  'no-op and ephemeral operations through the session add no evidence record or sequence number',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const application = await h.application(started);
      const { stored } = await h.invoke(started, '/ping', 'quiet-operations');
      const base = `/webhooks/${application}/${encodeURIComponent(stored.token)}`;
      const messages = structuredClone(h.messages());
      const evidence = structuredClone(h.evidence());
      assert.ok(evidence.records.length > 0, 'The public original is recorded before the checks.');
      const quiet = [
        await h.request(
          started,
          base,
          'POST',
          JSON.stringify({ content: 'Quiet followup.', flags: 64 }),
        ),
        await h.request(
          started,
          `${base}/messages/@original`,
          'PATCH',
          JSON.stringify({ content: 'Pong! Offline and deterministic.' }),
        ),
      ];
      for (const response of quiet) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-disrunner-event-id'), null);
        assert.equal(response.headers.get('x-disrunner-delivery'), null);
      }
      assert.deepEqual(h.messages(), messages);
      const quietEvidence = h.evidence();
      assert.deepEqual(quietEvidence, evidence);
      assert.equal(quietEvidence.records.length, evidence.records.length);
      assert.equal(quietEvidence.dropped, evidence.dropped);
      assert.equal(lastSequence(quietEvidence), lastSequence(evidence));
      assert.deepEqual(quietEvidence.records.at(-1), evidence.records.at(-1));
      for (const row of h.messages()) {
        assert.equal(typeof row.flags, 'number');
        assert.equal((row.flags & 64) === 0, true, 'No ephemeral message reaches the snapshot.');
        assert.equal((row.flags & 128) === 0, true, 'No loading message reaches the snapshot.');
        assert.notEqual(row.content, 'Quiet followup.');
      }
      const next = await h.request(
        started,
        base,
        'POST',
        JSON.stringify({ content: 'Followup public.' }),
      );
      assert.equal(next.status, 200);
      const eventId = next.headers.get('x-disrunner-event-id');
      assert.notEqual(eventId, null);
      assert.equal(typeof eventId, 'string');
      assert.equal(eventId.length > 0, true);
      assert.equal(next.headers.get('x-disrunner-delivery'), 'accepted');
      const revisionHeader = next.headers.get('x-disrunner-state-revision');
      assert.notEqual(revisionHeader, null);
      assert.match(revisionHeader, /^[0-9]+$/);
      const revision = Number(revisionHeader);
      assert.equal(Number.isSafeInteger(revision), true);
      const followupId = (await next.json()).id;
      assert.equal(typeof followupId, 'string');
      assert.equal(followupId.length > 0, true);
      const rows = h.messages();
      assert.equal(rows.length, messages.length + 1);
      const added = rows.filter((row) => !messages.some((before) => before.id === row.id));
      assert.equal(added.length, 1);
      assert.equal(added[0].id, followupId);
      assert.equal(added[0].type, 0);
      assert.equal(added[0].visibility, 'channel');
      assert.equal(added[0].content, 'Followup public.');
      const after = h.evidence();
      assert.equal(after.records.length, evidence.records.length + 1);
      assert.equal(after.dropped, evidence.dropped);
      assert.deepEqual(after.records.slice(0, -1), evidence.records);
      const record = after.records.at(-1).event;
      assert.equal(record.origin, 'interaction');
      assert.equal(record.payload.type, 'MESSAGE_CREATE');
      assert.equal(record.payload.message.id, followupId);
      assert.equal(record.sequence, lastSequence(evidence) + 1);
      assert.equal(record.stateRevision, revision);
      assert.equal(record.eventId, eventId);
      assert.equal(record.runId, started.runId);
      assert.equal(record.correlationId, stored.id);
      assert.equal(typeof record.causationId, 'string');
      assert.equal(record.causationId.length > 0, true);
      assert.notEqual(record.causationId, record.correlationId);
      assert.notEqual(record.causationId, stored.token);
      assert.notEqual(record.causationId, followupId);
      assert.notEqual(record.causationId, eventId);
      assert.notEqual(record.causationId, started.runId);
    } finally {
      await h.close();
    }
  },
);

const invalidSignedCallbacks = [
  ['unknown wrapper field', { type: 4, data: { content: 'Not committed.' }, [MARK(10)]: MARK(11) }],
  ['unknown numeric callback type', { type: 987654321, data: {} }],
  ['defer-update callback type', { type: 6 }],
  ['update callback type', { type: 7, data: { content: 'Not committed.' } }],
  ['autocomplete callback type', { type: 8, data: { choices: [] } }],
  ['null defer data', { type: 5, data: null }],
  ['array defer data', { type: 5, data: [] }],
  ['string defer data', { type: 5, data: MARK(12) }],
  ['numeric defer data', { type: 5, data: 987654322 }],
  ['boolean defer data', { type: 5, data: false }],
  ['array wrapper', []],
  ['null wrapper', null],
];

for (const [label, callback] of invalidSignedCallbacks) {
  test(`signed authoritative callbacks reject ${label} before acknowledgement`, async () => {
    const h = await harness({ invalid: callback });
    try {
      const started = await h.start();
      const before = h.session.snapshot().coreState;
      const evidence = h.evidence();
      await assert.rejects(
        h.session.invoke({
          runId: started.runId,
          requestId: 'invalid-wrapper',
          input: '/invalid',
          context,
        }),
        { code: 'transport', message: 'Bot interaction failed.' },
      );
      assert.deepEqual(h.traceEnds.filter((entry) => entry.status === 'error').at(-1).metadata, {
        error: 'Invalid interaction message payload.',
      });
      const stored = h.lastInteraction();
      assert.equal(stored.messageProfile, 'chat-input-messages-v1');
      assert.equal(stored.status, 'pending');
      assert.equal(stored.acknowledgedAtMs, undefined);
      assert.equal(stored.initialResponse, undefined);
      assert.equal(stored.originalMessageId, undefined);
      assert.deepEqual(stored.followups, []);
      const after = h.session.snapshot().coreState;
      assert.equal(after.stateRevision, before.stateRevision);
      assert.deepEqual(after.resources, before.resources);
      assert.deepEqual(h.evidence(), evidence);
      const exported = h.exported();
      for (const marker of [MARK(10), MARK(11), MARK(12), '987654321', '987654322'])
        assert.equal(exported.includes(marker), false);
      assert.equal(exported.includes(stored.token), false);
      const { result } = await h.invoke(started, '/ping', 'valid-after-rejection');
      assert.equal(result.response.type, 'message');
      assert.equal(h.messages().length, 1);
      assert.equal(h.messages()[0].type, 20);
      assert.equal(h.evidence().records.length, evidence.records.length + 1);
      assert.equal(h.evidence().records.at(-1).event.sequence, 1);
    } finally {
      await h.close();
    }
  });
}

test('signed authoritative callbacks preserve valid defer and modal responses', async () => {
  const modal = {
    type: 9,
    data: {
      custom_id: 'valid-modal',
      title: 'Message details',
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'message', label: 'Message', style: 1 }],
        },
      ],
    },
  };
  const h = await harness({ modal, defer: { type: 5 } });
  try {
    const started = await h.start();
    const { result: deferred, stored: loading } = await h.invoke(started, '/defer', 'valid-defer');
    assert.deepEqual(deferred.response, { type: 'defer', data: {} });
    assert.equal(loading.status, 'deferred');
    assert.equal(typeof loading.originalMessageId, 'string');
    assert.deepEqual(h.messages(), []);
    assert.equal(h.evidence().records.length, 0);
    const { result, stored } = await h.invoke(started, '/modal', 'valid-modal');
    assert.deepEqual(result.response, { type: 'modal', data: modal.data });
    assert.equal(stored.status, 'responded');
    assert.equal(stored.originalMessageId, undefined);
    assert.deepEqual(h.messages(), []);
    assert.equal(h.evidence().records.length, 0);
  } finally {
    await h.close();
  }
});

test('contextless signed callbacks retain model wrapper compatibility', async () => {
  const h = await harness({
    extra: { type: 4, data: { content: 'Model response.' }, extra: true },
    unsupported: { type: 987654321 },
  });
  const manager = new RuntimeManager(
    () => {},
    () => {},
  );
  try {
    await manager.selectProject(h.directory);
    assert.equal((await manager.start()).phase, 'running');
    const result = await manager.invoke('/extra');
    assert.equal(result.ok, true);
    assert.deepEqual(result.response, { type: 'message', data: { content: 'Model response.' } });
    assert.equal(h.lastInteraction().messageProfile, undefined);
    const unsupported = await manager.invoke('/unsupported');
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, 'Unsupported interaction callback type: 987654321.');
  } finally {
    await manager.stop();
    await h.close();
  }
});
