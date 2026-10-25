import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSession, RuntimeManager } from '../dist/index.js';

const project = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
async function withBot(content, run) {
  const directory = await mkdtemp(join(tmpdir(), 'exact-response-'));
  try {
    await cp(project, directory, { recursive: true });
    const configPath = join(directory, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profile.commandRegistry = { profile: 'command-registry-v1', guildIds: [] };
    config.bot.entryPoint = 'src/legacy-session-entry.mjs';
    config.bot.startCommand = 'node src/legacy-session-entry.mjs';
    await writeFile(configPath, JSON.stringify(config));
    // Preserve the exact authenticated-response contract before modern payload validation.
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
    const commands = join(directory, 'src/commands.mjs');
    const source = await readFile(commands, 'utf8');
    const literal = "'Pong! Offline and deterministic.'";
    assert.equal(
      source.split(literal).length,
      2,
      'the ping reply mutation must match exactly once',
    );
    await writeFile(commands, source.replace(literal, JSON.stringify(content)));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
for (const [name, content] of [
  ['authorization projection', 'WRONG BOT RESPONSE'],
  ['synthetic credential', `Bearer ${'a'.repeat(50)}`],
  ['capped response', 'x'.repeat(100_001)],
]) {
  test(`exact session rejects ${name} before any projected assertion can pass`, async () => {
    await withBot(content, async (directory) => {
      const session = createSession();
      try {
        await session.selectProject(directory);
        const { runId } = await session.start();
        let assertion;
        await assert.rejects(
          async () => {
            const result = await session.invoke({
              runId,
              requestId: 'ping-1',
              input: '/ping',
              context,
            });
            assertion =
              result.response?.type === 'message' &&
              result.response.data.content === 'WRONG BOT [REDACTED]';
          },
          (error) =>
            error.code === 'transport' &&
            error.message === 'Authenticated response cannot be represented exactly and safely.',
        );
        assert.equal(assertion, undefined);
        const snapshot = session.snapshot();
        assert.equal(
          snapshot.traces.some((span) => span.kind === 'interaction' && span.status === 'ok'),
          false,
        );
        assert.equal(JSON.stringify(snapshot).includes(content), false);
      } finally {
        assert.equal((await session.dispose()).ok, true);
      }
    });
  });
}
for (const content of ['Pong! Offline and deterministic.', 'literal [REDACTED]']) {
  test(`unchanged literal response compares exactly: ${content}`, async () => {
    await withBot(content, async (directory) => {
      const session = createSession();
      try {
        await session.selectProject(directory);
        const { runId } = await session.start();
        const result = await session.invoke({
          runId,
          requestId: 'ping-1',
          input: '/ping',
          context,
        });
        assert.equal(result.response.data.content, content);
        assert.equal(result.response.type, 'message');
        assert.equal(result.requestId, 'ping-1');
      } finally {
        assert.equal((await session.dispose()).ok, true);
      }
    });
  });
}
test('legacy display invocation retains redaction projection', async () => {
  await withBot('WRONG BOT RESPONSE', async (directory) => {
    const manager = new RuntimeManager(
      () => {},
      () => {},
    );
    try {
      await manager.selectProject(directory);
      assert.equal((await manager.start()).phase, 'running');
      const result = await manager.invoke('/ping');
      assert.equal(result.ok, true);
      assert.equal(result.response.data.content, 'WRONG BOT [REDACTED]');
    } finally {
      await manager.stop();
    }
  });
});
