import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createReproductionBundle, parseReproductionBundle } from '../dist/reproduction.js';
import { runBotScenarioV2 } from '../dist/scenario-v2.js';

const fixture = fileURLToPath(
  new URL('../../../apps/cli/tests/fixtures/bot-test/', import.meta.url),
);
const secret = 'Reproduction-private-key-value-測試';
const sourceMarker = 'BOT_SOURCE_CONTENT_MUST_NOT_BE_EXPORTED';
const scenario = () => ({
  version: 2,
  name: 'Reproduction ping',
  execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10000 },
  context: { actor: '3000', guild: '1000', channel: '2000' },
  steps: [{ action: 'invoke-command', command: 'ping', saveAs: 'ping', timeoutMs: 1000 }],
  assertions: [
    {
      type: 'message-content',
      interaction: '${ping.id}',
      equals: 'Pong! Offline and deterministic.',
    },
  ],
});

async function project(t) {
  const directory = await mkdtemp(join(tmpdir(), 'DisRunner reproduction 測試 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const configFile = join(directory, 'discord-simulator.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.environment.LOCAL_API_KEY = secret;
  config.environment.SIGNING_PRIVATE_KEY =
    'Private-key-first-line-測試\nPrivate-key-second-line-測試';
  config.environment.DISRUNNER_TEST_TRACE = 'trace.jsonl';
  await writeFile(configFile, JSON.stringify(config));
  const source = await readFile(join(directory, 'server.mjs'), 'utf8');
  await writeFile(join(directory, 'server.mjs'), `${source}\n// ${sourceMarker}\n`);
  await writeFile(join(directory, '.env'), 'UNRELATED_ENV_FILE_MUST_NOT_BE_EXPORTED');
  await mkdir(join(directory, 'node_modules'));
  await writeFile(
    join(directory, 'node_modules', 'private-data.txt'),
    'DEPENDENCY_FILES_MUST_NOT_BE_EXPORTED',
  );
  const userFile = join(directory, 'user.json');
  const user = JSON.parse(await readFile(userFile, 'utf8'));
  user.user.note = secret;
  await writeFile(userFile, JSON.stringify(user));
  return directory;
}

async function run(t) {
  const directory = await project(t);
  const input = scenario();
  const result = await runBotScenarioV2(input, { baseDirectory: directory });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.ok(
    result.metadata.inputs?.fixtureHash,
    'The report must capture its actual initial fixture digest',
  );
  assert.ok(
    result.metadata.inputs?.sourceHash,
    'The report must capture its actual entry source digest',
  );
  return { directory, input, result };
}

test(
  'exports a verified diagnostic bundle without copying Bot code, .env or dependencies',
  { timeout: 20000 },
  async (t) => {
    const { directory, input, result } = await run(t);
    const source = await readFile(join(directory, 'server.mjs'));
    const traceBefore = await readFile(join(directory, 'trace.jsonl'), 'utf8');
    const unchangedResult = structuredClone(result);
    const bundle = await createReproductionBundle(directory, JSON.stringify(input), result);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.kind, 'bot-rerun');
    assert.equal(bundle.replayable, false);
    assert.equal(bundle.requiresOriginalProject, true);
    assert.equal(bundle.scenario.execution.project, '.');
    assert.equal(bundle.manifest.adapter, 'raw-interaction-webhook');
    assert.deepEqual(bundle.manifest.sdkPins, {});
    assert.equal(bundle.manifest.fixtureCapture, 'run-verified-at-export');
    assert.equal(bundle.manifest.sourceHashes[0].path, 'server.mjs');
    assert.equal(
      bundle.manifest.sourceHashes[0].sha256,
      createHash('sha256').update(source).digest('hex'),
    );
    assert.equal(bundle.manifest.sourceHashes[0].matchesRun, true);
    const serialized = JSON.stringify(bundle);
    for (const forbidden of [
      secret,
      sourceMarker,
      'UNRELATED_ENV_FILE_MUST_NOT_BE_EXPORTED',
      'DEPENDENCY_FILES_MUST_NOT_BE_EXPORTED',
      directory,
    ])
      assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(
      bundle.fixtures.find((resource) => resource.resourceType === 'user').note,
      '[REDACTED]',
    );
    assert.deepEqual(parseReproductionBundle(serialized), bundle);
    assert.deepEqual(result, unchangedResult, 'Export never rewrites the actual report');
    assert.equal(
      await readFile(join(directory, 'trace.jsonl'), 'utf8'),
      traceBefore,
      'Export must not restart the Bot',
    );
  },
);

test(
  'redacts private paths and credentials throughout actual report data and scenario values',
  { timeout: 20000 },
  async (t) => {
    const { directory, input, result } = await run(t);
    const synthetic = `disrunner.offline.${'x'.repeat(32)}`;
    const changedScenario = scenario();
    changedScenario.assertions[0].equals = secret;
    const changedResult = structuredClone(result);
    changedResult.metadata.scenarioHash = createHash('sha256')
      .update(
        JSON.stringify(
          (await import('../dist/scenario-v2.js')).parseBotScenarioV2(changedScenario),
        ),
      )
      .digest('hex');
    changedResult.issues.push({
      code: 'transport',
      message: `Credential: ${secret}\nBot ${synthetic}\nSource: /home/private-user/secret.js\nWindows: C:\\Users\\Private\\bot.py`,
    });
    changedResult.issues.push({
      code: 'transport',
      message: `Private-key-first-line-測試 and ${JSON.stringify('Private-key-first-line-測試\nPrivate-key-second-line-測試')}`,
    });
    changedResult.snapshot.output.push({
      stream: 'stderr',
      text: `Error at ${directory}/my source.js`,
      atMs: 0,
    });
    const bundle = await createReproductionBundle(directory, changedScenario, changedResult);
    const serialized = JSON.stringify(bundle);
    for (const forbidden of [
      secret,
      synthetic,
      '/home/private-user',
      'C:\\Users\\Private',
      directory,
      'Private-key-first-line-測試',
      'Private-key-second-line-測試',
    ])
      assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(bundle.scenario.assertions[0].equals, '[REDACTED]');
    assert.equal(bundle.manifest.redacted, true);
    assert.ok(bundle.reasons.some((reason) => reason.includes('redacted')));
    assert.equal(input.assertions[0].equals, 'Pong! Offline and deterministic.');
  },
);

test(
  'changed fixtures/profile/source after a run are never described as original input',
  { timeout: 20000 },
  async (t) => {
    const { directory, input, result } = await run(t);
    const userFile = join(directory, 'user.json');
    const user = JSON.parse(await readFile(userFile, 'utf8'));
    user.user.username = 'Edited after run';
    await writeFile(userFile, JSON.stringify(user));
    const configFile = join(directory, 'discord-simulator.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.profile.seed += 1;
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(join(directory, 'server.mjs'), '// Changed after the run.');
    const bundle = await createReproductionBundle(directory, input, result);
    assert.equal(bundle.manifest.fixtureCapture, 'project-at-export');
    assert.equal(bundle.manifest.sourceHashes[0].matchesRun, false);
    assert.ok(bundle.reasons.some((reason) => reason.includes('changed after the run')));
    assert.equal(bundle.replayable, false);
  },
);

test(
  'strict import rejects tampered hashes, unknown versions/fields, unsafe paths and oversized data',
  { timeout: 20000 },
  async (t) => {
    const { directory, input, result } = await run(t);
    const bundle = await createReproductionBundle(directory, input, result);
    for (const edit of [
      (value) => {
        value.fixtures[0].name = 'Tampered';
      },
      (value) => {
        value.scenario.steps[0].command = 'other';
      },
      (value) => {
        value.report.status = 'failed';
      },
      (value) => {
        value.manifest.inputFixtureHash = 'bad';
      },
      (value) => {
        value.manifest.sourceHashes[0].path = '../secret.js';
      },
      (value) => {
        value.manifest.sourceHashes[0].path = '/etc/secret.js';
      },
      (value) => {
        value.manifest.extra = true;
      },
      (value) => {
        value.extra = true;
      },
      (value) => {
        value.version = 2;
      },
      (value) => {
        value.replayable = true;
      },
    ]) {
      const changed = structuredClone(bundle);
      edit(changed);
      assert.throws(() => parseReproductionBundle(changed), /Reproduction|reproduction|Source/u);
    }
    assert.throws(() => parseReproductionBundle('x'.repeat(8 * 1_048_576 + 1)), RangeError);
    const unknownProfile = structuredClone(bundle);
    unknownProfile.manifest.profile.installScript = 'not-allowed';
    assert.throws(
      () => parseReproductionBundle(unknownProfile),
      /profile has missing or unknown fields/u,
    );
    assert.throws(() => parseReproductionBundle('{not JSON'), TypeError);
    let accessed = false;
    const changed = structuredClone(bundle);
    Object.defineProperty(changed, 'version', {
      enumerable: true,
      get() {
        accessed = true;
        return 1;
      },
    });
    assert.throws(() => parseReproductionBundle(changed), /accessors/u);
    assert.equal(accessed, false);
    const oversized = structuredClone(result);
    oversized.issues.push({ code: 'transport', message: 'x'.repeat(8 * 1_048_576 + 1) });
    await assert.rejects(createReproductionBundle(directory, input, oversized), RangeError);
  },
);

test(
  'export validates scenario/project identity and performs no process or network operations',
  { timeout: 20000 },
  async (t) => {
    const { directory, input, result } = await run(t);
    const originalSpawn = childProcess.spawn;
    const originalListen = net.Server.prototype.listen;
    const forbidden = () => {
      throw new Error('Export must not execute a Bot or start a server');
    };
    childProcess.spawn = forbidden;
    net.Server.prototype.listen = forbidden;
    syncBuiltinESMExports();
    try {
      await createReproductionBundle(directory, input, result);
      await assert.rejects(
        createReproductionBundle(directory, { ...input, name: 'Another scenario' }, result),
        /does not match/u,
      );
      await assert.rejects(createReproductionBundle(join(directory, 'missing'), input, result));
      const configFile = join(directory, 'discord-simulator.config.json');
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      config.fixtures.user = '../outside.json';
      await writeFile(configFile, JSON.stringify(config));
      await assert.rejects(createReproductionBundle(directory, input, result));
    } finally {
      childProcess.spawn = originalSpawn;
      net.Server.prototype.listen = originalListen;
      syncBuiltinESMExports();
    }
  },
);
