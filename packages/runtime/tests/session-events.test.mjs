import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSession } from '../dist/index.js';
const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2100' };
test('events are detached replacements and listener failures are isolated', async () => {
  const session = createSession();
  const events = [];
  session.subscribe(() => {
    throw new Error('observer');
  });
  session.subscribe((event) => {
    event.snapshot.output.push({ stream: 'stdout', text: 'mutation', atMs: 0 });
  });
  const unsubscribe = session.subscribe((event) => events.push(event));
  await session.selectProject(project);
  assert.equal(events[0].sequence, 0);
  assert.equal(events[1].sequence, 1);
  assert.deepEqual(events[1].snapshot.output, []);
  assert.equal(events[1].snapshot.revision, events[1].sequence);
  unsubscribe();
  unsubscribe();
  await session.dispose();
  assert.equal(events.length, 2);
});
test('late observers receive current state after unobserved operations without event replay', async () => {
  const session = createSession();
  try {
    const initialRevision = session.snapshot().revision;
    await session.selectProject(project);
    const started = await session.start();
    const invoke = (requestId) =>
      session.invoke({ runId: started.runId, requestId, input: '/ping', context });
    assert.equal(
      (await invoke('unobserved-first')).response.data.content,
      'Pong! Offline and deterministic.',
    );
    const current = session.snapshot();
    assert.ok(current.revision > initialRevision);
    assert.equal(current.phase, 'running');
    const messages = (snapshot) =>
      snapshot.coreState.resources.filter((resource) => resource.resourceType === 'message');
    assert.equal(messages(current).length, 1);

    const firstEvents = [];
    const unsubscribe = session.subscribe((event) => firstEvents.push(event));
    assert.equal(firstEvents.length, 1, 'unobserved publications are not replayed');
    assert.equal(firstEvents[0].sequence, current.revision);
    assert.equal(firstEvents[0].snapshot.revision, current.revision);
    assert.deepEqual(messages(firstEvents[0].snapshot), messages(current));
    messages(firstEvents[0].snapshot)[0].content = 'observer mutation';
    assert.equal(messages(session.snapshot())[0].content, 'Pong! Offline and deterministic.');
    unsubscribe();

    assert.equal(
      (await invoke('unobserved-second')).response.data.content,
      'Pong! Offline and deterministic.',
    );
    const later = session.snapshot();
    assert.ok(later.revision > current.revision);
    assert.equal(messages(later).length, 2);
    assert.equal(firstEvents.length, 1, 'unsubscribed listeners remain detached');

    const laterEvents = [];
    session.subscribe((event) => laterEvents.push(event));
    assert.equal(laterEvents.length, 1);
    assert.equal(laterEvents[0].sequence, later.revision);
    assert.deepEqual(messages(laterEvents[0].snapshot), messages(later));
    assert.equal((await session.dispose()).ok, true);
    assert.ok(laterEvents.some((event) => event.snapshot.disposed));
    const sequences = laterEvents.map((event) => event.sequence);
    assert.deepEqual(
      sequences,
      [...new Set(sequences)].sort((a, b) => a - b),
    );
    for (const event of laterEvents) assert.equal(event.snapshot.revision, event.sequence);

    const disposedEvents = [];
    session.subscribe((event) => disposedEvents.push(event));
    assert.equal(disposedEvents.length, 1, 'a disposed subscription receives its current snapshot');
    assert.equal(disposedEvents[0].snapshot.disposed, true);
    assert.equal(disposedEvents[0].sequence, session.snapshot().revision);
  } finally {
    assert.equal((await session.dispose()).ok, true);
  }
});
test('real shared session starts authenticated, rejects stale and duplicate requests, restarts with new identity', async () => {
  const session = createSession();
  try {
    await session.selectProject(project);
    const started = await session.start();
    assert.equal(started.phase, 'running');
    const request = { runId: started.runId, requestId: 'ping-1', input: '/ping', context };
    const result = await session.invoke(request);
    assert.equal(result.response.data.content, 'Pong! Offline and deterministic.');
    assert.deepEqual(result.context, context);
    await assert.rejects(session.invoke(request), { code: 'invalid' });
    assert.equal((await session.stop()).ok, true);
    const restarted = await session.start();
    assert.notEqual(restarted.runId, started.runId);
    await assert.rejects(session.invoke({ ...request, requestId: 'stale' }), {
      code: 'not-running',
    });
    assert.equal((await session.invoke({ ...request, runId: restarted.runId })).ok, true);
  } finally {
    assert.equal((await session.dispose()).ok, true);
  }
});
test('dispose from a starting snapshot cannot launch or retain a child', async () => {
  const session = createSession();
  await session.selectProject(project);
  let disposal;
  session.subscribe((event) => {
    if (event.snapshot.phase === 'starting' && disposal === undefined) disposal = session.dispose();
  });
  await assert.rejects(session.start(), { code: 'cancelled' });
  assert.equal((await disposal).ok, true);
  assert.equal(session.snapshot().disposed, true);
  assert.equal(session.snapshot().pid, null);
  assert.notEqual(session.snapshot().phase, 'running');
});
test('stop interrupts startup and deadline yields typed timeout', async () => {
  const session = createSession();
  await session.selectProject(project);
  const starting = session.start();
  const stopped = session.stop();
  await assert.rejects(starting, { code: 'cancelled' });
  assert.equal((await stopped).ok, true);
  await assert.rejects(session.start({ timeoutMs: 1 }), { code: 'timeout' });
  assert.equal((await session.dispose()).ok, true);
});
test('reentrant snapshot changes remain ordered and disposed start cannot succeed', async () => {
  const session = createSession();
  await session.selectProject(project);
  let disposal;
  const sequences = [];
  session.subscribe((event) => {
    if (event.snapshot.phase === 'running' && !event.snapshot.disposed)
      disposal = session.dispose();
  });
  session.subscribe((event) => sequences.push(event.sequence));
  await assert.rejects(session.start(), { code: 'cancelled' });
  assert.equal((await disposal).ok, true);
  assert.deepEqual(
    sequences,
    [...new Set(sequences)].sort((a, b) => a - b),
  );
});
test('cleanup tries every server and retains failed ownership until retry', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../dist/index.js', import.meta.url));
  const core = await import(pathToFileURL(require.resolve('@disrunner/core')).href);
  const restStop = core.LocalRestEmulator.prototype.stop;
  const gatewayStop = core.LocalGatewayServer.prototype.stop;
  let restCalls = 0;
  let gatewayCalls = 0;
  core.LocalRestEmulator.prototype.stop = async function () {
    restCalls += 1;
    if (restCalls === 1) throw new Error('synthetic cleanup failure');
    return restStop.call(this);
  };
  core.LocalGatewayServer.prototype.stop = async function () {
    gatewayCalls += 1;
    return gatewayStop.call(this);
  };
  const session = createSession();
  try {
    await session.selectProject(project);
    await session.start();
    const failed = await session.stop();
    assert.equal(failed.ok, false);
    assert.deepEqual(
      failed.errors.map((issue) => issue.code),
      ['cleanup'],
    );
    assert.equal(gatewayCalls, 1);
    await assert.rejects(session.start(), { code: 'invalid' });
    const retried = await session.dispose();
    assert.equal(retried.ok, true);
    assert.equal(restCalls, 2);
    assert.equal(gatewayCalls, 1);
    assert.equal((await session.dispose()).ok, true);
  } finally {
    core.LocalRestEmulator.prototype.stop = restStop;
    core.LocalGatewayServer.prototype.stop = gatewayStop;
    await session.dispose();
  }
});
test('abort from the running snapshot rejects startup and cleans acquired resources', async () => {
  const session = createSession();
  const controller = new AbortController();
  await session.selectProject(project);
  session.subscribe((event) => {
    if (event.snapshot.phase === 'running') controller.abort();
  });
  await assert.rejects(session.start({ signal: controller.signal }), { code: 'cancelled' });
  assert.equal(session.snapshot().pid, null);
  assert.equal(session.snapshot().endpoints, null);
  assert.equal((await session.dispose()).ok, true);
});
