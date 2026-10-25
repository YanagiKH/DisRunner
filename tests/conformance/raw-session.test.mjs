import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createSession,
  loadProjectConfiguration,
  runBotScenarioV2,
  saveWorkspace,
} from '../../packages/runtime/dist/index.js';

const example = fileURLToPath(new URL('../../examples/raw-webhook-bot/', import.meta.url));
const context = { actorId: '3000', guildId: '1000', channelId: '2000' };

async function project(t, variant = 'correct') {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner raw 測試 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(example, directory, { recursive: true });
  const configFile = path.join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.bot.startCommand = `"${process.execPath}" src/server.mjs`;
  await writeFile(configFile, JSON.stringify(config));
  if (variant === 'wrong') {
    const commandFile = path.join(directory, 'src/commands.mjs');
    const source = await readFile(commandFile, 'utf8');
    assert.ok(source.includes("message('Pong! Offline and deterministic.')"));
    await writeFile(
      commandFile,
      source.replace("message('Pong! Offline and deterministic.')", "message('Wrong reply.')"),
    );
  } else if (variant === 'unknown-wrapper') {
    const serverFile = path.join(directory, 'src/server.mjs');
    const source = await readFile(serverFile, 'utf8');
    const hook = 'send(200, reply.callback);';
    assert.equal(source.split(hook).length, 2);
    await writeFile(
      serverFile,
      source.replace(hook, 'send(200, { ...reply.callback, unexpected: true });'),
    );
  } else if (variant === 'silent') {
    const serverFile = path.join(directory, 'src/server.mjs');
    const source = await readFile(serverFile, 'utf8');
    assert.ok(source.includes('const reply = interactionReply(interaction);'));
    await writeFile(
      serverFile,
      source.replace(
        'const reply = interactionReply(interaction);',
        "if (interaction.data?.name === 'ping') return;\n  const reply = interactionReply(interaction);",
      ),
    );
  }
  return directory;
}

async function waitFor(session, read, predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const observed = read();
    if (predicate(observed)) return observed;
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail(`Raw Session observation timed out: ${JSON.stringify(session.snapshot())}`);
}

test(
  'raw webhook: v2 rejects unknown signed callback fields before acknowledgement',
  { timeout: 15000 },
  async (t) => {
    const directory = await project(t, 'unknown-wrapper');
    const session = createSession();
    try {
      await session.selectProject(directory);
      const started = await session.start();
      const before = session.snapshot().coreState.stateRevision;
      await assert.rejects(
        session.invoke({
          runId: started.runId,
          requestId: 'invalid-wrapper',
          input: '/ping',
          context,
        }),
        /Invalid interaction message payload/,
      );
      assert.equal(session.snapshot().coreState.stateRevision, before);
      assert.equal(
        session
          .snapshot()
          .coreState.resources.some((resource) => resource.resourceType === 'message'),
        false,
      );
      assert.equal(session.snapshot().interactions[0].status, 'pending');
    } finally {
      assert.equal((await session.dispose()).ok, true);
    }
  },
);

test(
  'raw webhook: text invocation uses the v2 authority for attachments and private callbacks',
  { timeout: 20_000 },
  async (t) => {
    const directory = await project(t);
    const session = createSession();
    try {
      await session.selectProject(directory);
      const started = await session.start();
      let sequence = 0;
      const invoke = (input) =>
        session.invoke({
          runId: started.runId,
          requestId: `text-${++sequence}`,
          input,
          context,
        });
      const reply = await invoke('/attachment');
      assert.equal(reply.ok, true);
      assert.equal(reply.response.type, 'defer');
      const message = await waitFor(
        session,
        () =>
          session
            .snapshotForActor(context.actorId)
            .coreState.resources.find(
              (resource) =>
                resource.resourceType === 'message' &&
                resource.attachments?.[0]?.filename === 'note.txt',
            ),
        Boolean,
      );
      const attachment = await session.readAttachment(message.attachments[0].id, context);
      assert.equal(new TextDecoder().decode(attachment.data), 'Offline attachment ✓\n');
      await waitFor(
        session,
        () => session.snapshot().activeHandlers,
        (active) => active === 0,
      );
      assert.deepEqual(session.snapshot().diagnostics, []);
      const secret = await invoke('/secret');
      assert.equal(secret.response.data.flags, 64);
      assert.equal(
        session
          .snapshotForActor(context.actorId)
          .coreState.resources.some(
            (resource) =>
              resource.resourceType === 'message' && resource.visibility === 'ephemeral',
          ),
        true,
      );
      assert.equal(
        session
          .snapshot()
          .coreState.resources.some(
            (resource) =>
              resource.resourceType === 'message' && resource.visibility === 'ephemeral',
          ),
        false,
      );
      assert.equal((await invoke('/modal')).response.type, 'modal');
    } finally {
      assert.equal((await session.dispose()).ok, true);
    }
  },
);

test(
  'raw webhook: registered commands, controls, private responses and REST completion share real Session state',
  { timeout: 30_000 },
  async (t) => {
    const directory = await project(t);
    const configuration = await loadProjectConfiguration(directory);
    await saveWorkspace(
      directory,
      {
        version: 1,
        resources: [
          ...configuration.resources,
          { resourceType: 'user', id: '3001', username: 'Observer', bot: false },
        ],
        scenarios: [],
        options: { seed: 42042, mode: 'strict' },
      },
      { expectedHash: null },
    );
    const session = createSession();
    try {
      await session.selectProject(directory);
      const started = await session.start({ timeoutMs: 10_000 });
      assert.equal(started.phase, 'running');
      const commands = session.snapshot().commands;
      for (const name of [
        'ping',
        'secret',
        'echo',
        'defer',
        'followup',
        'controls',
        'modal',
        'search',
        'attachment',
      ])
        assert.ok(
          commands.some((command) => command.name === name),
          `${name} must come from actual local REST registration`,
        );
      let sequence = 0;
      const dispatch = (action) =>
        session.dispatch(
          { runId: started.runId, requestId: `raw-${++sequence}`, context, action },
          { timeoutMs: 3_000 },
        );
      const messages = (actorId = context.actorId) =>
        session
          .snapshotForActor(actorId)
          .coreState.resources.filter((resource) => resource.resourceType === 'message');
      const ping = await dispatch({ type: 'command', name: 'ping' });
      assert.equal(ping.response.data.content, 'Pong! Offline and deterministic.');
      const echo = await dispatch({
        type: 'command',
        name: 'echo',
        options: [{ name: 'text', type: 3, value: 'Hello 測試' }],
      });
      assert.equal(echo.response.data.content, 'Hello 測試');
      const sum = await dispatch({
        type: 'command',
        name: 'tools',
        options: [
          {
            name: 'math',
            type: 2,
            options: [
              {
                name: 'add',
                type: 1,
                options: [
                  { name: 'left', type: 4, value: 7 },
                  { name: 'right', type: 4, value: 5 },
                ],
              },
            ],
          },
        ],
      });
      assert.equal(sum.response.data.content, 'Sum: 12');
      const privateReply = await dispatch({ type: 'command', name: 'secret' });
      assert.equal(privateReply.response.data.flags, 64);
      assert.ok(
        messages().some(
          (message) =>
            message.interaction_id === privateReply.interactionId &&
            message.content === 'Only you can see this.',
        ),
      );
      assert.equal(
        messages('3001').some((message) => message.interaction_id === privateReply.interactionId),
        false,
      );
      const controls = await dispatch({ type: 'command', name: 'controls' });
      const source = messages().find(
        (message) => message.interaction_id === controls.interactionId,
      );
      assert.equal(source.components.length, 2);
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
        messages().find((message) => message.id === source.id).content,
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
      const suggestions = await dispatch({
        type: 'autocomplete',
        name: 'search',
        options: [{ name: 'query', type: 3, value: 'a', focused: true }],
      });
      assert.equal(suggestions.response.type, 'autocomplete');
      assert.deepEqual(suggestions.response.data.choices, [{ name: 'apple', value: 'apple' }]);
      session.setFaults([
        {
          id: 'raw-deferred-retry',
          kind: 'http-status',
          count: 1,
          method: 'PATCH',
          route: '/webhooks/:application/:token/messages/@original',
          status: 429,
        },
      ]);
      const deferred = await dispatch({ type: 'command', name: 'defer' });
      assert.equal(deferred.response.type, 'defer');
      const completed = await waitFor(
        session,
        () => messages().find((message) => message.interaction_id === deferred.interactionId),
        (message) => message?.content === 'Deferred reply complete.',
      );
      assert.equal(completed.flags & 64, 64);
      assert.equal(
        messages('3001').some((message) => message.id === completed.id),
        false,
      );
      assert.ok(
        session
          .snapshot()
          .faults.events.some(
            (event) => event.planId === 'raw-deferred-retry' && event.phase === 'ready',
          ),
      );
      session.setFaults([]);
      const followup = await dispatch({ type: 'command', name: 'followup' });
      assert.equal(followup.response.data.content, 'First reply.');
      await waitFor(
        session,
        () => messages().filter((message) => message.interaction_id === followup.interactionId),
        (items) => items.some((message) => message.content === 'Followup reply.'),
      );
      const attached = await dispatch({ type: 'command', name: 'attachment' });
      const attachmentMessage = await waitFor(
        session,
        () => messages().find((message) => message.interaction_id === attached.interactionId),
        (message) => message?.content === 'Local attachment.' && message.attachments?.length === 1,
      );
      assert.equal(attachmentMessage.attachments[0].filename, 'note.txt');
      assert.equal(
        attachmentMessage.attachments[0].size,
        Buffer.byteLength('Offline attachment ✓\n'),
      );
      await waitFor(
        session,
        () => session.snapshot().output,
        (entries) =>
          entries.some((entry) => entry.text.includes('Local attachment verified (23 bytes).')),
      );
      const inspectedUser = await dispatch({
        type: 'command',
        commandType: 2,
        name: 'Inspect user',
        targetId: context.actorId,
      });
      assert.equal(inspectedUser.response.data.content, 'User: DevUser');
      const inspectedMessage = await dispatch({
        type: 'command',
        commandType: 3,
        name: 'Inspect message',
        targetId: source.id,
      });
      assert.equal(inspectedMessage.response.data.content, 'Message: Button clicked.');
      assert.equal(
        session.snapshot().output.filter((entry) => entry.stream === 'stderr').length,
        0,
      );
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
  'raw webhook: real Bot scenarios reject modified and missing handler replies',
  { timeout: 30_000 },
  async (t) => {
    const scenario = {
      version: 2,
      name: 'Raw webhook ping regression',
      execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10_000 },
      context: { actor: context.actorId, guild: context.guildId, channel: context.channelId },
      steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 1_000 }],
      assertions: [
        {
          type: 'message-content',
          interaction: '${ping.id}',
          equals: 'Pong! Offline and deterministic.',
        },
        { type: 'no-unexpected-error' },
      ],
    };
    for (const [variant, expected] of [
      ['correct', 'passed'],
      ['wrong', 'failed'],
      ['silent', 'failed'],
    ]) {
      const directory = await project(t, variant);
      const result = await runBotScenarioV2(scenario, { baseDirectory: directory });
      assert.equal(result.status, expected, `${variant}: ${JSON.stringify(result)}`);
      assert.equal(result.exitCode, expected === 'passed' ? 0 : 1);
      assert.equal(result.cleanupErrors.length, 0);
    }
  },
);
