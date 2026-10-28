import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  GatewayEmulator,
  InteractionEngine,
  LocalGatewayServer,
  LocalRestEmulator,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
  projectMessageWire,
} from '../../packages/core/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'disrunner.offline.sdk-conformance_0123456789';
const USER = {
  id: '300000000000000001',
  username: 'developer',
  discriminator: '0',
  avatar: null,
  bot: false,
};
const BOT = {
  id: '400000000000000001',
  username: 'local-bot',
  discriminator: '0',
  avatar: null,
  bot: true,
};
const GUILD = '100000000000000001';
const CHANNEL = '200000000000000001';
const APP = '500000000000000001';

async function eventually(read, predicate, diagnostics, timeoutMs = 8_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = read();
    if (predicate(value)) return value;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error(`SDK operation timed out. ${diagnostics()}`);
}

async function harness(adapter, run) {
  const clock = new VirtualClock({ nowMs: Date.now() });
  const random = new SeededRandom(4042);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: GUILD, name: 'SDK Lab', owner_id: USER.id },
    {
      resourceType: 'channel',
      id: CHANNEL,
      guild_id: GUILD,
      type: 0,
      name: 'bot-testing',
      permission_overwrites: [],
    },
    {
      resourceType: 'role',
      id: GUILD,
      guild_id: GUILD,
      name: '@everyone',
      permissions: '68608',
      position: 0,
    },
    { resourceType: 'user', ...USER },
    { resourceType: 'user', ...BOT },
    {
      resourceType: 'member',
      id: '600000000000000001',
      guild_id: GUILD,
      user_id: USER.id,
      user: USER,
      roles: [],
      joined_at: '2026-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
    },
    {
      resourceType: 'member',
      id: '600000000000000002',
      guild_id: GUILD,
      user_id: BOT.id,
      user: BOT,
      roles: [],
      joined_at: '2026-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
    },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    fakeToken: TOKEN,
    applicationId: APP,
    botUserId: BOT.id,
    portalEnabledPrivilegedIntents: '32770',
    bootstrap: { state, user: BOT },
  });
  const server = new LocalGatewayServer({ gateway });
  const gatewayAddress = await server.start(0);
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    applicationId: APP,
    profile: createSimulationProfile(),
    messageAuthority: {
      state,
      gateway,
      author: BOT,
      context: { runId: 'sdk-conformance', clockDomain: 'realtime' },
    },
  });
  const rest = new LocalRestEmulator({
    state,
    interactions,
    gateway,
    fakeToken: TOKEN,
    gatewayUrl: gatewayAddress.url,
    rateLimits: new RateLimitEngine(clock),
    commandRegistry: { profile: 'command-registry-v2', guildIds: [GUILD] },
    bootstrap: {
      user: BOT,
      application: {
        id: APP,
        name: 'SDK Lab',
        description: '',
        icon: null,
        bot_public: false,
        bot_require_code_grant: false,
        owner: USER,
        verify_key: '0'.repeat(64),
        flags: 0,
        team: null,
      },
    },
  });
  const address = await rest.start(0);
  const example = adapter === 'discord.js' ? 'discordjs-bot' : 'discordpy-bot';
  const bootstrap =
    adapter === 'discord.js' ? 'adapter-discordjs/bootstrap.cjs' : 'adapter-discordpy/bootstrap.py';
  const command =
    adapter === 'discord.js' ? process.execPath : (process.env.DISRUNNER_TEST_PYTHON ?? 'python3');
  const child = spawn(
    command,
    [
      path.join(root, 'packages', bootstrap),
      path.join(root, 'examples', example, adapter === 'discord.js' ? 'bot.mjs' : 'bot.py'),
    ],
    {
      cwd: path.join(root, 'examples', example),
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        DISRUNNER_OFFLINE: '1',
        DISRUNNER_FAKE_TOKEN: TOKEN,
        DISCORD_TOKEN: TOKEN,
        DISCORD_API_BASE_URL: address.apiBaseUrl,
        DISCORD_GATEWAY_URL: gatewayAddress.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (bytes) => {
    output = (output + bytes.toString()).slice(-32_768);
  });
  child.stderr.on('data', (bytes) => {
    output = (output + bytes.toString()).slice(-32_768);
  });
  const diagnostics = () => `Exit ${child.exitCode}. ${output}`;
  try {
    await eventually(
      () => output,
      (text) => text.includes('DISRUNNER_ADAPTER_READY'),
      diagnostics,
      15_000,
    );
    const commands = await eventually(
      () => state.list('application-command'),
      (items) => items.some((item) => item.name === 'echo'),
      diagnostics,
    );
    await run({
      state,
      gateway,
      server,
      interactions,
      commands,
      address,
      diagnostics,
      output: () => output,
    });
    assert.equal(child.exitCode, null, diagnostics());
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit').catch(() => undefined), delay(2_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rest.stop();
    await server.stop();
  }
}

function invoke(env, name, options = [], extra = {}) {
  const command = env.commands.find((item) => item.name === name);
  assert.ok(command, `${name} was registered through the SDK`);
  const { data: extendedData, ...wireExtra } = extra;
  const data = { id: command.id, name, type: command.type, options, ...(extendedData ?? {}) };
  const created = env.interactions.create({
    type: 'command',
    data,
    messageProfile: 'interactions-v1',
    context: { actorId: USER.id, guildId: GUILD, channelId: CHANNEL },
  });
  const session = env.gateway.sessions().find((item) => item.state === 'ready');
  assert.ok(session, 'The real SDK has an authenticated Gateway session');
  env.server.dispatch(session.id, 'INTERACTION_CREATE', {
    id: created.id,
    application_id: APP,
    token: created.token,
    type: 2,
    version: 1,
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, type: 0, name: 'bot-testing', guild_id: GUILD },
    member: {
      user: USER,
      roles: [],
      joined_at: '2026-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      permissions: '8',
      flags: 0,
    },
    data,
    app_permissions: '8',
    flags: 0,
    locale: 'en-US',
    guild_locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: { 0: GUILD },
    context: 0,
    attachment_size_limit: 1_048_576,
    ...wireExtra,
  });
  return created;
}

function interact(env, kind, data, source, actor = USER) {
  const created = env.interactions.create({
    type: kind,
    data,
    messageProfile: 'interactions-v1',
    context: { actorId: actor.id, guildId: GUILD, channelId: CHANNEL },
    ...(source === undefined ? {} : { sourceMessageId: source.id }),
  });
  const session = env.gateway.sessions().find((item) => item.state === 'ready');
  assert.ok(session);
  env.server.dispatch(session.id, 'INTERACTION_CREATE', {
    id: created.id,
    application_id: APP,
    token: created.token,
    type: kind === 'component' ? 3 : kind === 'autocomplete' ? 4 : 5,
    version: 1,
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, type: 0, name: 'bot-testing', guild_id: GUILD },
    member: {
      user: actor,
      roles: [],
      flags: 0,
      joined_at: '2026-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    data,
    app_permissions: '8',
    locale: 'en-US',
    guild_locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: { 0: GUILD },
    context: 0,
    attachment_size_limit: 1_048_576,
    ...(source === undefined ? {} : { message: projectMessageWire(source) }),
  });
  return created;
}

for (const adapter of ['discord.js', 'discord.py']) {
  test(
    `${adapter}: real SDK login, cache, sync, typed slash, deferred original and followup`,
    { timeout: 40_000 },
    async () => {
      await harness(adapter, async (env) => {
        await eventually(
          env.output,
          (text) => text.includes('Cache: guilds=1 channels=1 members=2'),
          env.diagnostics,
        );
        assert.ok(
          env.commands.some((command) => command.name === 'Inspect user' && command.type === 2),
        );
        assert.ok(
          env.commands.some((command) => command.name === 'Inspect message' && command.type === 3),
        );
        const ping = invoke(env, 'ping');
        const response = await eventually(
          () => env.interactions.get(ping.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(response.initialResponse.data.content, 'Pong!');
        const echo = invoke(env, 'echo', [{ name: 'text', type: 3, value: '離線 echo ✓' }]);
        const echoed = await eventually(
          () => env.interactions.get(echo.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(echoed.initialResponse.data.content, '離線 echo ✓');
        const addition = invoke(env, 'tools', [
          {
            type: 2,
            name: 'math',
            options: [
              {
                type: 1,
                name: 'add',
                options: [
                  { type: 4, name: 'left', value: 7 },
                  { type: 4, name: 'right', value: 5 },
                ],
              },
            ],
          },
        ]);
        const added = await eventually(
          () => env.interactions.get(addition.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(added.initialResponse.data.content, 'Sum: 12');
        const userContext = invoke(env, 'Inspect user', [], {
          data: { target_id: USER.id, resolved: { users: { [USER.id]: { ...USER } } } },
        });
        const inspectedUser = await eventually(
          () => env.interactions.get(userContext.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(inspectedUser.initialResponse.data.content, 'User: developer');
        const deferred = invoke(env, 'defer');
        const edited = await eventually(
          () => env.interactions.get(deferred.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(edited.initialResponse.data.content, 'Deferred reply complete.');
        assert.equal(edited.initialResponse.ephemeral, true);
        const following = invoke(env, 'followup');
        const followed = await eventually(
          () => env.interactions.get(following.id),
          (item) => item.followups.length === 1,
          env.diagnostics,
        );
        assert.equal(followed.initialResponse.data.content, 'First reply.');
        assert.equal(followed.followups[0].data.content, 'Followup reply.');
        const headers = { Authorization: `Bot ${TOKEN}` };
        const original = await fetch(
          `${env.address.apiBaseUrl}/webhooks/${APP}/${deferred.token}/messages/@original`,
          { headers },
        );
        assert.equal(original.status, 200);
        assert.equal((await original.json()).content, 'Deferred reply complete.');

        const controls = invoke(env, 'controls');
        const controlReply = await eventually(
          () => env.interactions.get(controls.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        const source = env.state.require('message', controlReply.originalMessageId);
        assert.equal(source.components.length, 2);
        const select = interact(
          env,
          'component',
          { custom_id: 'choice', component_type: 3, values: ['apple'] },
          source,
        );
        const selected = await eventually(
          () => env.interactions.get(select.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(selected.initialResponse.data.content, 'Selected: apple');
        assert.equal(selected.initialResponse.ephemeral, true);
        const button = interact(
          env,
          'component',
          { custom_id: 'confirm', component_type: 2 },
          source,
        );
        await eventually(
          () => env.interactions.get(button.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(env.state.require('message', source.id).content, 'Button clicked.');
        assert.equal(env.state.require('message', source.id).components.length, 0);
        const messageContext = invoke(env, 'Inspect message', [], {
          data: {
            target_id: source.id,
            resolved: {
              messages: {
                [source.id]: projectMessageWire(env.state.require('message', source.id)),
              },
            },
          },
        });
        const inspectedMessage = await eventually(
          () => env.interactions.get(messageContext.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(inspectedMessage.initialResponse.data.content, 'Message: Button clicked.');

        const opening = invoke(env, 'modal');
        const opened = await eventually(
          () => env.interactions.get(opening.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(opened.initialResponse.type, 'modal');
        assert.equal(opened.initialResponse.data.custom_id, 'feedback');
        const submitting = interact(env, 'modal-submit', {
          custom_id: 'feedback',
          components: [
            { type: 1, components: [{ type: 4, custom_id: 'answer', value: 'Local feedback' }] },
          ],
        });
        const submitted = await eventually(
          () => env.interactions.get(submitting.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(submitted.initialResponse.data.content, 'Submitted: Local feedback');

        const search = env.commands.find((item) => item.name === 'search');
        const completing = interact(env, 'autocomplete', {
          id: search.id,
          name: 'search',
          type: 1,
          options: [{ name: 'query', type: 3, value: 'a', focused: true }],
        });
        const completed = await eventually(
          () => env.interactions.get(completing.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        assert.equal(completed.initialResponse.type, 'autocomplete');
        assert.deepEqual(completed.initialResponse.data.choices, [
          { name: 'apple', value: 'apple' },
        ]);
        const uploading = invoke(env, 'attachment');
        const uploaded = await eventually(
          () => env.interactions.get(uploading.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        const uploadedMessage = env.state.require('message', uploaded.originalMessageId);
        assert.equal(uploadedMessage.attachments.length, 1);
        const attachment = uploadedMessage.attachments[0];
        assert.equal(attachment.filename, 'note.txt');
        assert.equal(attachment.size, Buffer.byteLength('Offline attachment ✓\n'));
        assert.equal(new URL(attachment.url).origin, new URL(env.address.apiBaseUrl).origin);
        const download = await fetch(attachment.url, { headers });
        assert.equal(download.status, 200);
        assert.equal(await download.text(), 'Offline attachment ✓\n');
        await eventually(
          env.output,
          (text) =>
            text.includes(`Attachment bytes: ${Buffer.byteLength('Offline attachment ✓\n')}`),
          env.diagnostics,
        );

        const collecting = invoke(env, 'collector');
        const listening = await eventually(
          () => env.interactions.get(collecting.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        await eventually(
          env.output,
          (text) => text.includes('Collector listening.'),
          env.diagnostics,
        );
        const collectorMessage = env.state.require('message', listening.originalMessageId);
        const other = { ...USER, id: '300000000000000002', username: 'another-user' };
        env.state.create('user', other);
        env.state.create('member', {
          id: '600000000000000003',
          guild_id: GUILD,
          user_id: other.id,
          user: other,
          roles: [],
        });
        const ignored = interact(
          env,
          'component',
          { custom_id: 'collector', component_type: 2 },
          collectorMessage,
          other,
        );
        await eventually(
          env.output,
          (text) => text.includes('Collector filtered another user.'),
          env.diagnostics,
        );
        assert.equal(env.interactions.get(ignored.id).status, 'pending');
        assert.equal(env.state.require('message', collectorMessage.id).content, 'Collector ready.');
        const accepted = interact(
          env,
          'component',
          { custom_id: 'collector', component_type: 2 },
          collectorMessage,
        );
        await eventually(
          () => env.interactions.get(accepted.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        await eventually(
          env.output,
          (text) => text.includes('Collector ended: limit'),
          env.diagnostics,
        );
        assert.equal(env.state.require('message', collectorMessage.id).content, 'Collected.');
        assert.equal(env.state.require('message', collectorMessage.id).components.length, 0);
        const expiring = invoke(env, 'collector');
        const timeoutReply = await eventually(
          () => env.interactions.get(expiring.id),
          (item) => item.status === 'responded',
          env.diagnostics,
        );
        await eventually(
          () => env.state.require('message', timeoutReply.originalMessageId),
          (message) => message.content === 'Collector timed out.',
          env.diagnostics,
        );
        await eventually(
          env.output,
          (text) => text.includes('Collector ended: time'),
          env.diagnostics,
        );
        assert.equal(
          env.state.require('message', timeoutReply.originalMessageId).components.length,
          0,
        );
        assert.equal(env.state.require('message', collectorMessage.id).content, 'Collected.');
      });
    },
  );
}
