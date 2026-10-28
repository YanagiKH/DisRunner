import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProjectConfiguration } from '../dist/project-config.js';
import { createSession } from '../dist/index.js';

const descriptorError =
  'profile.commandRegistry must be a command-registry-v1 descriptor with unique canonical guildIds (maximum 128).';
const fixtureError = 'profile.commandRegistry.guildIds must reference loaded guild fixtures.';
const descriptor = (guildIds = []) => ({ profile: 'command-registry-v1', guildIds });
const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'registry-config-'));
  try {
    await cp(example, root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, 'discord-simulator.config.json'), 'utf8'));
    const save = () =>
      writeFile(join(root, 'discord-simulator.config.json'), JSON.stringify(config));
    await run({ root, config, save });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const invalid = [
  null,
  true,
  false,
  'command-registry-v1',
  1,
  [],
  {},
  { profile: 'command-registry-v1' },
  { guildIds: [] },
  { ...descriptor(), extra: 'private-sentinel' },
  JSON.parse('{"profile":"command-registry-v1","guildIds":[],"__proto__":{}}'),
  JSON.parse('{"profile":"command-registry-v1","guildIds":[],"constructor":{}}'),
  JSON.parse('{"__proto__":{"profile":"command-registry-v1","guildIds":[]}}'),
  { profile: 'other', guildIds: [] },
  descriptor(null),
  descriptor('1000'),
  descriptor({}),
  descriptor(['1000', '1000']),
  descriptor(Array.from({ length: 129 }, (_, i) => String(i + 1))),
  ...[
    1000,
    null,
    '0',
    '-1',
    '+1',
    ' 1000',
    '1000 ',
    '01000',
    '1e3',
    '0x1',
    '',
    '18446744073709551616',
  ].map((id) => descriptor([id])),
];

test('omission stays absent and registry-only global opt-in needs no fixtures or bot', async () => {
  await fixture(async ({ root, config, save }) => {
    delete config.profile.commandRegistry;
    await save();
    const legacy = await loadProjectConfiguration(root);
    assert.equal(Object.hasOwn(legacy.profile, 'commandRegistry'), false);
    assert.equal(legacy.profile.ordinaryMessagePermissions, 'legacy-unenforced');
    delete config.fixtures;
    config.profile.commandRegistry = descriptor();
    await save();
    const resolved = await loadProjectConfiguration(root);
    assert.deepEqual(resolved.profile.commandRegistry, {
      profile: 'command-registry-v1',
      guildIds: [],
    });
    assert.equal(resolved.botUserId, undefined);
    assert.deepEqual(resolved.resources, []);
  });
});
for (const mode of ['strict', 'lenient'])
  for (const permission of ['legacy-unenforced', 'guild-text-own-messages-v1']) {
    test(`allowlist independent of ${mode}/${permission}`, async () => {
      await fixture(async ({ root, config, save }) => {
        config.profile.mode = mode;
        config.profile.ordinaryMessagePermissions = permission;
        config.profile.commandRegistry = descriptor(['1000']);
        if (permission === 'guild-text-own-messages-v1') {
          config.fixtures.bot = 'fixtures/bot.json';
          await writeFile(
            join(root, 'fixtures/bot.json'),
            JSON.stringify({ version: 1, user: { id: '5000', bot: true } }),
          );
        }
        await save();
        const result = await loadProjectConfiguration(root);
        assert.deepEqual(result.profile.commandRegistry, {
          profile: 'command-registry-v1',
          guildIds: ['1000'],
        });
        assert.equal(result.profile.mode, mode);
        assert.equal(result.profile.ordinaryMessagePermissions, permission);
        assert.equal(Object.isFrozen(result.profile.commandRegistry), true);
        assert.equal(Object.isFrozen(result.profile.commandRegistry.guildIds), true);
        config.profile.commandRegistry.guildIds[0] = '9000';
        await save();
        assert.deepEqual(result.profile.commandRegistry.guildIds, ['1000']);
        await assert.rejects(loadProjectConfiguration(root), {
          name: 'TypeError',
          message: fixtureError,
        });
      });
    });
  }
for (const [index, value] of invalid.entries())
  test(`literal descriptor rejection ${index} before listeners/children`, async () => {
    await fixture(async ({ root, config, save }) => {
      config.profile.commandRegistry = value;
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: descriptorError,
      });
      const session = createSession();
      const spawn = childProcess.spawn,
        listen = net.Server.prototype.listen;
      let spawns = 0,
        listeners = 0;
      childProcess.spawn = () => {
        spawns++;
        throw new Error('Unexpected spawn');
      };
      net.Server.prototype.listen = () => {
        listeners++;
        throw new Error('Unexpected listener');
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(session.selectProject(root));
        assert.equal(spawns, 0);
        assert.equal(listeners, 0);
        assert.equal(session.snapshot().pid, null);
        assert.equal(session.snapshot().coreState, null);
      } finally {
        childProcess.spawn = spawn;
        net.Server.prototype.listen = listen;
        syncBuiltinESMExports();
        assert.equal((await session.dispose()).ok, true);
      }
    });
  });
for (const ids of [['2000'], ['3000'], ['1000', '9000'], ['18446744073709551615']])
  test(`actual guild resource required ${ids}`, async () => {
    await fixture(async ({ root, config, save }) => {
      config.profile.commandRegistry = descriptor(ids);
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: fixtureError,
      });
      const session = createSession();
      const spawn = childProcess.spawn,
        listen = net.Server.prototype.listen;
      let spawns = 0,
        listeners = 0;
      childProcess.spawn = () => {
        spawns++;
        throw new Error('Unexpected spawn');
      };
      net.Server.prototype.listen = () => {
        listeners++;
        throw new Error('Unexpected listener');
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(session.selectProject(root));
        assert.equal(spawns, 0);
        assert.equal(listeners, 0);
        assert.equal(session.snapshot().pid, null);
        assert.equal(session.snapshot().coreState, null);
      } finally {
        childProcess.spawn = spawn;
        net.Server.prototype.listen = listen;
        syncBuiltinESMExports();
        assert.equal((await session.dispose()).ok, true);
      }
    });
  });
test('uint64 bounds accepted when actual fixture guild exists; bot pairing remains unchanged', async () => {
  await fixture(async ({ root, config, save }) => {
    for (const id of ['1', '18446744073709551615']) {
      await writeFile(
        join(root, config.fixtures.guild),
        JSON.stringify({ version: 1, guild: { id } }),
      );
      config.profile.commandRegistry = descriptor([id]);
      await save();
      assert.deepEqual((await loadProjectConfiguration(root)).profile.commandRegistry.guildIds, [
        id,
      ]);
    }
    config.profile.ordinaryMessagePermissions = 'guild-text-own-messages-v1';
    await save();
    await assert.rejects(loadProjectConfiguration(root), {
      name: 'TypeError',
      message: 'fixtures.bot is required for guild-text-own-messages-v1.',
    });
  });
});
test('schema is the literal structural contract, with runtime-only range/fixture checks', async () => {
  const requireCore = createRequire(import.meta.resolve('@disrunner/core'));
  const Ajv2020 = requireCore('ajv/dist/2020.js').default;
  const schema = JSON.parse(
    await readFile(
      new URL('../../../docs/schemas/discord-simulator.config.schema.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(schema.$defs.commandRegistry, {
    type: 'object',
    additionalProperties: false,
    required: ['profile', 'guildIds'],
    properties: {
      profile: { enum: ['command-registry-v1', 'command-registry-v2'] },
      guildIds: {
        type: 'array',
        maxItems: 128,
        uniqueItems: true,
        items: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
      },
    },
  });
  assert.deepEqual(schema.$defs.profile.properties.commandRegistry, {
    $ref: '#/$defs/commandRegistry',
  });
  const validate = new Ajv2020({ strict: false }).compile(schema);
  await fixture(async ({ config }) => {
    assert.equal(validate(config), true);
    for (const value of [descriptor(), descriptor(['1000'])]) {
      config.profile.commandRegistry = value;
      assert.equal(validate(config), true);
    }
    for (const value of invalid) {
      config.profile.commandRegistry = value;
      // The schema deliberately does not claim numeric uint64 validation.
      assert.equal(
        validate(config),
        JSON.stringify(value) === JSON.stringify(descriptor(['18446744073709551616'])),
      );
    }
    for (const value of [
      descriptor(['9000']),
      descriptor(['18446744073709551615']),
      descriptor(Array.from({ length: 128 }, (_, i) => String(i + 1))),
    ]) {
      config.profile.commandRegistry = value;
      assert.equal(validate(config), true);
    }
  });
});
