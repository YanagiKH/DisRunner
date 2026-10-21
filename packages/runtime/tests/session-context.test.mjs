import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSession, SessionError } from '../dist/index.js';
const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
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
    const server = join(directory, 'src/server.mjs');
    await writeFile(
      server,
      (await readFile(server, 'utf8')).replace(
        "'Pong! Offline and deterministic.'",
        'JSON.stringify({ guildId: interaction.guild_id, channelId: interaction.channel_id, user: interaction.member.user, memberKeys: Object.keys(interaction.member) })',
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
    assert.equal((await session.dispose()).ok, true);
    await rm(directory, { recursive: true, force: true });
  }
});
