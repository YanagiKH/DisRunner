import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DesktopRuntimeManager } from '../dist/runtime-manager.js';
import { createSessionWithDependencies } from '../dist/session.js';

const example = fileURLToPath(new URL('../../../examples/discordjs-bot/', import.meta.url));
const message = 'Unsupported fixture SDK version.';

async function fixture(t, exits) {
  const directory = await mkdtemp(join(tmpdir(), 'DisRunner bootstrap exit '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of [
    'bot.mjs',
    'discord-simulator.config.json',
    'guild.discord-fixture.json',
    'user.discord-fixture.json',
  ])
    await cp(join(example, file), join(directory, file));
  const line = `DISRUNNER_ADAPTER_ERROR ${JSON.stringify({ code: 'unsupported', message })}\n`;
  const script = `require('node:fs').writeSync(1,${JSON.stringify(line)});${exits ? 'setTimeout(()=>process.exit(1),40);' : 'setInterval(()=>{},1000);'}`;
  const stops = [];
  let runner;
  const dependencies = {
    wrapBot(bot) {
      runner = bot;
      const start = bot.start.bind(bot);
      const stop = bot.stop.bind(bot);
      bot.start = (config) =>
        start({ ...config, executable: process.execPath, args: ['-e', script] });
      bot.stop = (graceMs) => {
        stops.push({ at: performance.now(), snapshot: bot.snapshot() });
        return stop(graceMs);
      };
      return bot;
    },
  };
  return { directory, dependencies, stops, runner: () => runner };
}

test('a typed unsupported bootstrap is reaped before startup cleanup begins', async (t) => {
  const setup = await fixture(t, true);
  const session = createSessionWithDependencies({}, setup.dependencies);
  try {
    await session.selectProject(setup.directory);
    await assert.rejects(session.start(), { code: 'invalid', message });
    assert.equal(setup.stops.length, 1);
    assert.equal(setup.stops[0].snapshot.status, 'crashed');
    assert.equal(setup.stops[0].snapshot.exitCode, 1);
    assert.equal(setup.stops[0].snapshot.pid, undefined);
    assert.equal(typeof setup.stops[0].snapshot.exitedAtMs, 'number');
    assert.equal(session.snapshot().phase, 'error');
    assert.equal(session.snapshot().evidenceComplete, true);
    assert.equal((await session.stop()).ok, true);
  } finally {
    assert.equal((await session.dispose()).ok, true);
  }
});

test('a still-live unsupported bootstrap receives only a bounded grace before normal cleanup', async (t) => {
  const setup = await fixture(t, false);
  const session = createSessionWithDependencies({}, setup.dependencies);
  let reportedAt;
  session.subscribe((event) => {
    if (
      reportedAt === undefined &&
      event.snapshot.output.some((entry) => entry.text.includes(message))
    )
      reportedAt = performance.now();
  });
  try {
    await session.selectProject(setup.directory);
    await assert.rejects(session.start(), { code: 'invalid', message });
    assert.equal(setup.stops.length, 1);
    assert.equal(setup.stops[0].snapshot.status, 'running');
    assert.equal(typeof setup.stops[0].snapshot.pid, 'number');
    assert.ok(setup.stops[0].at - reportedAt >= 200);
    assert.ok(setup.stops[0].at - reportedAt < 1000);
    assert.equal(setup.runner().snapshot().status, 'stopped');
    assert.equal((await session.stop()).ok, true);
  } finally {
    assert.equal((await session.dispose()).ok, true);
  }
});

test('abort interrupts the bootstrap grace and retains a previously classified startup error', async (t) => {
  const setup = await fixture(t, false);
  const controller = new AbortController();
  const manager = new DesktopRuntimeManager(
    () => {},
    () => {},
    setup.dependencies,
  );
  try {
    await manager.selectProject(setup.directory);
    const starting = manager.start({ signal: controller.signal });
    const deadline = performance.now() + 5000;
    while (manager.failure?.code !== 'invalid') {
      assert.ok(performance.now() < deadline, 'The typed bootstrap error was not classified.');
      await delay(1);
    }
    const abortedAt = performance.now();
    controller.abort();
    const stopped = await starting;
    assert.equal(stopped.phase, 'error');
    assert.equal(manager.failure.code, 'invalid');
    assert.equal(manager.failure.message, message);
    assert.equal(setup.stops.length, 1);
    assert.ok(setup.stops[0].at - abortedAt < 150);
    assert.equal(typeof setup.stops[0].snapshot.pid, 'number');
    assert.equal(setup.runner().snapshot().status, 'stopped');
    assert.deepEqual(manager.shutdownIssues, []);
  } finally {
    controller.abort();
    await manager.stop();
  }
});
