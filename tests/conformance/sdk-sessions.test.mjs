import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createSession,
  loadProjectConfiguration,
  renderBotScenarioV2Report,
  runBotScenarioV2,
  saveWorkspace,
} from '../../packages/runtime/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CONTEXT = {
  actorId: '300000000000000001',
  guildId: '100000000000000001',
  channelId: '200000000000000001',
};

async function project(t, adapter, variant = 'correct') {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner SDK 測試 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const example = path.join(
    root,
    'examples',
    adapter === 'discord.js' ? 'discordjs-bot' : 'discordpy-bot',
  );
  const filename =
    adapter === 'discord.js' ? (variant === 'commonjs' ? 'bot.cjs' : 'bot.mjs') : 'bot.py';
  for (const file of [
    filename,
    'discord-simulator.config.json',
    'guild.discord-fixture.json',
    'user.discord-fixture.json',
  ]) {
    await cp(path.join(example, file), path.join(directory, file));
  }
  if (adapter === 'discord.js' && variant !== 'unsupported')
    await symlink(
      path.join(example, 'node_modules'),
      path.join(directory, 'node_modules'),
      'junction',
    );
  if (variant === 'unsupported') {
    if (adapter === 'discord.js') {
      const sdk = path.join(directory, 'node_modules', 'discord.js');
      await mkdir(path.join(sdk, 'src'), { recursive: true });
      await writeFile(
        path.join(sdk, 'package.json'),
        JSON.stringify({ name: 'discord.js', version: '14.0.0', main: 'src/index.js' }),
      );
      await writeFile(
        path.join(sdk, 'src', 'index.js'),
        "throw new Error('Unsupported SDK code must not run');",
      );
    } else {
      const metadata = path.join(directory, 'discord_py-0.0.0.dist-info');
      await mkdir(metadata);
      await writeFile(
        path.join(metadata, 'METADATA'),
        'Metadata-Version: 2.1\nName: discord.py\nVersion: 0.0.0\n',
      );
    }
  }
  const configFile = path.join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const executable =
    adapter === 'discord.js' ? process.execPath : (process.env.DISRUNNER_TEST_PYTHON ?? 'python3');
  config.bot.startCommand = `"${executable}" ${filename}`;
  config.bot.entryPoint = filename;
  await writeFile(configFile, JSON.stringify(config));
  if (
    variant === 'wrong' ||
    variant === 'silent' ||
    variant === 'after-error' ||
    variant === 'handled-error' ||
    variant === 'delayed-followup'
  ) {
    let source = await readFile(path.join(directory, filename), 'utf8');
    if (variant === 'handled-error')
      source = source.replace(
        'await client.login(',
        "client.on('error', (error) => console.error('Handled SDK error:', error.message));\nawait client.login(",
      );
    if (adapter === 'discord.py')
      source = source.replace('import os\n', 'import os\nimport asyncio\n');
    const reply =
      adapter === 'discord.js'
        ? "await interaction.reply('Pong!');"
        : 'await interaction.response.send_message("Pong!")';
    assert.ok(source.includes(reply), 'The negative control removes the actual SDK handler reply');
    const replacement =
      variant === 'after-error' || variant === 'handled-error'
        ? `${reply}\n${adapter === 'discord.js' ? "      await new Promise((resolve) => setTimeout(resolve, 200));\n      throw new Error('after-ack-probe');" : '    await asyncio.sleep(0.2)\n    raise RuntimeError("after-ack-probe")'}`
        : variant === 'delayed-followup'
          ? `${reply}\n${adapter === 'discord.js' ? "      await new Promise((resolve) => setTimeout(resolve, 200));\n      await interaction.followUp('Delayed completion.');" : '    await asyncio.sleep(0.2)\n    await interaction.followup.send("Delayed completion.")'}`
          : variant === 'silent'
            ? adapter === 'discord.js'
              ? 'return;'
              : 'return'
            : reply.replace('Pong!', 'Wrong reply.');
    await writeFile(path.join(directory, filename), source.replace(reply, replacement));
  }
  return directory;
}

test(
  'discord.js: CommonJS Bot uses the same offline SDK transport',
  { timeout: 20_000 },
  async (t) => {
    const directory = await project(t, 'discord.js', 'commonjs');
    const session = createSession();
    try {
      await session.selectProject(directory);
      const started = await session.start({ timeoutMs: 10_000 });
      const result = await session.dispatch({
        runId: started.runId,
        requestId: 'commonjs-ping',
        context: CONTEXT,
        action: { type: 'command', name: 'ping' },
      });
      assert.equal(result.response.data.content, 'Pong!');
    } finally {
      await session.dispose();
    }
  },
);

test(
  'discord.js: startup awaits command registration and bounds a hanging ready handler',
  { timeout: 20_000 },
  async (t) => {
    for (const hangs of [false, true]) {
      const directory = await project(t, 'discord.js');
      const filename = path.join(directory, 'bot.mjs');
      const source = await readFile(filename, 'utf8');
      const ready = "client.once('clientReady', async () => {";
      assert.ok(source.includes(ready));
      await writeFile(
        filename,
        source.replace(
          ready,
          `${ready}\n  ${hangs ? 'await new Promise(() => {});' : 'await new Promise((resolve) => setTimeout(resolve, 250));'}`,
        ),
      );
      const session = createSession();
      let maximumHandlers = 0;
      session.subscribe(({ snapshot }) => {
        maximumHandlers = Math.max(maximumHandlers, snapshot.activeHandlers ?? 0);
      });
      try {
        await session.selectProject(directory);
        if (hangs) {
          await assert.rejects(session.start({ timeoutMs: 1_500 }), { code: 'timeout' });
          assert.ok(maximumHandlers > 0, 'The real ready handler began before its deadline');
          assert.equal(session.snapshot().pid, null);
          assert.equal(session.snapshot().endpoints, null);
        } else {
          const started = await session.start({ timeoutMs: 10_000 });
          assert.equal(started.activeHandlers, 0);
          assert.ok(session.commandsForContext(CONTEXT).some((command) => command.name === 'ping'));
          const result = await session.dispatch({
            runId: started.runId,
            requestId: 'ready-command',
            context: CONTEXT,
            action: { type: 'command', name: 'ping' },
          });
          assert.equal(result.response.data.content, 'Pong!');
        }
      } finally {
        const disposed = await session.dispose();
        assert.equal(disposed.ok, true, JSON.stringify(disposed.errors));
      }
    }
  },
);

test(
  'discord.py: an SDK ready handler exception fails startup and retains its diagnostic',
  { timeout: 15_000 },
  async (t) => {
    const directory = await project(t, 'discord.py');
    const filename = path.join(directory, 'bot.py');
    const source = await readFile(filename, 'utf8');
    const ready = 'async def on_ready():\n';
    assert.ok(source.includes(ready));
    await writeFile(
      filename,
      source.replace(ready, `${ready}    raise RuntimeError("startup-ready-probe")\n`),
    );
    const session = createSession();
    try {
      await session.selectProject(directory);
      await assert.rejects(session.start({ timeoutMs: 10_000 }), { code: 'bot-error' });
      assert.ok(
        session
          .snapshot()
          .diagnostics.some((entry) => entry.message.includes('startup-ready-probe')),
      );
      assert.equal(session.snapshot().pid, null);
      assert.equal(session.snapshot().endpoints, null);
    } finally {
      const disposed = await session.dispose();
      assert.equal(disposed.ok, true, JSON.stringify(disposed.errors));
    }
  },
);

async function waitFor(read, predicate, session, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    let value;
    try {
      value = read();
    } catch (error) {
      throw new Error(`${error.message}: ${JSON.stringify(session.snapshot())}`);
    }
    if (predicate(value)) return value;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error(`Session observation timed out: ${JSON.stringify(session.snapshot())}`);
}

async function timeoutProject(t, adapter, kind, fails) {
  const directory = await project(t, adapter);
  const filename = adapter === 'discord.js' ? 'bot.mjs' : 'bot.py';
  let source = await readFile(path.join(directory, filename), 'utf8');
  if (adapter === 'discord.js') {
    const original = `      collector.on('end', (_collected, reason) => {
        if (reason === 'time') {
          void interaction
            .editReply({ content: 'Collector timed out.', components: [] })
            .catch((error) => client.emit('error', error));
        }
        console.log(\`Collector ended: \${reason}\`);
      });`;
    assert.ok(source.includes(original), 'The control replaces the SDK collector end callback');
    source = source.replace('time: 2_000,', 'time: 150,').replace(
      original,
      `      collector.on('end', async (_collected, reason) => {
        if (reason !== 'time') return;
        await interaction.editReply({ content: 'Collector timed out.', components: [] });
        await new Promise((resolve) => setTimeout(resolve, 250));
        ${fails ? "throw new Error('timeout-callback-probe');" : "await interaction.editReply('Timeout callback completed.');"}
      });`,
    );
  } else {
    source = source.replace('import os\n', 'import os\nimport asyncio\n');
    const completion = fails
      ? 'raise RuntimeError("timeout-callback-probe")'
      : kind === 'modal'
        ? 'await channel.send("Timeout callback completed.")'
        : 'await self.interaction.edit_original_response(content="Timeout callback completed.")';
    if (kind === 'modal') {
      const original = '        super().__init__(custom_id="feedback")';
      assert.ok(source.includes(original), 'The control configures an actual SDK Modal timeout');
      source = source.replace(
        original,
        `        super().__init__(custom_id="feedback", timeout=0.15)

    async def on_timeout(self):
        channel = bot.get_channel(${CONTEXT.channelId})
        await channel.send("Modal timed out.")
        await asyncio.sleep(0.25)
        ${completion}`,
      );
    } else {
      const original = '        print("Collector ended: time", flush=True)';
      assert.ok(source.includes(original), 'The control extends the actual SDK View timeout');
      source = source.replace('super().__init__(timeout=2.0)', 'super().__init__(timeout=0.15)');
      source = source.replace(original, `        await asyncio.sleep(0.25)\n        ${completion}`);
    }
  }
  await writeFile(path.join(directory, filename), source);
  return directory;
}

for (const adapter of ['discord.js', 'discord.py']) {
  test(
    `${adapter}: a delayed handler error with JSON-escaped text remains a valid diagnostic`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await project(t, adapter);
      const filename = path.join(directory, adapter === 'discord.js' ? 'bot.mjs' : 'bot.py');
      let source = await readFile(filename, 'utf8');
      if (adapter === 'discord.py')
        source = source.replace('import os\n', 'import os\nimport asyncio\n');
      const reply =
        adapter === 'discord.js'
          ? "await interaction.reply('Pong!');"
          : 'await interaction.response.send_message("Pong!")';
      assert.ok(source.includes(reply));
      await writeFile(
        filename,
        source.replace(
          reply,
          `${reply}\n${adapter === 'discord.js' ? "      await new Promise((resolve) => setTimeout(resolve, 350));\n      throw new Error('escaped-error-probe:' + String.fromCharCode(0).repeat(800));" : '    await asyncio.sleep(0.35)\n    raise RuntimeError("escaped-error-probe:" + chr(0) * 800)'}`,
        ),
      );
      const result = await runBotScenarioV2(
        {
          version: 2,
          name: 'Escaped diagnostic frame',
          execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
          context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
          steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }],
          assertions: [{ type: 'message-content', interaction: '${ping.id}', equals: 'Pong!' }],
          policy: { failOnSeverity: 'none' },
        },
        { baseDirectory: directory },
      );
      assert.equal(
        result.status,
        adapter === 'discord.js' ? 'runner-error' : 'failed',
        JSON.stringify(result),
      );
      assert.equal(result.exitCode, adapter === 'discord.js' ? 3 : 1);
      assert.ok(
        result.observations.some(
          (observation) => observation.result?.response?.data?.content === 'Pong!',
        ),
      );
      assert.deepEqual(result.snapshot.diagnostics, [
        { code: 'bot-error', message: 'The error message exceeded the diagnostic limit.' },
      ]);
      assert.equal(result.snapshot.activeHandlers, 0);
      assert.equal(result.metadata.evidenceComplete, true);
    },
  );

  test(
    `${adapter}: sensitive values matching reserved controls cannot hide pending SDK handlers`,
    { timeout: 30_000 },
    async (t) => {
      for (const secret of ['DISRUNNER_HANDLER', 'start']) {
        for (const fails of [false, true]) {
          const directory = await project(t, adapter, fails ? 'after-error' : 'delayed-followup');
          const configPath = path.join(directory, 'discord-simulator.config.json');
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          config.environment = { LOCAL_ACCESS_KEY: secret };
          await writeFile(configPath, JSON.stringify(config));
          const filename = path.join(directory, adapter === 'discord.js' ? 'bot.mjs' : 'bot.py');
          const source = await readFile(filename, 'utf8');
          const delay =
            adapter === 'discord.js' ? 'setTimeout(resolve, 200)' : 'asyncio.sleep(0.2)';
          assert.ok(source.includes(delay));
          await writeFile(
            filename,
            source.replace(
              delay,
              adapter === 'discord.js' ? 'setTimeout(resolve, 350)' : 'asyncio.sleep(0.35)',
            ),
          );
          const humanOutput = new Set();
          let observedReplyWithActiveHandler = false;
          const result = await runBotScenarioV2(
            {
              version: 2,
              name: 'Sensitive value matches handler protocol',
              execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
              context: {
                actor: CONTEXT.actorId,
                guild: CONTEXT.guildId,
                channel: CONTEXT.channelId,
              },
              steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }],
              assertions: [
                { type: 'message-content', interaction: '${ping.id}', equals: 'Pong!' },
                ...(fails
                  ? []
                  : [{ type: 'message-count', channel: CONTEXT.channelId, equals: 2 }]),
              ],
              policy: { failOnSeverity: 'none' },
            },
            {
              baseDirectory: directory,
              onSnapshot(snapshot) {
                for (const entry of snapshot.output) humanOutput.add(entry.text);
                if (
                  snapshot.activeHandlers > 0 &&
                  snapshot.coreState?.resources.some(
                    (resource) =>
                      resource.resourceType === 'message' && resource.content === 'Pong!',
                  )
                )
                  observedReplyWithActiveHandler = true;
              },
            },
          );
          assert.equal(observedReplyWithActiveHandler, true, JSON.stringify(result));
          assert.equal(result.snapshot.activeHandlers, 0);
          if (fails) {
            assert.equal(result.status, adapter === 'discord.js' ? 'runner-error' : 'failed');
            assert.equal(result.exitCode, adapter === 'discord.js' ? 3 : 1);
            assert.ok(
              result.snapshot.diagnostics.some(
                (entry) => entry.code === 'bot-error' && entry.message.includes('after-ack-probe'),
              ),
              JSON.stringify(result),
            );
          } else {
            assert.equal(result.status, 'passed', JSON.stringify(result));
            assert.equal(result.exitCode, 0);
            assert.ok(
              result.snapshot.coreState.resources.some(
                (resource) => resource.content === 'Delayed completion.',
              ),
            );
          }
          for (const entry of result.snapshot.output) humanOutput.add(entry.text);
          for (const text of humanOutput) {
            assert.equal(text.includes(secret), false, 'Known sensitive values remain redacted');
            assert.doesNotMatch(
              text,
              /^DISRUNNER_(?:HANDLER|ADAPTER_READY|DIAGNOSTIC|ADAPTER_ERROR)(?:\s|$)/mu,
            );
            assert.doesNotMatch(text, /"id"\s*:\s*"(?:js|py)-\d+-\d+"/u);
          }
        }
      }
    },
  );

  test(
    `${adapter}: long sensitive environment values are redacted before diagnostic clipping`,
    { timeout: 20_000 },
    async (t) => {
      const segment = 'r8Qp4G5nTm6Yz2VkL7Sa1Dc0Fh9Bj3WuE5Xv6Rs8NPk4Q2Lc"\\opaque-';
      for (const separator of ['', '\n', '\u0085']) {
        const secret = Array.from({ length: 90 }, () => segment).join(separator);
        assert.ok(secret.length > 5_000);
        const directory = await project(t, adapter);
        const configPath = path.join(directory, 'discord-simulator.config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.environment = { LOCAL_API_KEY: secret, LOCAL_ACCESS_KEY: secret };
        await writeFile(configPath, JSON.stringify(config));
        const filename = path.join(directory, adapter === 'discord.js' ? 'bot.mjs' : 'bot.py');
        const source = await readFile(filename, 'utf8');
        const reply =
          adapter === 'discord.js'
            ? "await interaction.reply('Pong!');"
            : 'await interaction.response.edit_message(content="Button clicked.", view=None)';
        assert.ok(source.includes(reply));
        await writeFile(
          filename,
          source.replace(
            reply,
            `${reply}\n${adapter === 'discord.js' ? '      throw new Error(process.env.LOCAL_ACCESS_KEY);' : '        raise RuntimeError(os.environ["LOCAL_ACCESS_KEY"])'}`,
          ),
        );
        const exposures = [];
        const result = await runBotScenarioV2(
          {
            version: 2,
            name: 'Long environment diagnostic',
            execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
            context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
            steps:
              adapter === 'discord.js'
                ? [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }]
                : [
                    { action: 'invoke-command', command: 'controls', saveAs: 'controls' },
                    {
                      action: 'invoke-component',
                      customId: 'confirm',
                      componentType: 2,
                      message: '${controls.id}',
                    },
                  ],
            assertions: [
              {
                type: 'message-content',
                channel: CONTEXT.channelId,
                equals: adapter === 'discord.js' ? 'Pong!' : 'Button clicked.',
              },
            ],
            policy: { failOnSeverity: 'none' },
          },
          {
            baseDirectory: directory,
            onSnapshot: (snapshot) => exposures.push(JSON.stringify(snapshot)),
          },
        );
        assert.notEqual(result.exitCode, 0, 'The actual SDK callback error must still fail');
        assert.ok(result.snapshot.diagnostics.some((entry) => entry.code === 'bot-error'));
        assert.ok(
          result.snapshot.diagnostics.some((entry) => entry.message.includes('[REDACTED]')),
          'Known sensitive values are removed before diagnostic line selection',
        );
        exposures.push(
          ...result.snapshot.diagnostics.map((entry) => entry.message),
          ...result.snapshot.output.map((entry) => entry.text),
          JSON.stringify(result),
          ...['json', 'junit', 'html', 'sarif'].map((format) =>
            renderBotScenarioV2Report(result, format),
          ),
        );
        const prefix = segment.slice(0, 55);
        const forbidden = [prefix, JSON.stringify(prefix).slice(1, -1)];
        for (const exposure of exposures)
          for (const value of forbidden)
            assert.equal(exposure.includes(value), false, 'A sensitive value prefix was retained');
      }
    },
  );

  test(
    `${adapter}: an unsupported SDK is classified as invalid before executing Bot code`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await project(t, adapter, 'unsupported');
      const result = await runBotScenarioV2(
        {
          version: 2,
          name: 'Unsupported SDK',
          execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
          context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
          steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping' }],
          assertions: [{ type: 'message-content', interaction: '${ping.id}', equals: 'Pong!' }],
        },
        { baseDirectory: directory },
      );
      assert.equal(result.status, 'invalid', JSON.stringify(result));
      assert.equal(result.exitCode, 2);
      assert.ok(
        result.issues.some(
          (issue) => issue.code === 'invalid' && /Unsupported discord\./.test(issue.message),
        ),
      );
      assert.equal(result.observations.length, 0);
    },
  );

  test(
    `${adapter}: saved DM fixture routes a genuine prefix reply and hides it from other actors`,
    { timeout: 20_000 },
    async (t) => {
      const directory = await project(t, adapter);
      const config = await loadProjectConfiguration(directory);
      const dmId = '200000000000000002';
      const observerId = '300000000000000002';
      await saveWorkspace(
        directory,
        {
          version: 1,
          resources: [
            ...config.resources,
            {
              resourceType: 'user',
              id: observerId,
              username: 'observer',
              discriminator: '0',
              avatar: null,
              bot: false,
            },
            {
              resourceType: 'channel',
              id: dmId,
              type: 1,
              recipients: [
                {
                  id: CONTEXT.actorId,
                  username: 'developer',
                  discriminator: '0',
                  avatar: null,
                  bot: false,
                },
              ],
            },
          ],
          scenarios: [],
          options: { seed: 42042, mode: 'strict' },
        },
        { expectedHash: null },
      );
      const session = createSession();
      try {
        await session.selectProject(directory);
        const started = await session.start({ timeoutMs: 15_000 });
        const context = { actorId: CONTEXT.actorId, channelId: dmId };
        const sent = await session.dispatch({
          runId: started.runId,
          requestId: 'dm-prefix',
          context,
          action: { type: 'message', content: '!ping' },
        });
        assert.equal(sent.ok, true);
        const replies = await waitFor(
          () =>
            session
              .snapshotForActor(CONTEXT.actorId)
              .coreState.resources.filter(
                (resource) =>
                  resource.resourceType === 'message' &&
                  resource.channel_id === dmId &&
                  resource.author?.bot,
              ),
          (messages) => messages.length === 1,
          session,
        );
        assert.equal(replies[0].content, 'Pong!');
        assert.equal(replies[0].guild_id, undefined);
        assert.equal(
          session
            .snapshot()
            .coreState.resources.some(
              (resource) => resource.channel_id === dmId || resource.id === dmId,
            ),
          false,
        );
        assert.equal(
          session
            .snapshotForActor(observerId)
            .coreState.resources.some(
              (resource) => resource.channel_id === dmId || resource.id === dmId,
            ),
          false,
        );
        const stopped = await session.stop();
        assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      } finally {
        await session.dispose();
      }
    },
  );

  test(
    `${adapter}: shared Session routes prefix, slash and components in a saved project`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await project(t, adapter);
      const session = createSession();
      try {
        await session.selectProject(directory);
        const started = await session.start({ timeoutMs: 15_000 });
        assert.equal(started.phase, 'running');
        await waitFor(
          () => session.snapshot().commands,
          (commands) => commands?.some((command) => command.name === 'controls'),
          session,
        );
        let sequence = 0;
        const dispatch = async (action) => {
          try {
            return await session.dispatch(
              { runId: started.runId, requestId: `sdk-${++sequence}`, context: CONTEXT, action },
              { timeoutMs: 3_000 },
            );
          } catch (error) {
            throw new Error(
              `${error.message}: ${session
                .snapshot()
                .output.map((entry) => entry.text)
                .join('')}`,
            );
          }
        };
        const ping = await dispatch({ type: 'command', name: 'ping' });
        assert.equal(ping.ok, true);
        assert.equal(ping.response.data.content, 'Pong!');
        await writeFile(path.join(directory, 'incoming.txt'), 'Incoming attachment ✓');
        const inputAttachment = await session.importAttachment('incoming.txt', CONTEXT);
        const read = await dispatch({
          type: 'command',
          name: 'read-file',
          options: [{ type: 11, name: 'file', value: inputAttachment.id }],
        });
        assert.equal(read.response.data.content, 'Read: Incoming attachment ✓');
        await dispatch({ type: 'message', content: '!ping' });
        await waitFor(
          () =>
            session
              .snapshot()
              .coreState.resources.filter(
                (resource) =>
                  resource.resourceType === 'message' &&
                  resource.author?.bot &&
                  resource.content === 'Pong!',
              ),
          (messages) => messages.length === 2,
          session,
        );
        const controls = await dispatch({ type: 'command', name: 'controls' });
        assert.equal(controls.ok, true);
        const source = await waitFor(
          () =>
            session
              .snapshot()
              .coreState.resources.find(
                (resource) => resource.interaction_id === controls.interactionId,
              ),
          (message) => message?.components?.length === 2,
          session,
        );
        const selected = await dispatch({
          type: 'component',
          customId: 'choice',
          componentType: 3,
          messageId: source.id,
          values: ['banana'],
        });
        assert.equal(selected.response.data.content, 'Selected: banana');
        const clicked = await dispatch({
          type: 'component',
          customId: 'confirm',
          componentType: 2,
          messageId: source.id,
        });
        assert.equal(clicked.response.type, 'update');
        assert.equal(
          session.snapshot().coreState.resources.find((resource) => resource.id === source.id)
            .content,
          'Button clicked.',
        );
        const opened = await dispatch({ type: 'command', name: 'modal' });
        assert.equal(opened.response.type, 'modal');
        const submitted = await dispatch({
          type: 'modal-submit',
          customId: 'feedback',
          fields: { answer: 'Saved project' },
        });
        assert.equal(submitted.response.data.content, 'Submitted: Saved project');
        const stopped = await session.stop();
        assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
        assert.equal(stopped.snapshot.pid, null);
        assert.equal(stopped.snapshot.endpoints, null);
      } finally {
        await session.dispose();
      }
    },
  );

  test(
    `${adapter}: collector timeout callbacks finish before verdicts and surface delayed errors`,
    { timeout: 20_000 },
    async (t) => {
      for (const fails of [false, true]) {
        const directory = await timeoutProject(t, adapter, 'view', fails);
        const result = await runBotScenarioV2(
          {
            version: 2,
            name: 'Collector timeout callback',
            execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
            context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
            steps: [
              { action: 'invoke-command', command: 'collector', saveAs: 'collector' },
              { action: 'await-message', content: 'Collector timed out.', timeoutMs: 3_000 },
            ],
            assertions: [
              {
                type: 'message-content',
                interaction: '${collector.id}',
                equals: fails ? 'Collector timed out.' : 'Timeout callback completed.',
              },
            ],
            policy: { failOnSeverity: 'none' },
          },
          { baseDirectory: directory },
        );
        const fatal = fails && adapter === 'discord.js';
        assert.equal(
          result.status,
          fails ? (fatal ? 'runner-error' : 'failed') : 'passed',
          JSON.stringify(result),
        );
        assert.equal(result.exitCode, fails ? (fatal ? 3 : 1) : 0);
        assert.equal(result.observations[1].error, null, 'The timeout edit was observed first');
        assert.equal(result.snapshot.activeHandlers, 0);
        if (fails)
          assert.ok(
            result.snapshot.diagnostics.some((entry) =>
              entry.message.includes('timeout-callback-probe'),
            ),
            JSON.stringify(result),
          );
        else assert.deepEqual(result.cleanupErrors, []);
      }
    },
  );

  test(
    `${adapter}: SDK retries one HTTP 429 and one HTTP 503 before sending a followup`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await project(t, adapter);
      const session = createSession();
      try {
        await session.selectProject(directory);
        const started = await session.start({ timeoutMs: 15_000 });
        for (const status of [429, 503]) {
          const planId = `sdk-retry-${status}`;
          session.setFaults([
            {
              id: planId,
              kind: 'http-status',
              count: 1,
              method: 'POST',
              route: '/webhooks/*/*',
              status,
            },
          ]);
          const result = await session.dispatch(
            {
              runId: started.runId,
              requestId: planId,
              context: CONTEXT,
              action: { type: 'command', name: 'followup' },
            },
            { timeoutMs: 3_000 },
          );
          assert.equal(result.response.data.content, 'First reply.');
          const messages = await waitFor(
            () =>
              session
                .snapshot()
                .coreState.resources.filter(
                  (resource) =>
                    resource.resourceType === 'message' &&
                    resource.interaction_id === result.interactionId &&
                    resource.content === 'Followup reply.',
                ),
            (items) => items.length === 1,
            session,
            10_000,
          );
          assert.equal(messages.length, 1);
          const evidence = session.snapshot().faults;
          assert.equal(evidence.complete, true);
          assert.equal(
            evidence.events.filter((event) => event.planId === planId && event.phase === 'selected')
              .length,
            1,
          );
          assert.equal(
            evidence.events.filter((event) => event.planId === planId && event.phase === 'ready')
              .length,
            1,
          );
        }
        session.setFaults([]);
        const stopped = await session.stop();
        assert.equal(stopped.ok, true, JSON.stringify(stopped.errors));
      } finally {
        await session.dispose();
      }
    },
  );

  test(
    `${adapter}: real Bot scenarios await handlers and reject wrong replies, missing replies and errors`,
    { timeout: 45_000 },
    async (t) => {
      const definition = {
        version: 2,
        name: 'SDK ping regression',
        execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 15_000 },
        context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
        steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 2_000 }],
        assertions: [
          { type: 'message-content', interaction: '${ping.id}', equals: 'Pong!' },
          { type: 'no-unexpected-error' },
        ],
      };
      for (const [variant, status] of [
        ['correct', 'passed'],
        ['wrong', 'failed'],
        ['silent', 'failed'],
        ['delayed-followup', 'passed'],
        ['after-error', 'failed'],
        ...(adapter === 'discord.js' ? [['handled-error', 'failed']] : []),
      ]) {
        const directory = await project(t, adapter, variant);
        const input =
          variant === 'delayed-followup'
            ? {
                ...definition,
                assertions: [
                  ...definition.assertions,
                  { type: 'message-count', channel: CONTEXT.channelId, equals: 2 },
                ],
              }
            : definition;
        const result = await runBotScenarioV2(input, { baseDirectory: directory });
        const fatal = variant === 'after-error' && adapter === 'discord.js';
        assert.equal(
          result.status,
          fatal ? 'runner-error' : status,
          `${variant}: ${JSON.stringify(result)}`,
        );
        assert.equal(result.exitCode, fatal ? 3 : status === 'passed' ? 0 : 1);
        if (fatal) {
          assert.ok(result.cleanupErrors.some((issue) => issue.code === 'child-exited'));
          assert.ok(result.cleanupErrors.every((issue) => issue.code === 'child-exited'));
        } else assert.equal(result.cleanupErrors.length, 0);
        if (variant === 'after-error' || variant === 'handled-error') {
          assert.ok(
            result.observations.some(
              (observation) => observation.result?.response?.data?.content === 'Pong!',
            ),
          );
          assert.ok(
            result.snapshot.diagnostics.some(
              (entry) => entry.code === 'bot-error' && entry.message.includes('after-ack-probe'),
            ),
            JSON.stringify(result),
          );
        }
        assert.equal(result.snapshot.activeHandlers, 0);
        if (variant === 'delayed-followup')
          assert.ok(
            result.snapshot.coreState.resources.some(
              (resource) => resource.content === 'Delayed completion.',
            ),
          );
      }
    },
  );
}

test(
  'discord.py: Modal timeout callbacks finish before verdicts and surface delayed errors',
  { timeout: 20_000 },
  async (t) => {
    for (const fails of [false, true]) {
      const directory = await timeoutProject(t, 'discord.py', 'modal', fails);
      const result = await runBotScenarioV2(
        {
          version: 2,
          name: 'Modal timeout callback',
          execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
          context: { actor: CONTEXT.actorId, guild: CONTEXT.guildId, channel: CONTEXT.channelId },
          steps: [
            { action: 'invoke-command', command: 'modal', saveAs: 'modal' },
            { action: 'await-message', content: 'Modal timed out.', timeoutMs: 3_000 },
          ],
          assertions: [
            {
              type: 'message-content',
              channel: CONTEXT.channelId,
              equals: fails ? 'Modal timed out.' : 'Timeout callback completed.',
            },
          ],
          policy: { failOnSeverity: 'none' },
        },
        { baseDirectory: directory },
      );
      assert.equal(result.status, fails ? 'failed' : 'passed', JSON.stringify(result));
      assert.equal(result.exitCode, fails ? 1 : 0);
      assert.equal(result.observations[1].error, null, 'The timeout message was observed first');
      assert.equal(result.snapshot.activeHandlers, 0);
      assert.deepEqual(result.cleanupErrors, []);
      if (fails)
        assert.ok(
          result.snapshot.diagnostics.some((entry) =>
            entry.message.includes('timeout-callback-probe'),
          ),
          JSON.stringify(result),
        );
    }
  },
);
