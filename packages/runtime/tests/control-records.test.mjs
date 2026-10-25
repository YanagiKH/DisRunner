import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSession, runBotScenarioV2 } from '../dist/index.js';

const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };

async function project(t, mode = 'live') {
  const directory = await mkdtemp(join(tmpdir(), 'DisRunner control records '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(example, directory, { recursive: true });
  const configFile = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.bot.startCommand = `"${process.execPath}" src/server.mjs`;
  await writeFile(configFile, JSON.stringify(config));
  const serverFile = join(directory, 'src/server.mjs');
  const original = await readFile(serverFile, 'utf8');
  const anchor =
    mode === 'live'
      ? '  const reply = interactionReply(interaction);'
      : '    const shutdown = () => {';
  assert.equal(original.split(anchor).length, 2);
  const start = 'DISRUNNER_HANDLER {"id":"raw-9999","phase":"start"}\n';
  const end = 'DISRUNNER_HANDLER {"id":"raw-9999","phase":"end"}\n';
  const modified =
    mode === 'live'
      ? original.replace(
          anchor,
          `${anchor}\n  process.stdout.write('DISRUNNER_HANDLER {"id":"raw-1","phase":"end"}\\n');`,
        )
      : `import { writeSync } from 'node:fs';\n${original.replace(
          anchor,
          `${anchor}\n      writeSync(1, ${JSON.stringify(start)});\n${mode === 'shutdown-complete' ? `      setTimeout(() => writeSync(1, ${JSON.stringify(end)}), 50);\n` : ''}`,
        )}`;
  await writeFile(serverFile, modified);
  return { directory, serverFile, original };
}

test(
  'a damaged live Bot control record blocks further actions and resets only for a fresh run',
  { timeout: 20_000 },
  async (t) => {
    const { directory, serverFile, original } = await project(t);
    const session = createSession();
    try {
      await session.selectProject(directory);
      const started = await session.start();
      assert.equal(started.evidenceComplete, true);
      // The HTTP acknowledgement and the independent process pipe may arrive in either order.
      await session
        .invoke({ runId: started.runId, requestId: 'first', input: '/ping', context })
        .catch((error) => assert.equal(error.code, 'transport'));
      const deadline = Date.now() + 2000;
      while (session.snapshot().evidenceComplete && Date.now() < deadline) await delay(10);
      assert.equal(session.snapshot().evidenceComplete, false);
      await assert.rejects(
        session.invoke({ runId: started.runId, requestId: 'second', input: '/ping', context }),
        { code: 'transport', message: 'Invalid or incomplete adapter control record.' },
      );
      assert.equal(
        session.snapshot().output.some((entry) => /DISRUNNER_/u.test(entry.text)),
        false,
      );
      assert.equal((await session.stop()).ok, true);
      assert.equal(session.snapshot().evidenceComplete, false);
      await writeFile(serverFile, original);
      await session.selectProject(directory);
      const restarted = await session.start();
      assert.notEqual(restarted.runId, started.runId);
      assert.equal(restarted.evidenceComplete, true);
      const result = await session.invoke({
        runId: restarted.runId,
        requestId: 'fresh',
        input: '/ping',
        context,
      });
      assert.equal(result.response.data.content, 'Pong! Offline and deterministic.');
    } finally {
      assert.equal((await session.dispose()).ok, true);
    }
  },
);

for (const finishes of [false, true]) {
  test(
    `Scenario v2 ${finishes ? 'accepts completed' : 'rejects unfinished'} Bot work started during shutdown`,
    { timeout: 15_000 },
    async (t) => {
      const { directory } = await project(t, finishes ? 'shutdown-complete' : 'shutdown-open');
      const session = createSession();
      const result = await runBotScenarioV2(
        {
          version: 2,
          name: 'Shutdown completion',
          execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
          context: { actor: '3000', guild: '1000', channel: '2000' },
          steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 2000 }],
          assertions: [
            {
              type: 'message-content',
              interaction: '${ping.id}',
              equals: 'Pong! Offline and deterministic.',
            },
            { type: 'no-unexpected-error' },
          ],
        },
        { baseDirectory: directory, createSession: () => session },
      );
      assert.equal(result.status, finishes ? 'passed' : 'failed');
      assert.equal(result.exitCode, finishes ? 0 : 1);
      assert.equal(result.metadata.evidenceComplete, finishes);
      assert.deepEqual(result.cleanupErrors, []);
      assert.equal(session.snapshot().activeHandlers, finishes ? 0 : 1);
      assert.equal(session.snapshot().evidenceComplete, finishes);
      assert.equal(result.snapshot.activeHandlers, finishes ? 0 : 1);
      assert.equal(result.snapshot.evidenceComplete, finishes);
      if (!finishes)
        assert.match(
          result.assertions.find((assertion) => assertion.type === 'evidence-complete').message,
          /handlers did not finish/u,
        );
      assert.ok(
        result.snapshot.coreState.resources.some(
          (resource) =>
            resource.resourceType === 'message' &&
            resource.content === 'Pong! Offline and deterministic.',
        ),
      );
      assert.equal(
        result.snapshot.output.some((entry) => /DISRUNNER_/u.test(entry.text)),
        false,
      );
    },
  );
}

test(
  'a matching real Bot reply cannot pass Scenario v2 after process control evidence is damaged',
  { timeout: 15_000 },
  async (t) => {
    const { directory } = await project(t);
    const result = await runBotScenarioV2(
      {
        version: 2,
        name: 'Control integrity',
        execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
        context: { actor: '3000', guild: '1000', channel: '2000' },
        steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 2000 }],
        assertions: [
          {
            type: 'message-content',
            interaction: '${ping.id}',
            equals: 'Pong! Offline and deterministic.',
          },
          { type: 'no-unexpected-error' },
        ],
      },
      { baseDirectory: directory },
    );
    assert.notEqual(result.status, 'passed');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.metadata.evidenceComplete, false);
    assert.deepEqual(result.cleanupErrors, []);
    assert.equal(
      result.snapshot.output.some((entry) => /DISRUNNER_/u.test(entry.text)),
      false,
    );
  },
);
