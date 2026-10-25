import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSession } from '../dist/index.js';

const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const canonical = { actorId: '3000', guildId: '1000', channelId: '2000' };
async function withFixture(context, run) {
  const directory = await mkdtemp(join(tmpdir(), 'context-id-preflight-'));
  const session = createSession();
  try {
    await cp(project, directory, { recursive: true });
    const configFile = join(directory, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
    config.bot.entryPoint = 'src/legacy-context-entry.mjs';
    config.bot.startCommand = 'node src/legacy-context-entry.mjs';
    await writeFile(configFile, JSON.stringify(config));
    // Keep the original signed transport and handler without v2 command registration.
    await writeFile(
      join(directory, config.bot.entryPoint),
      `import {createWebhookServer,loadServerOptionsFromEnvironment} from './server.mjs';
const options=loadServerOptionsFromEnvironment();
const server=createWebhookServer(options);
server.listen(options.port,options.host);
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
    );
    const userFile = join(directory, 'fixtures/developer.discord-fixture.json');
    const user = JSON.parse(await readFile(userFile, 'utf8'));
    user.user.id = context.actorId;
    await writeFile(userFile, JSON.stringify(user));
    const guildFile = join(directory, 'fixtures/foundation-lab.discord-fixture.json');
    const guild = JSON.parse(await readFile(guildFile, 'utf8'));
    guild.guild.id = context.guildId;
    for (const channel of guild.guild.channels) channel.guild_id = context.guildId;
    guild.guild.channels[0].id = context.channelId;
    // Unselected resources keep the existing permissive fixture contract.
    guild.guild.roles[0].id = 'opaque-role';
    guild.guild.channels[1].id = 'opaque-unselected-channel';
    await writeFile(guildFile, JSON.stringify(guild));
    await session.selectProject(directory);
    await run(session);
  } finally {
    assert.equal((await session.dispose()).ok, true);
    await rm(directory, { recursive: true, force: true });
  }
}
for (const field of ['actorId', 'guildId', 'channelId']) {
  for (const id of ['opaque-id', '03000', '0', '-1', '1e3', '18446744073709551616']) {
    test(`preflight rejects selected ${field}=${id} before startup`, async () => {
      const context = { ...canonical, [field]: id };
      await withFixture(context, async (session) => {
        assert.throws(() => session.validateContext(context), {
          code: 'invalid',
          message: /canonical positive decimal unsigned 64-bit/,
        });
        assert.equal(session.snapshot().phase, 'ready');
        assert.equal(session.snapshot().runId, null);
        assert.equal(session.snapshot().pid, null);
        assert.equal(session.snapshot().coreState, null);
      });
    });
  }
}
for (const id of ['1', '18446744073709551615']) {
  test(`canonical boundary ${id} invokes with unrelated opaque fixtures intact`, async () => {
    const context = { actorId: id, guildId: id, channelId: id };
    await withFixture(context, async (session) => {
      assert.deepEqual(session.validateContext(context), context);
      const started = await session.start();
      const before = session.snapshot();
      await assert.rejects(
        session.invoke({
          runId: started.runId,
          requestId: 'invalid-live-context',
          input: '/ping',
          context: { ...context, channelId: 'opaque-unselected-channel' },
        }),
        { code: 'invalid', message: /canonical positive decimal unsigned 64-bit/ },
      );
      const after = session.snapshot();
      assert.equal(after.revision, before.revision);
      assert.equal(after.coreState.stateRevision, before.coreState.stateRevision);
      assert.deepEqual(after.coreState.resources, before.coreState.resources);
      assert.deepEqual(after.traces, before.traces);
      assert.deepEqual(after.risks, before.risks);
      const result = await session.invoke({
        runId: started.runId,
        requestId: `boundary-${id}`,
        input: '/ping',
        context,
      });
      assert.equal(result.ok, true);
      assert.equal(result.response.data.content, 'Pong! Offline and deterministic.');
    });
  });
}
