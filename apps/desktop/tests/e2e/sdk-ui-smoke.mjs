import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { linkDiscordJsFixture } from '../../../../scripts/sdk-fixture.mjs';
import {
  findExecutable,
  launchApplication,
  terminateProcessTree,
  waitForExit,
  sanitizeDiagnostic,
} from './package-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporary = await mkdtemp(path.join(tmpdir(), 'DisRunner packaged SDK 測試 '));
const evidence =
  process.env.DISRUNNER_SDK_UI_EVIDENCE ?? path.join(root, 'apps/desktop/sdk-ui-evidence');
const testViewport =
  process.env.DISRUNNER_SDK_UI_COMPACT === '1' ? { width: 720, height: 720 } : null;
await mkdir(evidence, { recursive: true });
for (const name of [
  'results.json',
  'failure.png',
  'failure-state.json',
  'viewport.json',
  'discord.js-interactions.png',
  'discord.js-direct-message.png',
  'discord.py-interactions.png',
  'discord.py-direct-message.png',
])
  await rm(path.join(evidence, name), { force: true });
const controller = new AbortController();
const timeout = setTimeout(
  () => controller.abort(new Error('Packaged SDK UI acceptance timed out.')),
  180000,
);
let applicationProcess;
let browser;
let page;
let output = '';
const results = [];
const viewports = [];
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
const onAbort = () => void browser?.close().catch(() => undefined);
controller.signal.addEventListener('abort', onAbort, { once: true });

async function prepare(adapter) {
  const source = path.join(
    root,
    'examples',
    adapter === 'discord.js' ? 'discordjs-bot' : 'discordpy-bot',
  );
  const directory = path.join(temporary, adapter);
  await mkdir(directory);
  const entry = adapter === 'discord.js' ? 'bot.mjs' : 'bot.py';
  for (const file of [
    entry,
    'discord-simulator.config.json',
    'guild.discord-fixture.json',
    'user.discord-fixture.json',
  ])
    await cp(path.join(source, file), path.join(directory, file));
  if (adapter === 'discord.js') await linkDiscordJsFixture(source, path.join(directory, entry));
  const filename = path.join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(filename, 'utf8'));
  const executable =
    adapter === 'discord.js'
      ? process.execPath
      : (process.env.DISRUNNER_TEST_PYTHON ??
        (process.platform === 'win32' ? 'python' : 'python3'));
  config.bot.startCommand = `"${executable}" ${entry}`;
  await writeFile(filename, JSON.stringify(config));
  return directory;
}
async function snapshot(actor) {
  return page.evaluate((id) => window.disrunnerDesktop.getRuntimeState(id), actor);
}
async function recordViewport(stage, adapter) {
  viewports.push({
    stage,
    adapter,
    testViewport,
    ...(await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      availableScreenWidth: screen.availWidth,
      availableScreenHeight: screen.availHeight,
      compactNavigation: window.matchMedia('(max-width: 1080px)').matches,
    }))),
    conversationPickerVisible: await page
      .getByRole('combobox', { name: 'Conversation', exact: true })
      .isVisible(),
    guildSidebarVisible: await page.locator('.guild-sidebar').isVisible(),
  });
  await writeFile(path.join(evidence, 'viewport.json'), JSON.stringify(viewports, null, 2));
}
async function explorer(command) {
  await page.getByRole('button', { name: 'Command Explorer', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Registered command', exact: true })
    .selectOption({ label: command });
}
async function invoke() {
  await page.getByRole('button', { name: 'Invoke command', exact: true }).click();
}
async function simulator() {
  await page.getByRole('button', { name: 'Back to simulator', exact: true }).click();
}
async function message(content) {
  await page
    .locator('.chat-message .message-content')
    .getByText(content, { exact: true })
    .last()
    .waitFor();
}
async function check(adapter) {
  const directory = await prepare(adapter);
  const selected = await page.evaluate(
    (directory) => window.disrunnerDesktop.openProject(directory),
    directory,
  );
  assert.equal(selected.phase, 'ready', selected.error ?? `${adapter} project validation`);
  const started = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
  assert.equal(started.phase, 'running', started.error ?? `${adapter} startup`);
  const context = started.contexts.find((context) => context.guildId !== undefined);
  assert.ok(context, 'SDK example has a server invocation context');
  await page.waitForFunction(
    async () =>
      (await window.disrunnerDesktop.getRuntimeState()).commands?.some(
        (command) => command.name === 'controls',
      ),
    undefined,
    { timeout: 10000 },
  );

  await explorer('tools math add');
  await page.getByRole('textbox', { name: 'left', exact: true }).fill('2');
  await page.getByRole('textbox', { name: 'right', exact: true }).fill('3');
  await invoke();
  await page.locator('.project-editor pre').filter({ hasText: 'Sum: 5' }).waitFor();
  await simulator();
  const expand = page.getByRole('button', { name: 'Expand inspector', exact: true });
  const restoreCollapsed = await expand.isVisible();
  if (restoreCollapsed) await expand.click();
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await page.getByRole('heading', { name: 'Observed spans', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Payload', exact: true }).click();
  const typedSummary = JSON.parse(
    await page.getByLabel('Interaction summary JSON', { exact: true }).textContent(),
  );
  assert.equal(typedSummary.action.type, 'command');
  assert.equal(typedSummary.action.name, 'tools');
  assert.equal(typedSummary.actorId, context.actorId);
  assert.equal(typedSummary.action.options[0].options[0].options[0].value, 2);
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  if (restoreCollapsed)
    await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();

  await explorer('controls');
  await invoke();
  await simulator();
  await message('Choose a control.');
  const sourceRow = page
    .locator('.chat-message')
    .filter({ has: page.getByRole('button', { name: 'Confirm', exact: true }) });
  const sourceId = await sourceRow.getAttribute('data-message-id');
  await page.getByRole('combobox', { name: 'choice', exact: true }).selectOption('apple');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page
    .locator('.chat-message.ephemeral')
    .getByText('Selected: apple', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await message('Button clicked.');
  assert.equal(
    await page
      .locator(`.chat-message[data-message-id="${sourceId}"] .message-content`)
      .textContent(),
    'Button clicked.',
  );

  await explorer('modal');
  await invoke();
  await page.getByRole('dialog', { name: 'Feedback', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Packaged UI');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await simulator();
  await message('Submitted: Packaged UI');

  await explorer('read-file');
  await page.getByRole('textbox', { name: 'file', exact: true }).fill('user.discord-fixture.json');
  await page.getByRole('button', { name: 'Use project file', exact: true }).click();
  await page.getByText(/user\.discord-fixture\.json \([0-9]+ bytes\)/u).waitFor();
  await invoke();
  await simulator();
  await message(
    `Read: ${await readFile(path.join(directory, 'user.discord-fixture.json'), 'utf8')}`,
  );

  await explorer('attachment');
  await invoke();
  await simulator();
  await page.locator('.message-attachment').filter({ hasText: 'note.txt' }).waitFor();
  await page.screenshot({
    path: path.join(evidence, `${adapter}-interactions.png`),
    fullPage: true,
  });
  assert.equal((await page.evaluate(() => window.disrunnerDesktop.stopRuntime())).ok, true);

  // Persist a DM fixture through the actual editor, restart and run the real prefix handler.
  await page.getByRole('button', { name: 'Guild Editor', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Fixture resources JSON', exact: true });
  const resources = JSON.parse(await editor.inputValue());
  const dmId = '900000000000000001';
  resources.push({
    resourceType: 'channel',
    id: dmId,
    type: 1,
    name: 'Direct test',
    recipients: [{ id: context.actorId }],
  });
  await editor.fill(JSON.stringify(resources, null, 2));
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Workspace saved.' }).waitFor();
  const restarted = await page.evaluate(() => window.disrunnerDesktop.startRuntime());
  assert.notEqual(restarted.runId, started.runId);
  const direct = restarted.contexts.find((context) => context.channelId === dmId);
  assert.deepEqual(direct, { actorId: context.actorId, channelId: dmId });
  await simulator();
  await recordViewport('before-dm-navigation', adapter);
  const conversation = page.getByRole('combobox', { name: 'Conversation', exact: true });
  if (await conversation.isVisible()) {
    const option = conversation.locator(`option[data-channel-id="${dmId}"]`);
    await option.waitFor({ state: 'attached' });
    assert.equal(await option.count(), 1, 'DM must be offered in the visible conversation picker');
    const value = await option.getAttribute('value');
    assert.equal(typeof value, 'string');
    await conversation.selectOption(value);
    assert.equal(
      await conversation.locator('option:checked').getAttribute('data-channel-id'),
      dmId,
    );
  } else {
    await page.waitForFunction((channelId) => {
      const sidebar = document.querySelector('.guild-sidebar');
      return (
        Boolean(sidebar?.querySelector(`.channel-row[data-channel-id="${channelId}"]`)) ||
        [...(sidebar?.querySelectorAll('.other-server-row') ?? [])].some((row) =>
          row.textContent?.includes('Direct messages'),
        )
      );
    }, dmId);
    const directGroup = page.locator('.other-server-row').filter({ hasText: 'Direct messages' });
    if (await directGroup.count()) {
      await directGroup.waitFor({ state: 'visible' });
      await directGroup.click();
    }
    const channel = page.locator(`.channel-row[data-channel-id="${dmId}"]`);
    await channel.waitFor({ state: 'visible' });
    await channel.click();
  }
  await recordViewport('after-dm-navigation', adapter);
  const composer = page.locator('.composer input');
  await composer.fill('!ping');
  await composer.press('Enter');
  await message('Pong!');
  const publicSnapshot = await snapshot();
  assert.equal(
    publicSnapshot.coreState.resources.some((resource) => resource.channel_id === dmId),
    false,
    'public snapshots hide direct messages',
  );
  const privateSnapshot = await snapshot(context.actorId);
  const response = privateSnapshot.coreState.resources.find(
    (resource) =>
      resource.resourceType === 'message' &&
      resource.channel_id === dmId &&
      resource.content === 'Pong!',
  );
  assert.ok(response, 'the selected actor sees the genuine SDK reply');
  assert.equal(
    Object.hasOwn(response, 'guild_id'),
    false,
    'DM messages must not invent a guild ID',
  );
  await page.screenshot({
    path: path.join(evidence, `${adapter}-direct-message.png`),
    fullPage: true,
  });
  const stopped = await page.evaluate(() => window.disrunnerDesktop.stopRuntime());
  assert.equal(stopped.ok, true);
  assert.equal(stopped.snapshot.pid, null);
  assert.equal(stopped.snapshot.endpoints, null);
  results.push({
    adapter,
    status: 'passed',
    version: adapter === 'discord.js' ? '14.27.0' : '2.6.4',
    checks: [
      'typed-subcommand',
      'typed-Inspector-summary-and-spans',
      'select-ephemeral',
      'button-message-update',
      'modal-submit',
      'project-attachment-option',
      'Bot-attachment',
      'workspace-save-and-restart',
      'DM-prefix-and-visibility',
      'cleanup',
    ],
  });
}

try {
  const executable = await findExecutable();
  const asar =
    process.platform === 'darwin'
      ? path.resolve(path.dirname(executable), '../Resources/app.asar')
      : path.join(path.dirname(executable), 'resources/app.asar');
  const executableSha256 = await digest(executable);
  const asarSha256 = await digest(asar);
  const launched = await launchApplication(
    executable,
    path.join(temporary, 'profile'),
    controller.signal,
    (chunk) => {
      output = (output + chunk).slice(-32768);
    },
  );
  applicationProcess = launched.process;
  browser = await chromium.connectOverCDP(launched.devtoolsUrl, { timeout: 15000 });
  const context = browser.contexts()[0];
  assert.ok(context);
  page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 15000 }));
  await page.waitForURL(/^file:/u);
  if (testViewport) await page.setViewportSize(testViewport);
  const runtimeInfo = await page.evaluate(() => window.disrunnerDesktop.getRuntimeInfo());
  assert.equal(runtimeInfo.packaged, true);
  if (process.env.RELEASE_VERSION !== undefined)
    assert.equal(
      runtimeInfo.version,
      process.env.RELEASE_VERSION,
      'installed desktop version must match the release version',
    );
  await recordViewport('startup');
  await check('discord.js');
  await check('discord.py');
  assert.equal(
    await digest(executable),
    executableSha256,
    'packaged executable must remain unchanged during acceptance',
  );
  assert.equal(
    await digest(asar),
    asarSha256,
    'packaged archive must remain unchanged during acceptance',
  );
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      {
        version: runtimeInfo.version,
        platform: process.platform,
        architecture: process.arch,
        node: process.versions.node,
        sourceCommit: process.env.GITHUB_SHA ?? null,
        executableSha256,
        asarSha256,
        testViewport,
        viewports,
        results,
      },
      null,
      2,
    ),
  );
  await page.evaluate(() => window.disrunnerDesktop.controlWindow('close')).catch(() => undefined);
  await waitForExit(applicationProcess, 10000, controller.signal);
  applicationProcess = undefined;
  process.stdout.write(`Packaged SDK UI acceptance passed for ${results.length} adapters.\n`);
} catch (error) {
  if (page && !page.isClosed()) {
    await recordViewport('failure').catch(() => undefined);
    await page
      .screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true })
      .catch(() => undefined);
    await writeFile(
      path.join(evidence, 'failure-state.json'),
      JSON.stringify(await snapshot().catch(() => null), null, 2),
    );
  }
  if (error instanceof Error)
    error.message += `\nPackaged process diagnostics:\n${sanitizeDiagnostic(output)}`;
  throw error;
} finally {
  clearTimeout(timeout);
  controller.signal.removeEventListener('abort', onAbort);
  if (page && !page.isClosed())
    await page.evaluate(() => window.disrunnerDesktop.stopRuntime()).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await terminateProcessTree(applicationProcess);
  await rm(temporary, { recursive: true, force: true });
}
