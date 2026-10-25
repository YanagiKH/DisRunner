import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBotScenarioV2, SessionError } from '../dist/index.js';

const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const diagnostic = { code: 'bot-error', message: 'The Bot failed after replying.' };
const childExit = { code: 'child-exited', message: 'Bot process exited unexpectedly.' };
const cleanupFailure = { code: 'cleanup', message: 'Listener closure could not be confirmed.' };
const scenario = {
  version: 2,
  name: 'Final capture contract',
  execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 1000 },
  context: { actor: '3000', guild: '1000', channel: '2000' },
  steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }],
  assertions: [{ type: 'message-content', interaction: '${ping.id}', equals: 'Pong!' }],
};

function coreState(patch = {}) {
  return {
    schemaVersion: 1,
    runId: 'capture-run',
    stateRevision: 1,
    revisioned: true,
    clock: { domain: 'bot', mode: 'realtime', nowMs: 0 },
    resources: [
      {
        resourceType: 'message',
        id: '5000',
        interaction_id: '4000',
        channel_id: '2000',
        guild_id: '1000',
        type: 20,
        author: { id: '6000', bot: true },
        content: 'Pong!',
        flags: 0,
        visibility: 'channel',
      },
    ],
    totalResources: 1,
    truncated: false,
    evidenceComplete: true,
    ...patch,
  };
}

function snapshot(patch = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'capture-session',
    runId: 'capture-run',
    revision: 0,
    disposed: false,
    phase: 'running',
    contexts: [context],
    project: { adapter: 'discord.js' },
    error: null,
    pid: null,
    endpoints: null,
    output: [],
    traces: [],
    risks: [],
    diagnostics: [],
    activeHandlers: 0,
    evidenceComplete: true,
    droppedOutput: 0,
    droppedTraces: 0,
    droppedRisks: 0,
    coreState: coreState(),
    ...patch,
  };
}

function fatalSnapshot(patch = {}) {
  return snapshot({
    phase: 'error',
    error: childExit.message,
    diagnostics: [diagnostic],
    ...patch,
  });
}

// A finite Session collaborator supplies public snapshots at operation boundaries.
// It does not emulate Bot transport or change snapshots according to runner read counts.
function finiteSession({
  dispatchSnapshots,
  terminalSnapshot,
  shutdownSnapshots = [],
  cleanup = 'confirmed',
  startFailure = false,
}) {
  const listeners = new Set();
  let current = snapshot({ phase: 'ready', runId: null, coreState: null });
  let revision = 0;
  let disposals = 0;
  const copy = () => structuredClone(current);
  const publish = (next) => {
    current = { ...structuredClone(next), revision: ++revision };
    for (const listener of listeners)
      listener({
        schemaVersion: 1,
        sessionId: current.sessionId,
        runId: current.runId,
        sequence: revision,
        kind: 'snapshot',
        snapshot: copy(),
      });
  };
  const session = {
    selectProject: async () => copy(),
    start: async () => {
      if (startFailure) throw new SessionError('start-failed', 'The Bot did not start.');
      publish(snapshot({ coreState: coreState({ resources: [], totalResources: 0 }) }));
      return copy();
    },
    validateContext: (selected) => ({ ...selected }),
    setFaults: () => {},
    snapshot: copy,
    snapshotForActor: copy,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: async (request) => {
      assert.equal(request.action.type, 'command');
      assert.equal(request.action.name, 'ping');
      assert.deepEqual(request.context, context);
      for (const next of dispatchSnapshots) publish(next);
      return {
        runId: request.runId,
        requestId: request.requestId,
        context: { ...request.context },
        ok: true,
        command: 'ping',
        interactionId: '4000',
        durationMs: 1,
        response: { type: 'message', data: { content: 'Pong!' } },
        error: null,
      };
    },
    dispose: async () => {
      disposals++;
      // The terminal capture becomes available after the finite pending drain settles.
      await Promise.resolve();
      for (const next of shutdownSnapshots) publish(next);
      publish({ ...terminalSnapshot, disposed: true });
      if (cleanup === 'throw') throw new Error('Cleanup could not be confirmed.');
      const errors =
        cleanup === 'child-exited' ? [childExit] : cleanup === 'error' ? [cleanupFailure] : [];
      return { ok: cleanup === 'confirmed', errors, snapshot: copy() };
    },
  };
  return { session, disposalCount: () => disposals, listenerCount: () => listeners.size };
}

function assertFinalEvidence(result, complete) {
  const core = result.snapshot?.coreState;
  assert.deepEqual(
    {
      metadata: result.metadata.evidenceComplete,
      snapshot: result.snapshot?.evidenceComplete,
      assertions: result.assertions
        .filter((assertion) => assertion.type === 'evidence-complete')
        .map((assertion) => assertion.passed),
      ...(complete
        ? {
            coreRunId: core?.runId ?? null,
            reply:
              core?.resources.find((resource) => resource.interaction_id === '4000')?.content ??
              null,
          }
        : {}),
    },
    {
      metadata: complete,
      snapshot: complete,
      assertions: result.runId === null ? [] : [complete],
      ...(complete ? { coreRunId: result.runId, reply: 'Pong!' } : {}),
    },
    'the final audit agrees across the report and retains the same-run Core reply',
  );
}

const cases = [
  {
    name: 'a complete successful reply remains a passing control',
    dispatchSnapshots: [snapshot()],
    terminalSnapshot: snapshot({ phase: 'ready', coreState: null }),
    complete: true,
    status: 'passed',
    exitCode: 0,
  },
  {
    name: 'an early fatal run can have complete evidence without becoming a success',
    dispatchSnapshots: [fatalSnapshot(), fatalSnapshot({ coreState: null })],
    terminalSnapshot: fatalSnapshot({ coreState: null }),
    cleanup: 'child-exited',
    complete: true,
    status: 'runner-error',
    exitCode: 3,
    fatal: true,
  },
  {
    name: 'pending EOF without data loss becomes complete after terminal drain',
    dispatchSnapshots: [
      fatalSnapshot({ evidenceComplete: false }),
      fatalSnapshot({ evidenceComplete: false, coreState: null }),
    ],
    terminalSnapshot: fatalSnapshot({ coreState: null }),
    cleanup: 'child-exited',
    complete: true,
    status: 'runner-error',
    exitCode: 3,
    fatal: true,
  },
  {
    name: 'a running pending-drain capture becomes complete when fatal shutdown finishes',
    dispatchSnapshots: [snapshot({ evidenceComplete: false, diagnostics: [diagnostic] })],
    terminalSnapshot: fatalSnapshot({ coreState: null }),
    cleanup: 'child-exited',
    complete: true,
    status: 'runner-error',
    exitCode: 3,
    fatal: true,
  },
  {
    name: 'durable output loss remains incomplete despite a correct reply',
    dispatchSnapshots: [snapshot({ evidenceComplete: false, droppedOutput: 1 })],
    terminalSnapshot: snapshot({
      phase: 'ready',
      coreState: null,
      evidenceComplete: false,
      droppedOutput: 1,
    }),
    complete: false,
    status: 'failed',
    exitCode: 1,
  },
  {
    name: 'observed Core truncation stays incomplete after the fatal run releases Core',
    dispatchSnapshots: [
      snapshot({ coreState: coreState({ truncated: true, evidenceComplete: false }) }),
      fatalSnapshot({ coreState: null }),
    ],
    terminalSnapshot: fatalSnapshot({ coreState: null }),
    cleanup: 'child-exited',
    complete: false,
    status: 'runner-error',
    exitCode: 3,
    fatal: true,
  },
  {
    name: 'Core loss observed during shutdown remains incomplete after release',
    dispatchSnapshots: [snapshot()],
    shutdownSnapshots: [
      snapshot({
        phase: 'stopping',
        coreState: coreState({ truncated: true, evidenceComplete: false }),
      }),
    ],
    terminalSnapshot: snapshot({ phase: 'ready', coreState: null }),
    complete: false,
    status: 'failed',
    exitCode: 1,
  },
  {
    name: 'an unfinished terminal handler prevents complete evidence',
    dispatchSnapshots: [fatalSnapshot({ activeHandlers: 1 })],
    terminalSnapshot: fatalSnapshot({ coreState: null, activeHandlers: 1 }),
    cleanup: 'child-exited',
    complete: false,
    status: 'runner-error',
    exitCode: 3,
    fatal: true,
  },
  ...['error', 'throw', 'empty'].map((cleanup) => ({
    name: `unconfirmed cleanup (${cleanup}) prevents complete evidence`,
    dispatchSnapshots: [snapshot()],
    terminalSnapshot: snapshot({ phase: 'error', coreState: null }),
    cleanup,
    complete: false,
    status: 'runner-error',
    exitCode: 3,
  })),
];

for (const entry of cases) {
  test(`evidence finalization contract: ${entry.name}`, async () => {
    const fixture = finiteSession(entry);
    const result = await runBotScenarioV2(scenario, {
      baseDirectory: '.',
      createSession: () => fixture.session,
    });
    assert.equal(fixture.disposalCount(), 1);
    assert.equal(fixture.listenerCount(), 0);
    assert.equal(result.observations[0]?.result?.response?.data.content, 'Pong!');
    assert.equal(result.status, entry.status);
    assert.equal(result.exitCode, entry.exitCode);
    if (entry.fatal) {
      assert.ok(
        [...result.issues, ...result.cleanupErrors].some((issue) => issue.code === 'child-exited'),
      );
      assert.ok(result.issues.some((issue) => issue.code === 'bot-error'));
      assert.equal(
        result.assertions.find((assertion) => assertion.type === 'runtime-diagnostics').passed,
        false,
      );
    } else {
      assert.equal(
        result.assertions.find((assertion) => assertion.type === 'message-content').passed,
        true,
      );
    }
    if (['error', 'throw', 'empty'].includes(entry.cleanup))
      assert.ok(result.cleanupErrors.some((issue) => issue.code === 'cleanup'));
    assertFinalEvidence(result, entry.complete);
  });
}

test('evidence finalization contract: a failed start cannot borrow an empty complete disposal', async () => {
  const fixture = finiteSession({
    startFailure: true,
    dispatchSnapshots: [],
    terminalSnapshot: snapshot({ phase: 'ready', runId: null, coreState: null }),
  });
  const result = await runBotScenarioV2(scenario, {
    baseDirectory: '.',
    createSession: () => fixture.session,
  });
  assert.equal(fixture.disposalCount(), 1);
  assert.equal(fixture.listenerCount(), 0);
  assert.equal(result.runId, null);
  assert.equal(result.status, 'runner-error');
  assert.equal(result.exitCode, 3);
  assert.ok(result.issues.some((issue) => issue.code === 'start-failed'));
  assert.deepEqual(result.observations, []);
  assertFinalEvidence(result, false);
});
