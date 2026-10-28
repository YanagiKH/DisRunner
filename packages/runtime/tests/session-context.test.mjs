import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSession, SessionError } from '../dist/index.js';
const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };

async function pinLegacyFixture(directory) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const configPath = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
  config.bot.entryPoint = 'src/legacy-session-entry.mjs';
  config.bot.startCommand = 'node src/legacy-session-entry.mjs';
  await writeFile(configPath, JSON.stringify(config));
  // Start the unchanged authenticated server without the example's v2 registration wrapper.
  await writeFile(
    join(directory, 'src/legacy-session-entry.mjs'),
    `import {createWebhookServer,loadServerOptionsFromEnvironment} from './server.mjs';
const options=loadServerOptionsFromEnvironment();
const server=createWebhookServer(options);
server.listen(options.port,options.host);
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
  );
}
test('explicit contexts are validated without starting and snapshots are detached', async () => {
  const session = createSession();
  assert.throws(() => session.validateContext(context), SessionError);
  const selected = await session.selectProject(project);
  assert.equal(selected.contexts.length, 2);
  const copy = session.validateContext(context);
  assert.deepEqual(copy, context);
  copy.channelId = 'missing';
  assert.deepEqual(session.validateContext(context), context);
  for (const bad of [
    { ...context, actorId: 'missing' },
    { ...context, guildId: 'wrong' },
    { ...context, channelId: 'missing' },
    { ...context, actorId: '\0' },
    { ...context, actorId: 'あ'.repeat(43) },
  ]) {
    assert.throws(() => session.validateContext(bad), { code: 'invalid' });
  }
  selected.contexts[0].actorId = 'changed';
  assert.equal(session.snapshot().contexts[0].actorId, '3000');
  assert.equal((await session.dispose()).ok, true);
  await assert.rejects(session.selectProject(project), { code: 'invalid' });
  await assert.rejects(session.start(), { code: 'invalid' });
});
test('pre-aborted start acquires no resources', async () => {
  const session = createSession();
  await session.selectProject(project);
  await assert.rejects(session.start({ signal: AbortSignal.abort() }), { code: 'cancelled' });
  assert.equal(session.snapshot().runId, null);
  assert.equal((await session.dispose()).ok, true);
});

test('wire context is explicit and selected fixtures stay frozen across disk edits', async () => {
  const { cp, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'session-context-'));
  const session = createSession();
  try {
    await cp(project, directory, { recursive: true });
    await pinLegacyFixture(directory);
    const server = join(directory, 'src/server.mjs');
    const source = await readFile(server, 'utf8');
    const anchor = '  const reply = interactionReply(interaction);';
    assert.equal(source.split(anchor).length, 2, 'one authenticated command handler point');
    await writeFile(
      server,
      source.replace(
        anchor,
        `  if (interaction.type === 2 && interaction.data?.name === 'ping') {
    send(200, {type:4,data:{content:JSON.stringify({guildId:interaction.guild_id,channelId:interaction.channel_id,user:interaction.member.user,memberKeys:Object.keys(interaction.member)})}});
    return;
  }
${anchor}`,
      ),
    );
    await session.selectProject(directory);
    const userFile = join(directory, 'fixtures/developer.discord-fixture.json');
    const fixture = JSON.parse(await readFile(userFile, 'utf8'));
    const original = structuredClone(fixture.user);
    fixture.user.id = 'changed-on-disk';
    await writeFile(userFile, JSON.stringify(fixture));
    const started = await session.start();
    const pending = {
      runId: started.runId,
      requestId: 'context',
      input: '/ping',
      context: { ...context, channelId: '2100' },
    };
    const invocation = session.invoke(pending);
    pending.context.channelId = '2000';
    const result = await invocation;
    const observed = JSON.parse(result.response.data.content);
    assert.equal(observed.guildId, '1000');
    assert.equal(observed.channelId, '2100');
    assert.deepEqual(observed.user, original);
    assert.deepEqual(observed.memberKeys, ['user']);
    assert.equal(result.context.channelId, '2100');
  } finally {
    const shutdown = await session.dispose();
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown.errors));
    await rm(directory, { recursive: true, force: true });
  }
});

test('authenticated live channel edits and deletes revoke invocation contexts immediately', async (t) => {
  const { createSessionWithDependencies } = await import('../dist/session.js');
  const { cp, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'legacy-live-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(project, directory, { recursive: true });
  await pinLegacyFixture(directory);
  let token;
  const session = createSessionWithDependencies(
    {},
    {
      wrapBot(bot) {
        return {
          start(config) {
            token = config.fakeToken;
            return bot.start(config);
          },
          stop: (...args) => bot.stop(...args),
          snapshot: () => bot.snapshot(),
          observeExit: () => bot.observeExit(),
        };
      },
    },
  );
  try {
    await session.selectProject(directory);
    const started = await session.start();
    const mutate = (method, body) =>
      fetch(`${started.endpoints.restBaseUrl}/channels/2000`, {
        method,
        headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    assert.deepEqual(session.validateContext(context), context);
    const changed = await mutate('PATCH', { type: 2 });
    assert.equal(changed.status, 200);
    await changed.json();
    assert.throws(() => session.validateContext(context), { code: 'invalid' });
    await assert.rejects(
      session.invoke({
        runId: started.runId,
        requestId: 'changed-channel',
        input: '/ping',
        context,
      }),
      { code: 'invalid' },
    );
    const restored = await mutate('PATCH', { type: 0 });
    assert.equal(restored.status, 200);
    await restored.json();
    assert.deepEqual(session.validateContext(context), context);
    const removed = await mutate('DELETE');
    assert.equal(removed.status, 204);
    assert.equal(
      session.snapshot().contexts.some((c) => c.channelId === '2000'),
      false,
    );
    await assert.rejects(
      session.invoke({
        runId: started.runId,
        requestId: 'deleted-channel',
        input: '/ping',
        context,
      }),
      { code: 'invalid' },
    );
    assert.equal((await session.stop()).ok, true);
    assert.deepEqual(
      session.validateContext(context),
      context,
      'Stopped pre-run selection uses frozen fixture again.',
    );
  } finally {
    assert.equal((await session.dispose()).ok, true);
  }
});

test('wire actor uses actual retained state and deleted live actor cannot invoke', async () => {
  const { VirtualState } = await import('@disrunner/core');
  const originalSnapshot = VirtualState.prototype.revisionedSnapshot;
  let actual;
  // Observe the actual production store used for publication; do not substitute data or methods.
  VirtualState.prototype.revisionedSnapshot = function (...args) {
    actual = { state: this };
    return originalSnapshot.apply(this, args);
  };
  const { cp, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'live-actor-'));
  const session = createSession();
  try {
    await cp(project, directory, { recursive: true });
    await pinLegacyFixture(directory);
    const server = join(directory, 'src/server.mjs');
    const source = await readFile(server, 'utf8');
    const anchor = '  const reply = interactionReply(interaction);';
    assert.equal(source.split(anchor).length, 2, 'one authenticated command handler point');
    await writeFile(
      server,
      source.replace(
        anchor,
        `
  if (interaction.type === 2 && interaction.data?.name === 'wait') {
    const fs = await import('node:fs/promises');
    await fs.writeFile('dispatched', 'ready');
    while (true) {
      try { await fs.access('release'); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (interaction.type === 2 && ['ping','wait'].includes(interaction.data?.name)) {
    send(200,{type:4,data:{content:interaction.member.user.username}});
    return;
  }
${anchor}`,
      ),
    );
    await session.selectProject(directory);
    const started = await session.start();
    VirtualState.prototype.revisionedSnapshot = originalSnapshot;
    assert.ok(actual?.state instanceof VirtualState);
    const published = [];
    const unsubscribe = session.subscribe((event) => published.push(event));
    for (const [id, visibility, flags] of [
      ['private-fixture', 'private', 0],
      ['ephemeral-fixture', 'channel', 64],
      ['unknown-fixture', 'unknown', 0],
      ['forged-fixture', 'channel', 2 ** 40],
    ]) {
      actual.state.create('message', {
        id,
        visibility,
        flags,
        type: 0,
        guild_id: '1000',
        channel_id: '2000',
        content: 'PRIVATE_IPC_SENTINEL',
      });
    }
    assert.equal(JSON.stringify(published).includes('PRIVATE_IPC_SENTINEL'), false);
    assert.equal(JSON.stringify(session.snapshot()).includes('PRIVATE_IPC_SENTINEL'), false);
    unsubscribe();
    actual.state.update('user', '3000', { username: 'Live renamed actor' });
    const result = await session.invoke({
      runId: started.runId,
      requestId: 'renamed',
      input: '/ping',
      context,
    });
    assert.equal(result.response.data.content, 'Live renamed actor');
    const pending = session.invoke({
      runId: started.runId,
      requestId: 'pending-deletion',
      input: '/wait',
      context,
    });
    const rejected = assert.rejects(pending, { code: 'invalid' });
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await readFile(join(directory, 'dispatched'));
        break;
      } catch {
        // Wait until the signed callback creates its dispatch marker.
      }
      assert.ok(Date.now() < deadline, 'Signed callback was not dispatched.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    actual.state.delete('user', '3000');
    await writeFile(join(directory, 'release'), 'continue');
    await rejected;
    assert.deepEqual(session.snapshot().contexts, []);
    await assert.rejects(
      session.invoke({ runId: started.runId, requestId: 'deleted', input: '/ping', context }),
      { code: 'invalid' },
    );
  } finally {
    VirtualState.prototype.revisionedSnapshot = originalSnapshot;
    assert.equal((await session.dispose()).ok, true);
    await rm(directory, { recursive: true, force: true });
  }
});
