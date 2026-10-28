import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadProjectConfiguration } from '../dist/project-config.js';

import {
  emptyWorkspace,
  openWorkspace,
  parseWorkspace,
  recoverWorkspace,
  saveWorkspace,
} from '../dist/workspace.js';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'DisRunner 工作區 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function project() {
  return {
    ...emptyWorkspace(),
    resources: [
      { resourceType: 'guild', id: '1000', name: 'Local guild' },
      { resourceType: 'channel', id: '2000', guild_id: '1000', type: 0, name: 'general' },
      { resourceType: 'channel', id: '2001', type: 1, recipients: [{ id: '3000' }] },
      { resourceType: 'user', id: '3000', username: 'Developer' },
      { resourceType: 'role', id: '4000', guild_id: '1000', permissions: '68608' },
      { resourceType: 'member', id: '5000', guild_id: '1000', user_id: '3000', roles: ['4000'] },
      {
        resourceType: 'message',
        id: '6000',
        channel_id: '2000',
        guild_id: '1000',
        author: { id: '3000' },
        content: 'Hello',
      },
    ],
    scenarios: [
      { name: 'Model case', format: 'json', source: '{"version":1,"name":"test","steps":[]}' },
      { name: 'Bot case', format: 'yaml', source: 'version: 2\nexecution:\n  kind: bot\n' },
    ],
  };
}

test('a saved project reopens with resources, both scenario formats and options intact', async (t) => {
  const root = await workspace(t);
  const initial = await openWorkspace(root);
  assert.equal(initial.status, 'missing');
  assert.equal(initial.hash, null);
  assert.equal(initial.document, null);
  const data = project();
  data.options = { seed: 123456, mode: 'lenient' };
  const saved = await saveWorkspace(root, data, { expectedHash: null });
  assert.equal(saved.status, 'ready');
  assert.equal(saved.backupAvailable, false);
  assert.deepEqual((await openWorkspace(root)).document, data);
  assert.equal((await openWorkspace(root)).hash, saved.hash);
  assert.equal((await lstat(saved.path)).isFile(), true);
  if (process.platform !== 'win32') assert.equal((await lstat(saved.path)).mode & 0o777, 0o600);
});

test('original raw-webhook fixtures save unchanged, including inert voice/category placeholders', async (t) => {
  const root = await workspace(t);
  const example = fileURLToPath(new URL('../../../examples/raw-webhook-bot/', import.meta.url));
  const configuration = await loadProjectConfiguration(example);
  assert.ok(
    configuration.resources.some(
      (resource) => resource.resourceType === 'channel' && resource.type === 2,
    ),
  );
  const document = {
    ...emptyWorkspace(),
    resources: configuration.resources,
    options: { seed: configuration.profile.seed, mode: configuration.profile.mode },
  };
  await saveWorkspace(root, document, { expectedHash: null });
  assert.deepEqual((await openWorkspace(root)).document, document);
  const category = {
    resourceType: 'channel',
    id: '2300',
    guild_id: '1000',
    type: 4,
    name: 'Development',
  };
  assert.deepEqual(
    parseWorkspace({ ...document, resources: [...document.resources, category] }).resources.at(-1),
    category,
  );
  assert.throws(
    () =>
      parseWorkspace({
        ...document,
        resources: [...document.resources, { ...category, guild_id: '9999' }],
      }),
    { code: 'invalid' },
  );
});

test('save requires the opened hash and an external edit survives a stale save', async (t) => {
  const root = await workspace(t);
  const saved = await saveWorkspace(root, project(), { expectedHash: null });
  const external = { ...project(), options: { seed: 91, mode: 'strict' } };
  const externalBytes = JSON.stringify(external);
  await writeFile(saved.path, externalBytes);
  await assert.rejects(saveWorkspace(root, emptyWorkspace(), { expectedHash: saved.hash }), {
    code: 'conflict',
  });
  assert.equal(await readFile(saved.path, 'utf8'), externalBytes);
  await assert.rejects(saveWorkspace(root, emptyWorkspace(), {}), { code: 'invalid' });
  assert.equal((await openWorkspace(root)).document.options.seed, 91);
});

test('concurrent writers cannot silently overwrite one another', async (t) => {
  const root = await workspace(t);
  const saved = await saveWorkspace(root, project(), { expectedHash: null });
  const a = { ...project(), options: { seed: 1, mode: 'strict' } };
  const b = { ...project(), options: { seed: 2, mode: 'strict' } };
  const outcomes = await Promise.allSettled([
    saveWorkspace(root, a, { expectedHash: saved.hash }),
    saveWorkspace(root, b, { expectedHash: saved.hash }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.ok(['busy', 'conflict'].includes(rejected.reason.code));
  const reopened = await openWorkspace(root);
  assert.ok([1, 2].includes(reopened.document.options.seed));
  assert.equal(reopened.backupAvailable, true);
  assert.equal(
    JSON.parse(await readFile(join(root, '.disrunner/workspace.backup.json'), 'utf8')).options.seed,
    42,
  );
});

test('explicit recovery restores the last valid version and preserves damaged bytes', async (t) => {
  const root = await workspace(t);
  const first = await saveWorkspace(root, project(), { expectedHash: null });
  await saveWorkspace(root, emptyWorkspace(), { expectedHash: first.hash });
  const damaged = Buffer.from([0xff, 0xfe, 0x7b, 0x22]);
  await writeFile(first.path, damaged);
  const observed = await openWorkspace(root);
  assert.equal(observed.status, 'corrupt');
  assert.equal(observed.backupAvailable, true);
  assert.equal(observed.hash, createHash('sha256').update(damaged).digest('hex'));
  assert.deepEqual(await readFile(first.path), damaged, 'opening never recovers automatically');
  await assert.rejects(saveWorkspace(root, project(), { expectedHash: observed.hash }), {
    code: 'invalid',
  });
  const recovered = await recoverWorkspace(root, { expectedHash: observed.hash });
  assert.deepEqual(recovered.document, project());
  assert.deepEqual(await readFile(join(root, '.disrunner/workspace.displaced.json')), damaged);
  assert.deepEqual((await openWorkspace(root)).document, project());
});

test('recovery refuses an intervening edit and an invalid backup', async (t) => {
  const root = await workspace(t);
  const first = await saveWorkspace(root, project(), { expectedHash: null });
  const second = await saveWorkspace(root, emptyWorkspace(), { expectedHash: first.hash });
  await writeFile(second.path, '{broken');
  await assert.rejects(recoverWorkspace(root, { expectedHash: second.hash }), { code: 'conflict' });
  await writeFile(join(root, '.disrunner/workspace.backup.json'), '{also broken');
  const observed = await openWorkspace(root);
  assert.equal(observed.backupAvailable, false);
  await assert.rejects(recoverWorkspace(root, { expectedHash: observed.hash }));
  assert.equal(await readFile(second.path, 'utf8'), '{broken');
});

test('future workspace versions cannot be saved or recovered over', async (t) => {
  const root = await workspace(t);
  const first = await saveWorkspace(root, project(), { expectedHash: null });
  await saveWorkspace(root, emptyWorkspace(), { expectedHash: first.hash });
  const futureBytes = JSON.stringify({ version: 99, futureData: 'Must survive' });
  await writeFile(first.path, futureBytes);
  const observed = await openWorkspace(root);
  assert.equal(observed.status, 'future');
  assert.equal(observed.version, 99);
  assert.equal(observed.document, null);
  assert.equal(observed.backupAvailable, true);
  await assert.rejects(saveWorkspace(root, project(), { expectedHash: observed.hash }), {
    code: 'future-version',
  });
  await assert.rejects(recoverWorkspace(root, { expectedHash: observed.hash }), {
    code: 'future-version',
  });
  assert.equal(await readFile(first.path, 'utf8'), futureBytes);
});

test('a failed backup write keeps the original workspace unchanged', async (t) => {
  const root = await workspace(t);
  const saved = await saveWorkspace(root, project(), { expectedHash: null });
  const original = await readFile(saved.path);
  await mkdir(join(root, '.disrunner/workspace.backup.json'));
  await assert.rejects(saveWorkspace(root, emptyWorkspace(), { expectedHash: saved.hash }), {
    code: 'unsafe-path',
  });
  assert.deepEqual(await readFile(saved.path), original);
});

test('a prior lock blocks saving without removing or replacing it', async (t) => {
  const root = await workspace(t);
  const saved = await saveWorkspace(root, project(), { expectedHash: null });
  const lockPath = join(root, '.disrunner/workspace.lock');
  const lockBytes = '{"pid":1234,"host":"other-instance"}';
  await writeFile(lockPath, lockBytes);
  await assert.rejects(saveWorkspace(root, emptyWorkspace(), { expectedHash: saved.hash }), {
    code: 'busy',
  });
  assert.equal(await readFile(lockPath, 'utf8'), lockBytes);
  assert.deepEqual((await openWorkspace(root)).document, project());
});

test(
  'symlinked workspace directories and files never write outside the project',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await workspace(t);
    const outside = await workspace(t);
    await writeFile(join(outside, 'workspace.json'), 'unchanged');
    await symlink(outside, join(root, '.disrunner'), 'dir');
    await assert.rejects(saveWorkspace(root, project(), { expectedHash: null }), {
      code: 'unsafe-path',
    });
    await assert.rejects(openWorkspace(root), { code: 'unsafe-path' });
    assert.equal(await readFile(join(outside, 'workspace.json'), 'utf8'), 'unchanged');
    await rm(join(root, '.disrunner'));
    await mkdir(join(root, '.disrunner'));
    await symlink(join(outside, 'workspace.json'), join(root, '.disrunner/workspace.json'));
    await assert.rejects(saveWorkspace(root, project(), { expectedHash: null }), {
      code: 'unsafe-path',
    });
    assert.equal(await readFile(join(outside, 'workspace.json'), 'utf8'), 'unchanged');
  },
);

test('size limits reject oversized stored files and scenario sources', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, '.disrunner'));
  await writeFile(join(root, '.disrunner/workspace.json'), Buffer.alloc(8 * 1_048_576 + 1, 32));
  await assert.rejects(openWorkspace(root), { code: 'invalid' });
  const data = project();
  data.scenarios[0].source = 'x'.repeat(262_145);
  assert.throws(() => parseWorkspace(data), { code: 'invalid' });
});

test('strict validation rejects unknown schema fields without invoking accessors', () => {
  assert.throws(() => parseWorkspace({ ...project(), extra: true }), { code: 'invalid' });
  assert.throws(
    () => parseWorkspace({ ...project(), options: { seed: 1, mode: 'strict', ignored: true } }),
    { code: 'invalid' },
  );
  let read = false;
  const value = project();
  Object.defineProperty(value, 'version', {
    get() {
      read = true;
      throw new Error('Must not run');
    },
    enumerable: true,
  });
  assert.throws(() => parseWorkspace(value), { code: 'invalid' });
  assert.equal(read, false);
});

test('resource extension payloads round trip while invalid relations are rejected', () => {
  const data = project();
  data.resources[0].extensions = { local: { description: 'Custom fixture information' } };
  const parsed = parseWorkspace(data);
  assert.deepEqual(parsed, data);
  data.resources[0].extensions.local.description = 'Changed outside parser';
  assert.equal(parsed.resources[0].extensions.local.description, 'Custom fixture information');
  for (const mutate of [
    (d) => {
      d.resources.push({ ...d.resources[0] });
    },
    (d) => {
      d.resources[1].guild_id = '9999';
    },
    (d) => {
      d.resources[4].permissions = 68608;
    },
    (d) => {
      d.resources[5].roles = ['9999'];
    },
    (d) => {
      d.resources[5].user_id = '9999';
    },
    (d) => {
      d.resources[6].channel_id = '9999';
    },
    (d) => {
      d.resources[6].guild_id = '9999';
    },
    (d) => {
      d.resources[2].guild_id = '1000';
    },
    (d) => {
      d.resources[1].id = '../outside';
    },
    (d) => {
      d.resources[6].attachments = [{ path: '../outside.txt' }];
    },
    (d) => {
      d.resources[6].attachments = [{ path: 'C:\\outside.txt' }];
    },
    (d) => {
      d.resources[5].user = { id: '9999' };
    },
    (d) => {
      d.resources[2].recipients = [{ id: '9999' }];
    },
  ]) {
    const fixture = project();
    mutate(fixture);
    assert.throws(() => parseWorkspace(fixture), { code: 'invalid' });
  }
});

test('cross-guild roles and overwrites cannot silently alter authorization', () => {
  const data = project();
  data.resources.push({ resourceType: 'guild', id: '1001' });
  data.resources[4].guild_id = '1001';
  assert.throws(() => parseWorkspace(data), { code: 'invalid' });
  const overwrites = project();
  overwrites.resources[1].permission_overwrites = [{ id: '9999', type: 0, allow: '0', deny: '0' }];
  assert.throws(() => parseWorkspace(overwrites), { code: 'invalid' });
});

test('runtime credentials and private keys are rejected instead of persisted or silently changed', () => {
  for (const modify of [
    (d) => {
      d.resources[0].token = 'example';
    },
    (d) => {
      d.resources[6].content = `disrunner.offline.${'x'.repeat(32)}`;
    },
    (d) => {
      d.scenarios[0].source = '-----BEGIN PRIVATE KEY-----';
    },
  ]) {
    const data = project();
    modify(data);
    assert.throws(() => parseWorkspace(data), { code: 'invalid' });
  }
});
