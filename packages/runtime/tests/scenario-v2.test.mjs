import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  parseBotScenarioV2,
  runBotScenarioV2,
  renderBotScenarioV2Report,
} from '../dist/scenario-v2.js';
import { loadProjectConfiguration } from '../dist/project-config.js';
import { saveWorkspace } from '../dist/workspace.js';
import { createSession } from '../dist/session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = join(root, 'apps/cli/tests/fixtures/bot-test');
const expected = 'Pong! Offline and deterministic.';
const canonical = () => ({
  version: 2,
  name: 'Real Bot ping',
  execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10000 },
  context: { actor: '3000', guild: '1000', channel: '2000' },
  steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 1000 }],
  assertions: [
    { type: 'message-content', interaction: '${ping.id}', equals: expected },
    { type: 'response-type', interaction: '${ping.id}', equals: 'message' },
    { type: 'no-unexpected-error' },
  ],
});

async function project(t, mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'disrunner-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const configFile = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.environment.DISRUNNER_TEST_MODE = mode;
  config.environment.DISRUNNER_TEST_TRACE = join(directory, 'child.jsonl');
  await writeFile(configFile, JSON.stringify(config));
  return directory;
}

test('v2 parser accepts JSON/YAML, captures context, and does not mutate source', () => {
  const source = canonical();
  const value = parseBotScenarioV2(source);
  source.steps[0].command = 'changed';
  assert.equal(value.steps[0].command, 'ping');
  assert.equal(value.policy.failOnSeverity, 'high');
  assert.equal(parseBotScenarioV2(JSON.stringify(canonical())).name, 'Real Bot ping');
  const yaml = `version: 2\nname: YAML ping\nexecution:\n  kind: bot\n  project: .\n  clock: realtime\ncontext: {actor: '3000', guild: '1000', channel: '2000'}\nsteps:\n  - {action: invoke-command, command: ping, saveAs: ping}\nassertions:\n  - {type: response-type, interaction: ping, equals: message}\n`;
  assert.equal(parseBotScenarioV2(yaml).name, 'YAML ping');
  const dm = canonical();
  delete dm.context.guild;
  dm.steps = [
    { action: 'send-message', content: '!ping', saveAs: 'message' },
    { action: 'await-message', content: 'Pong!', timeoutMs: 3000 },
  ];
  dm.assertions = [{ type: 'message-content', channel: '9000', equals: 'Pong!' }];
  const parsedDm = parseBotScenarioV2(dm);
  assert.deepEqual(parsedDm.context, { actor: '3000', channel: '2000' });
  const commandInDm = canonical();
  delete commandInDm.context.guild;
  assert.throws(() => parseBotScenarioV2(commandInDm), /require a guild/);
});

const invalidEdits = [
  (value) => {
    value.typo = true;
  },
  (value) => {
    value.execution.clock = 'virtual';
  },
  (value) => {
    value.execution.kind = 'model';
  },
  (value) => {
    value.execution.unknown = 'ignored';
  },
  (value) => {
    value.context.actor = '3e3';
  },
  (value) => {
    value.steps = [];
  },
  (value) => {
    value.steps[0].action = 'respond';
  },
  (value) => {
    value.steps[0].content = expected;
  },
  (value) => {
    value.steps[0].saveAs = 'bad.alias';
  },
  (value) => {
    value.steps.push({ ...value.steps[0] });
  },
  (value) => {
    value.steps = [{ action: 'await-response', interaction: '${future.id}' }];
  },
  (value) => {
    value.assertions = [];
  },
  (value) => {
    value.assertions = [{ type: 'no-unexpected-error' }];
  },
  (value) => {
    value.assertions[0].contains = 'Pong';
  },
  (value) => {
    value.assertions[0].interaction = 'missing';
  },
  (value) => {
    value.policy = { failOnSeverity: 'ignore-all' };
  },
  (value) => {
    value.faults = [{ id: 'unbounded', kind: 'delay', delayMs: 30001 }];
  },
  (value) => {
    value.faults = [{ id: 'unsupported', kind: 'http-status', status: 418 }];
  },
];
test('v2 parser rejects unknown settings, model replies, vacuous assertions and bad references', () => {
  for (const edit of invalidEdits) {
    const value = canonical();
    edit(value);
    assert.throws(() => parseBotScenarioV2(value), TypeError);
  }
  assert.throws(() => parseBotScenarioV2('version: 2\nversion: 1'), TypeError);
  assert.throws(() => parseBotScenarioV2('version: 2\nname: !unsafe value'), TypeError);
  let accessed = false;
  const value = canonical();
  value.steps[0].options = [
    {
      name: 'text',
      type: 3,
      nested: {
        get value() {
          accessed = true;
          return 'unsafe';
        },
      },
    },
  ];
  assert.throws(() => parseBotScenarioV2(value), TypeError);
  assert.equal(accessed, false);
  const cyclic = canonical();
  cyclic.steps[0].options = [{ name: 'loop', type: 3, value: cyclic }];
  assert.throws(() => parseBotScenarioV2(cyclic), TypeError);
});

test(
  'v2 runs the real child and fails an independently changed reply',
  { timeout: 30000 },
  async (t) => {
    for (const mode of ['normal', 'wrong-safe']) {
      const directory = await project(t, mode);
      const result = await runBotScenarioV2(canonical(), { baseDirectory: directory });
      assert.equal(result.status, mode === 'normal' ? 'passed' : 'failed', JSON.stringify(result));
      assert.equal(result.exitCode, mode === 'normal' ? 0 : 1);
      assert.deepEqual(result.cleanupErrors, []);
      const child = (await readFile(join(directory, 'child.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(child.some((event) => event.event === 'command' && event.command === 'ping'));
      assert.ok(child.some((event) => event.event === 'exit'));
      assert.equal(result.metadata.clock, 'realtime');
      assert.equal(result.metadata.replay, 'bot-rerun');
    }
  },
);

test(
  'missing replies fail unless a precise negative assertion consumes the timeout',
  { timeout: 20000 },
  async (t) => {
    const directory = await project(t, 'pong-only');
    const source = canonical();
    source.steps[0].timeoutMs = 150;
    const failed = await runBotScenarioV2(source, { baseDirectory: directory });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.assertions.find((item) => item.type === 'unexpected-error').passed, false);
    source.assertions = [{ type: 'error', request: 'ping', code: 'timeout' }];
    source.policy = { failOnSeverity: 'none' };
    const negative = await runBotScenarioV2(source, { baseDirectory: directory });
    assert.equal(negative.status, 'passed', JSON.stringify(negative));
  },
);

test(
  'ephemeral assertions use the selected viewer and retained interaction state',
  { timeout: 15000 },
  async (t) => {
    const directory = await project(t);
    const serverPath = join(directory, 'server.mjs');
    const server = await readFile(serverPath, 'utf8');
    assert.ok(server.includes('data: { content }'));
    await writeFile(
      serverPath,
      server.replace(
        'data: { content }',
        "data: { content, ...(interaction.data?.name === 'secret' ? { flags: 64 } : {}) }",
      ),
    );
    const configuration = await loadProjectConfiguration(directory);
    await saveWorkspace(
      directory,
      {
        version: 1,
        resources: [
          ...configuration.resources.filter(
            (resource) => resource.resourceType !== 'channel' || resource.type === 0,
          ),
          { resourceType: 'user', id: '4000', username: 'OtherUser', bot: false },
        ],
        scenarios: [],
        options: { mode: 'strict', seed: 42042 },
      },
      { expectedHash: null },
    );
    const source = canonical();
    source.steps[0].command = 'secret';
    source.assertions = [
      { type: 'message-content', interaction: '${ping.id}', actor: '3000', equals: expected },
      { type: 'message-count', actor: '3000', channel: '2000', equals: 1 },
      { type: 'message-count', actor: '4000', channel: '2000', equals: 0 },
      { type: 'visibility', interaction: '${ping.id}', actor: '3000', equals: 'ephemeral' },
      { type: 'visibility', interaction: '${ping.id}', actor: '4000', equals: 'absent' },
      { type: 'interaction-status', interaction: '${ping.id}', equals: 'responded' },
    ];
    const result = await runBotScenarioV2(source, { baseDirectory: directory });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(
      result.snapshot.coreState.resources.filter((resource) => resource.resourceType === 'message')
        .length,
      0,
    );
  },
);

test(
  'startup crash is a runner error and invalid scenarios never launch a child',
  { timeout: 15000 },
  async (t) => {
    const directory = await project(t, 'early-crash');
    const result = await runBotScenarioV2(canonical(), { baseDirectory: directory });
    assert.equal(result.status, 'runner-error');
    assert.equal(result.exitCode, 3);
    assert.equal(result.observations.length, 0);
    let constructed = false;
    const source = canonical();
    source.assertions = [];
    const invalid = await runBotScenarioV2(source, {
      baseDirectory: directory,
      createSession: () => {
        constructed = true;
        throw Error('must not run');
      },
    });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.exitCode, 2);
    assert.equal(constructed, false);
  },
);

test(
  'unmatched declared faults cannot pass and active delay receipts remain in the report',
  { timeout: 20000 },
  async (t) => {
    const directory = await project(t);
    const source = canonical();
    source.faults = [
      { id: 'unused-route', kind: 'delay', method: 'POST', route: '/never', delayMs: 10 },
    ];
    const unmatched = await runBotScenarioV2(source, { baseDirectory: directory });
    assert.equal(unmatched.status, 'failed');
    assert.equal(unmatched.assertions.find((item) => item.type === 'fault-applied').passed, false);
    source.faults = [
      {
        id: 'delayed-dispatch',
        kind: 'delay',
        method: 'POST',
        route: '/interactions',
        delayMs: 75,
      },
    ];
    const delayed = await runBotScenarioV2(source, { baseDirectory: directory });
    assert.equal(delayed.status, 'passed', JSON.stringify(delayed));
    assert.ok(
      delayed.metadata.faultEvidence.events.some(
        (event) => event.planId === 'delayed-dispatch' && event.phase === 'ready',
      ),
    );
    assert.ok(delayed.observations[0].result.durationMs >= 60);
    const fresh = await runBotScenarioV2(canonical(), { baseDirectory: directory });
    assert.equal(fresh.status, 'passed', JSON.stringify(fresh));
    assert.deepEqual(fresh.metadata.faultEvidence.events, []);
  },
);

test(
  'cancellation disposes the active process and cannot report success',
  { timeout: 15000 },
  async (t) => {
    const directory = await project(t);
    const source = canonical();
    source.steps.push({ action: 'await-message', content: 'will never appear', timeoutMs: 3000 });
    const controller = new AbortController();
    const result = await runBotScenarioV2(source, {
      baseDirectory: directory,
      signal: controller.signal,
      cancellationExitCode: 143,
      onSnapshot: (snapshot) => {
        if (snapshot.phase === 'running') setTimeout(() => controller.abort(), 50);
      },
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.exitCode, 143);
    assert.deepEqual(result.cleanupErrors, []);
  },
);

test(
  'cancellation during real shutdown remains cancelled after owned cleanup',
  { timeout: 15000 },
  async (t) => {
    const directory = await project(t);
    const controller = new AbortController();
    const session = createSession();
    const dispose = session.dispose.bind(session);
    session.dispose = async () => {
      controller.abort();
      return dispose();
    };
    const result = await runBotScenarioV2(canonical(), {
      baseDirectory: directory,
      signal: controller.signal,
      createSession: () => session,
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.exitCode, 130);
    assert.equal(result.issues.filter((entry) => entry.code === 'cancelled').length, 1);
    assert.deepEqual(result.cleanupErrors, []);
    assert.equal(session.snapshot().disposed, true);
    assert.equal(session.snapshot().pid, null);
    assert.equal(session.snapshot().endpoints, null);
  },
);

test('all four reports preserve failure and independently parse JSON, XML and HTML', async (t) => {
  const source = canonical();
  source.assertions = [];
  const result = await runBotScenarioV2(source, { baseDirectory: '.' });
  const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
  const { JSDOM } = requireDesktop('jsdom');
  const json = JSON.parse(renderBotScenarioV2Report(result, 'json'));
  assert.equal(json.status, 'invalid');
  const junit = new JSDOM(renderBotScenarioV2Report(result, 'junit'), { contentType: 'text/xml' })
    .window.document;
  assert.equal(junit.querySelector('parsererror'), null);
  assert.equal(junit.querySelector('testsuite').getAttribute('errors'), '1');
  const html = new JSDOM(renderBotScenarioV2Report(result, 'html')).window.document;
  assert.equal(html.querySelector('h1').textContent, 'Invalid scenario');
  assert.match(html.body.textContent, /INVALID/);
  const sarif = JSON.parse(renderBotScenarioV2Report(result, 'sarif'));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
  assert.ok(sarif.runs[0].results.length > 0);
  t.diagnostic(
    'Report parsing uses JSON.parse and jsdom XML/HTML parsers independent of the renderer.',
  );
});

function diagnosticPolicySession(mode) {
  const listeners = new Set();
  let current = {
    schemaVersion: 1,
    sessionId: 'policy-unit-session',
    runId: 'policy-unit-run',
    revision: 1,
    disposed: false,
    contexts: [{ actorId: '3000', guildId: '1000', channelId: '2000' }],
    phase: 'running',
    project: { adapter: 'unit-policy' },
    error: null,
    pid: null,
    endpoints: null,
    output:
      mode === 'stderr'
        ? [{ stream: 'stderr', text: 'Ordinary SDK diagnostic output.', atMs: 0 }]
        : [],
    traces: [],
    risks: [],
    diagnostics: [],
    inputs: {
      schemaVersion: 1,
      fixtureHash: 'initial-fixture',
      profileHash: 'initial-profile',
      sourceHash: 'initial-source',
    },
    coreState: {
      schemaVersion: 1,
      runId: 'policy-unit-run',
      stateRevision: 1,
      revisioned: true,
      clock: { domain: 'bot', mode: 'realtime', nowMs: 0 },
      resources: [
        {
          id: '9000',
          resourceType: 'message',
          channel_id: '2000',
          guild_id: '1000',
          author: { id: '5000', bot: true },
          content: expected,
          interaction_id: '4000',
          visibility: 'channel',
          type: 20,
          flags: 0,
        },
      ],
      totalResources: 1,
      truncated: false,
      evidenceComplete: true,
    },
  };
  const snapshot = () => structuredClone(current);
  const publishDiagnostic = () => {
    current.diagnostics = [
      { code: 'bot-error', message: 'The command handler failed after its initial response.' },
    ];
    for (const listener of listeners)
      listener({
        schemaVersion: 1,
        sessionId: current.sessionId,
        runId: current.runId,
        sequence: 2,
        kind: 'snapshot',
        snapshot: snapshot(),
      });
  };
  return {
    selectProject: async () => snapshot(),
    validateContext: (context) => ({ ...context }),
    start: async () => snapshot(),
    snapshot,
    snapshotForActor: snapshot,
    setFaults: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: async (request) => {
      current.inputs = {
        schemaVersion: 1,
        fixtureHash: 'mutated-fixture',
        profileHash: 'mutated-profile',
        sourceHash: 'mutated-source',
      };
      if (mode === 'immediate') publishDiagnostic();
      if (mode === 'after-ack') setTimeout(publishDiagnostic, 25);
      if (mode === 'pending-after-ack') {
        current.activeHandlers = 1;
        setTimeout(() => {
          current.activeHandlers = 0;
          publishDiagnostic();
        }, 150);
      }
      if (mode === 'hung') current.activeHandlers = 1;
      return {
        runId: request.runId,
        requestId: request.requestId,
        context: request.context,
        ok: true,
        command: 'ping',
        interactionId: '4000',
        durationMs: 1,
        response: { type: 'message', data: { content: expected } },
        error: null,
      };
    },
    dispose: async () => {
      if (mode === 'shutdown') publishDiagnostic();
      const last = snapshot();
      current = {
        ...current,
        phase: 'ready',
        disposed: true,
        diagnostics: [],
        coreState: { ...current.coreState, resources: [] },
      };
      return { ok: true, errors: [], snapshot: last };
    },
  };
}

test('policy unit: structured post-ACK and shutdown errors fail even when the reply matches', async () => {
  for (const mode of ['immediate', 'after-ack', 'pending-after-ack', 'shutdown']) {
    const source = canonical();
    source.assertions = [source.assertions[0]];
    source.policy = { failOnSeverity: 'none' };
    const result = await runBotScenarioV2(source, {
      baseDirectory: '.',
      createSession: () => diagnosticPolicySession(mode),
    });
    assert.equal(result.status, 'failed', `${mode}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.assertions.find((assertion) => assertion.type === 'message-content').passed,
      true,
    );
    assert.equal(
      result.assertions.find((assertion) => assertion.type === 'runtime-diagnostics').passed,
      false,
    );
    assert.equal(result.issues.filter((issue) => issue.code === 'bot-error').length, 1);
    assert.equal(
      result.snapshot.coreState.resources.length,
      1,
      'Shutdown must not replace the retained run state.',
    );
    for (const format of ['json', 'html', 'junit', 'sarif'])
      assert.match(renderBotScenarioV2Report(result, format), /handler failed|runtime-diagnostics/);
  }
});

test('policy unit: ordinary stderr is not a structured handler failure', async () => {
  const result = await runBotScenarioV2(canonical(), {
    baseDirectory: '.',
    createSession: () => diagnosticPolicySession('stderr'),
  });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(
    result.assertions.find((assertion) => assertion.type === 'runtime-diagnostics').passed,
    true,
  );
  assert.deepEqual(result.metadata.inputs, {
    schemaVersion: 1,
    fixtureHash: 'initial-fixture',
    profileHash: 'initial-profile',
    sourceHash: 'initial-source',
  });
});

test('policy unit: a handler that never finishes reaches the overall deadline and cannot pass', async () => {
  const source = canonical();
  source.execution.timeoutMs = 100;
  const result = await runBotScenarioV2(source, {
    baseDirectory: '.',
    createSession: () => diagnosticPolicySession('hung'),
  });
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.exitCode, 1);
  assert.ok(result.issues.some((issue) => issue.code === 'timeout'));
  assert.deepEqual(result.cleanupErrors, []);
});
