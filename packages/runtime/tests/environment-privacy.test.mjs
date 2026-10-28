import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { loadProjectConfiguration } from '../dist/project-config.js';
import { createSession } from '../dist/index.js';

const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));

async function withEnvironment(environment, run) {
  const directory = await mkdtemp(join(tmpdir(), 'DisRunner environment privacy 測試 '));
  try {
    await cp(example, directory, { recursive: true });
    const filename = join(directory, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.environment = environment;
    await writeFile(filename, JSON.stringify(config));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the complete environment count and the supported multibyte value boundary', async () => {
  const environment = Object.fromEntries(
    Array.from({ length: 252 }, (_, index) => [`LOCAL_${index}_CREDENTIAL`, `private-${index}`]),
  );
  environment.LOCAL_0_CREDENTIAL = 'é'.repeat(32_768);
  environment.LOCAL_1_CREDENTIAL = 'first-private-line\nsecond-private-line"\\';
  await withEnvironment(environment, async (directory) => {
    assert.deepEqual((await loadProjectConfiguration(directory)).environment, environment);
  });
});

test(
  '252 project variables preserve every child value alongside four reserved runtime slots',
  { timeout: 15_000 },
  async () => {
    const environment = Object.fromEntries(
      Array.from({ length: 252 }, (_, index) => [`LOCAL_${index}_CREDENTIAL`, `private-${index}`]),
    );
    await withEnvironment(environment, async (directory) => {
      const filename = join(directory, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(filename, 'utf8'));
      config.bot.entryPoint = 'src/environment-boundary-entry.mjs';
      config.bot.startCommand = 'node src/environment-boundary-entry.mjs';
      await writeFile(filename, JSON.stringify(config));
      await writeFile(
        join(directory, config.bot.entryPoint),
        `import {startFromEnvironment} from './server.mjs';
const keys=Object.keys(process.env).filter(name=>/^LOCAL_[0-9]+_CREDENTIAL$/.test(name));
if(keys.length!==252)throw Error('Project environment variables were dropped.');
for(let index=0;index<252;index++)if(process.env['LOCAL_'+index+'_CREDENTIAL']!=='private-'+index)throw Error('Project environment value changed.');
for(const name of ['DISRUNNER_REST_PORT','DISRUNNER_GATEWAY_PORT','DISRUNNER_BOT_PORT','DISRUNNER_PUBLIC_KEY'])if(!process.env[name])throw Error('Managed runtime setting missing.');
const server=await startFromEnvironment();
process.stdout.write('ENVIRONMENT_BOUNDARY_OK\\n');
const shutdown=()=>{server.close(()=>{process.exitCode=0;});setTimeout(()=>server.closeAllConnections(),1000).unref();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
`,
      );
      const session = createSession();
      let started;
      try {
        await session.selectProject(directory);
        started = await session.start({ timeoutMs: 10_000 });
        assert.equal(started.phase, 'running');
        assert.ok(Number.isSafeInteger(started.pid) && started.pid > 0);
        const result = await session.invoke({
          runId: started.runId,
          requestId: 'environment-boundary',
          input: '/ping',
          context: started.contexts[0],
        });
        assert.equal(result.ok, true);
        assert.equal(result.response.data.content, 'Pong! Offline and deterministic.');
        assert.ok(
          session.snapshot().output.some((entry) => entry.text.includes('ENVIRONMENT_BOUNDARY_OK')),
        );
      } finally {
        assert.equal((await session.dispose()).ok, true);
        if (started) {
          for (const endpoint of Object.values(started.endpoints))
            await assertListenerClosed(endpoint);
          const deadline = Date.now() + 2000;
          let exited = false;
          while (Date.now() < deadline && !exited) {
            try {
              process.kill(started.pid, 0);
            } catch (error) {
              assert.equal(error.code, 'ESRCH', 'Bot process exit could not be verified.');
              exited = true;
            }
            if (!exited) await delay(10);
          }
          assert.equal(exited, true, 'The actual Bot process must exit after cleanup.');
        }
      }
    });
  },
);

for (const count of [253, 256]) {
  test(`${count} project variables cannot consume reserved runtime environment slots`, async () => {
    const environment = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`LOCAL_${index}`, `value-${index}`]),
    );
    await withEnvironment(environment, async (directory) => {
      const endpoints = [];
      const session = createSession({
        onEndpoints: (value) => {
          if (value) endpoints.push(value);
        },
      });
      try {
        await assert.rejects(session.selectProject(directory), { code: 'invalid' });
        assert.match(session.snapshot().error, /252 variables/u);
        await assert.rejects(session.start(), { code: 'invalid' });
        assert.equal(session.snapshot().pid, null);
        assert.equal(session.snapshot().runId, null);
        assert.equal(session.snapshot().endpoints, null);
        assert.deepEqual(endpoints, []);
      } finally {
        assert.equal((await session.dispose()).ok, true);
      }
    });
  });
}

for (const [label, environment, error] of [
  [
    'too many variables',
    Object.fromEntries(Array.from({ length: 253 }, (_, index) => [`KEY_${index}`, 'value'])),
    /environment cannot contain more than 252 variables/u,
  ],
  ['an oversized name', { ['A'.repeat(257)]: 'value' }, /Invalid environment variable name/u],
  [
    'an oversized UTF-8 value',
    { LOCAL_CREDENTIAL: '界'.repeat(32_768) },
    /cannot exceed 65,536 UTF-8 bytes/u,
  ],
]) {
  test(`rejects ${label} before accepting a project for subprocess execution`, async () => {
    await withEnvironment(environment, async (directory) => {
      await assert.rejects(loadProjectConfiguration(directory), error);
    });
  });
}

async function assertListenerClosed(endpoint) {
  const result = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(error.code);
    });
  });
  assert.equal(result, 'ECONNREFUSED', 'Stopped session listeners must refuse connections.');
}
