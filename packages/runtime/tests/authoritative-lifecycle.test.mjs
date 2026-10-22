import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSessionWithDependencies } from '../dist/session.js';

const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));

test('real runtime retains the actual store after failed REST closure, releases after retry, isolates restart', async () => {
  let fail = true;
  const session = createSessionWithDependencies(
    {},
    {
      wrapRest(rest) {
        return {
          start: (...args) => rest.start(...args),
          stop: () => {
            if (fail) return Promise.reject(Error('injected closure failure'));
            return rest.stop();
          },
        };
      },
    },
  );
  try {
    await session.selectProject(project);
    assert.equal(session.snapshot().coreState, null);
    const started = await session.start();
    assert.equal(started.phase, 'running');
    assert.equal(started.coreState.runId, started.runId);
    assert.equal(started.coreState.clock.mode, 'realtime');
    assert.ok(started.coreState.resources.length > 0);
    // Legacy stores must report revision metadata as unavailable, never fabricate it.
    if (!started.coreState.revisioned) assert.equal(started.coreState.stateRevision, null);
    const retained = session.snapshot().coreState;
    retained.resources.length = 0;
    assert.ok(session.snapshot().coreState.resources.length > 0);
    const stopped = await session.stop();
    assert.equal(stopped.ok, false);
    assert.equal(stopped.snapshot.phase, 'error');
    assert.equal(session.snapshot().coreState.runId, started.runId);
    await assert.rejects(session.start(), /cleanup/);
    fail = false;
    assert.equal((await session.stop()).ok, true);
    assert.equal(session.snapshot().coreState, null);
    const restarted = await session.start();
    assert.notEqual(restarted.runId, started.runId);
    assert.equal(restarted.coreState.runId, restarted.runId);
  } finally {
    fail = false;
    assert.equal((await session.dispose()).ok, true);
  }
});
