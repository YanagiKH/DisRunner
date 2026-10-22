import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProjectConfiguration } from '../dist/project-config.js';
import { createSession } from '../dist/index.js';

const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-permissions-config-'));
  try {
    await cp(example, root, { recursive: true });
    const config = JSON.parse(await readFile(join(root, 'discord-simulator.config.json'), 'utf8'));
    config.profile.ordinaryMessagePermissions = 'guild-text-own-messages-v1';
    config.fixtures.bot = 'fixtures/bot.json';
    const guild = {
      version: 1,
      guild: {
        id: '1000',
        owner_id: '9000',
        roles: [
          { id: '1000', permissions: '0' },
          { id: '1100', permissions: '68608' },
        ],
        channels: [{ id: '2000', type: 0, permission_overwrites: [] }],
        members: [{ id: '5100', user_id: '5000', roles: ['1100'] }],
      },
    };
    const bot = { version: 1, user: { id: '5000', bot: true, username: 'Fixture Bot' } };
    const save = async () => {
      await writeFile(join(root, 'discord-simulator.config.json'), JSON.stringify(config));
      await writeFile(join(root, config.fixtures.guild), JSON.stringify(guild));
      await writeFile(join(root, 'fixtures/bot.json'), JSON.stringify(bot));
    };
    await save();
    await run({ root, config, guild, bot, save });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('strict project opt-in materializes literal resources and preserves only the human actor', async () => {
  await fixture(async ({ root }) => {
    const config = await loadProjectConfiguration(root);
    assert.equal(config.profile.ordinaryMessagePermissions, 'guild-text-own-messages-v1');
    assert.deepEqual(
      config.resources.map((r) => `${r.resourceType}:${r.id}`),
      [
        'guild:1000',
        'role:1000',
        'role:1100',
        'channel:2000',
        'member:5100',
        'user:3000',
        'user:5000',
      ],
    );
    for (const resource of config.resources.slice(1, 5)) assert.equal(resource.guild_id, '1000');
    assert.equal(config.resources[0].members, undefined);
    assert.deepEqual(config.resources[4], {
      id: '5100',
      user_id: '5000',
      roles: ['1100'],
      guild_id: '1000',
      resourceType: 'member',
    });
    const session = createSession();
    try {
      await session.selectProject(root);
      assert.deepEqual(session.snapshot().contexts, [
        { actorId: '3000', guildId: '1000', channelId: '2000' },
      ]);
      assert.throws(
        () => session.validateContext({ actorId: '5000', guildId: '1000', channelId: '2000' }),
        { code: 'invalid' },
      );
    } finally {
      assert.equal((await session.dispose()).ok, true);
    }
  });
});

for (const value of [null, 0, [], {}, 'strict', 'GUILD-TEXT-OWN-MESSAGES-V1']) {
  test(`invalid permission enum ${JSON.stringify(value)} fails before fixture paths`, async () => {
    await fixture(async ({ root, config, save }) => {
      config.profile.ordinaryMessagePermissions = value;
      config.fixtures.bot = '../absent';
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: /profile.ordinaryMessagePermissions/,
      });
    });
  });
}
for (const legacy of [undefined, 'legacy-unenforced']) {
  test(`legacy ${legacy} rejects bot before fixture paths, preserves legacy when absent`, async () => {
    await fixture(async ({ root, config, guild, save }) => {
      config.profile.ordinaryMessagePermissions = legacy;
      config.fixtures.bot = '../absent';
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: /fixtures.bot requires/,
      });
      delete config.fixtures.bot;
      guild.guild.members = 'legacy opaque embedded members';
      guild.guild.roles[0].guild_id = 'different';
      await save();
      const loaded = await loadProjectConfiguration(root);
      assert.equal(loaded.profile.ordinaryMessagePermissions, 'legacy-unenforced');
      assert.equal(loaded.botUserId, undefined);
      assert.equal(loaded.resources[0].members, 'legacy opaque embedded members');
      assert.equal(loaded.resources[1].guild_id, 'different');
    });
  });
}
test('strict bot pairing precedes reads and works independently of lenient payload mode', async () => {
  await fixture(async ({ root, config, save }) => {
    delete config.fixtures.bot;
    config.fixtures.guild = '../missing';
    await writeFile(join(root, 'discord-simulator.config.json'), JSON.stringify(config));
    await assert.rejects(loadProjectConfiguration(root), {
      name: 'TypeError',
      message: /fixtures.bot is required/,
    });
    config.fixtures.bot = 'fixtures/bot.json';
    config.fixtures.guild = 'fixtures/foundation-lab.discord-fixture.json';
    config.profile.mode = 'lenient';
    await save();
    assert.equal((await loadProjectConfiguration(root)).profile.mode, 'lenient');
  });
});
for (const id of [
  '0',
  '05000',
  '-1',
  '+1',
  ' 5000',
  '5000 ',
  '1e3',
  '0x12',
  '18446744073709551616',
  5000,
  null,
  '',
]) {
  test(`bot id ${JSON.stringify(id)} is structurally invalid`, async () => {
    await fixture(async ({ root, bot, save }) => {
      bot.user.id = id;
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: /(?:bot fixture user.id|user fixture id)/,
      });
    });
  });
}
for (const id of ['1', '18446744073709551615']) {
  test(`bot uint64 boundary ${id} is accepted`, async () => {
    await fixture(async ({ root, bot, save }) => {
      bot.user.id = id;
      await save();
      assert.equal((await loadProjectConfiguration(root)).botUserId, id);
    });
  });
}
for (const botValue of [undefined, false, 'true', 1]) {
  test(`bot marker ${botValue} requires literal true`, async () => {
    await fixture(async ({ root, bot, save }) => {
      bot.user.bot = botValue;
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: /user.bot must be true/,
      });
    });
  });
}
for (const collection of ['roles', 'channels', 'members']) {
  for (const conflict of [null, 'other', 1000]) {
    test(`${collection} explicit conflicting parent ${conflict} fails`, async () => {
      await fixture(async ({ root, guild, save }) => {
        guild.guild[collection][0].guild_id = conflict;
        await save();
        await assert.rejects(loadProjectConfiguration(root), {
          name: 'TypeError',
          message: /guild_id must match/,
        });
      });
    });
  }
  for (const invalid of [null, {}, [null], ['bad']]) {
    test(`${collection} structural array ${JSON.stringify(invalid)} fails`, async () => {
      await fixture(async ({ root, guild, save }) => {
        guild.guild[collection] = invalid;
        await save();
        await assert.rejects(loadProjectConfiguration(root), {
          name: 'TypeError',
          message: /must be an (?:array|object)/,
        });
      });
    });
  }
  test(`${collection} duplicate resource key fails`, async () => {
    await fixture(async ({ root, guild, save }) => {
      guild.guild[collection].push({ ...guild.guild[collection][0] });
      await save();
      await assert.rejects(loadProjectConfiguration(root), {
        name: 'TypeError',
        message: /Duplicate fixture resource key/,
      });
    });
  });
}
test('human/bot duplicate user keys fail, but ambiguous membership and semantic negatives remain unrepaired', async () => {
  await fixture(async ({ root, bot, guild, save }) => {
    bot.user.id = '3000';
    await save();
    await assert.rejects(loadProjectConfiguration(root), {
      name: 'TypeError',
      message: /Duplicate fixture resource key/,
    });
    bot.user.id = '5000';
    guild.guild.members.push({
      id: '5200',
      user_id: '5000',
      roles: ['missing'],
      communication_disabled_until: 'tomorrow',
    });
    guild.guild.roles[1].permissions = ' 68608';
    delete guild.guild.channels[0].permission_overwrites;
    guild.guild.owner_id = 'opaque';
    await save();
    const loaded = await loadProjectConfiguration(root);
    assert.equal(loaded.resources.filter((r) => r.resourceType === 'member').length, 2);
    assert.equal(loaded.resources[2].permissions, ' 68608');
    assert.equal(loaded.resources[3].permission_overwrites, undefined);
  });
});

for (const invalid of [
  null,
  [],
  1,
  { version: 2, user: { id: '5000', bot: true } },
  { version: 1, user: null },
]) {
  test(`invalid bot envelope ${JSON.stringify(invalid)} fails`, async () => {
    await fixture(async ({ root }) => {
      await writeFile(join(root, 'fixtures/bot.json'), JSON.stringify(invalid));
      await assert.rejects(loadProjectConfiguration(root), { name: 'TypeError' });
    });
  });
}
for (const configuredPath of [
  '/tmp/bot.json',
  '../bot.json',
  'fixtures/escape.json',
  'fixtures',
  'fixtures/zero\0.json',
  'x'.repeat(4097),
]) {
  test(`bot fixture path boundary ${configuredPath.slice(0, 40)} fails`, async () => {
    await fixture(async ({ root, config, save }) => {
      await symlink(tmpdir(), join(root, 'fixtures/escape.json'));
      config.fixtures.bot = configuredPath;
      await save();
      await assert.rejects(loadProjectConfiguration(root));
    });
  });
}
test('internal bot fixture symlink is accepted and size bound is enforced', async () => {
  await fixture(async ({ root, config, save }) => {
    await symlink('bot.json', join(root, 'fixtures/inside.json'));
    config.fixtures.bot = 'fixtures/inside.json';
    await save();
    assert.equal((await loadProjectConfiguration(root)).botUserId, '5000');
    await writeFile(join(root, 'fixtures/bot.json'), ' '.repeat(8_388_609));
    await assert.rejects(loadProjectConfiguration(root), {
      name: 'TypeError',
      message: /8388608-byte limit/,
    });
  });
});
test('fixture import order exposes guild structural error before bot path error', async () => {
  await fixture(async ({ root, config, guild, save }) => {
    guild.guild.roles = null;
    config.fixtures.bot = 'not-present.json';
    await save();
    await assert.rejects(loadProjectConfiguration(root), {
      name: 'TypeError',
      message: /guild fixture roles must be an array/,
    });
  });
});
test('resourceType is authoritative and missing human never fabricates an actor', async () => {
  await fixture(async ({ root, config, bot, guild, save }) => {
    delete config.fixtures.user;
    bot.user.resourceType = 'role';
    guild.guild.members[0].resourceType = 'user';
    await save();
    const loaded = await loadProjectConfiguration(root);
    assert.equal(loaded.resources.at(-1).resourceType, 'user');
    assert.equal(loaded.resources[4].resourceType, 'member');
    const session = createSession();
    try {
      await session.selectProject(root);
      assert.deepEqual(session.snapshot().contexts, []);
    } finally {
      assert.equal((await session.dispose()).ok, true);
    }
  });
});
for (const [label, mutate, selectionFails] of [
  ['duplicate keys', ({ guild }) => guild.guild.members.push({ ...guild.guild.members[0] }), true],
  [
    'conflicting parent',
    ({ guild }) => {
      guild.guild.members[0].guild_id = 'other';
    },
    true,
  ],
  [
    'state resource capacity',
    ({ guild }) => {
      guild.guild.members = Array.from({ length: 10_001 }, (_, i) => ({ id: String(10000 + i) }));
    },
    false,
  ],
  [
    'state per-resource capacity',
    ({ bot }) => {
      bot.user.large = 'a'.repeat(1_048_576);
    },
    false,
  ],
]) {
  test(`${label} fails before any child or listener`, async () => {
    await fixture(async (f) => {
      mutate(f);
      await f.save();
      const session = createSession();
      const spawn = childProcess.spawn,
        listen = net.Server.prototype.listen;
      let spawns = 0,
        listeners = 0;
      childProcess.spawn = () => {
        spawns++;
        throw new Error('Forbidden child startup');
      };
      net.Server.prototype.listen = () => {
        listeners++;
        throw new Error('Forbidden listener startup');
      };
      syncBuiltinESMExports();
      try {
        if (selectionFails) await assert.rejects(session.selectProject(f.root));
        else {
          await session.selectProject(f.root);
          await assert.rejects(session.start());
        }
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
}
test('shipped JSON schema agrees with profile enum and bot pairing', async () => {
  const requireCore = createRequire(import.meta.resolve('@disrunner/core'));
  const Ajv2020 = requireCore('ajv/dist/2020.js').default;
  const schema = JSON.parse(
    await readFile(
      new URL('../../../docs/schemas/discord-simulator.config.schema.json', import.meta.url),
      'utf8',
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  await fixture(async ({ config }) => {
    assert.equal(validate(config), true);
    const noBot = structuredClone(config);
    delete noBot.fixtures.bot;
    assert.equal(validate(noBot), false);
    const legacy = structuredClone(config);
    legacy.profile.ordinaryMessagePermissions = 'legacy-unenforced';
    assert.equal(validate(legacy), false);
    delete legacy.fixtures.bot;
    assert.equal(validate(legacy), true);
    delete legacy.profile.ordinaryMessagePermissions;
    assert.equal(validate(legacy), true);
    for (const invalid of [null, 1, [], {}, 'unknown']) {
      legacy.profile.ordinaryMessagePermissions = invalid;
      assert.equal(validate(legacy), false);
    }
  });
});
