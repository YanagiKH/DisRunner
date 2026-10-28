import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertAppImageLauncher,
  assertLinuxSandboxEvidence,
  requireLinuxNonRoot,
} from './linux-sandbox.mjs';

const launcher = new URL('../../build/linux/AppRun', import.meta.url);
const oracle = fileURLToPath(new URL('./linux-sandbox.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner AppRun 測試 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(launcher, path.join(directory, 'AppRun'));
  await chmod(path.join(directory, 'AppRun'), 0o755);
  await writeFile(
    path.join(directory, 'disrunner'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.APP_RUN_RESULT, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  appdir: process.env.APPDIR,
  path: process.env.PATH,
  data: process.env.XDG_DATA_DIRS,
  libraries: process.env.LD_LIBRARY_PATH,
  schemas: process.env.GSETTINGS_SCHEMA_DIR,
}));
process.exit(Number(process.env.APP_RUN_EXIT_CODE ?? '0'));
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(directory, 'unshare'),
    '#!/usr/bin/env bash\nprintf called > "$APPDIR/unshare-called"\nexit 1\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(directory, 'disrunner.desktop'),
    '[Desktop Entry]\nType=Application\nName=DisRunner\nExec=AppRun %U\n',
  );
  return directory;
}

function launch(directory, args, extraEnvironment = {}, entry = path.join(directory, 'AppRun')) {
  const env = {
    ...process.env,
    APP_RUN_RESULT: path.join(directory, 'result.json'),
    XDG_DATA_DIRS: '/existing/data',
    LD_LIBRARY_PATH: '/existing/lib',
    GSETTINGS_SCHEMA_DIR: '/existing/schemas',
    ...extraEnvironment,
  };
  if (!Object.hasOwn(extraEnvironment, 'APPDIR')) delete env.APPDIR;
  return spawnSync(entry, args, { env, encoding: 'utf8', timeout: 5000 });
}

test(
  'controlled launcher preserves exact arguments and AppDir environment without a sandbox fallback',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await fixture(t);
    const args = [
      '--remote-debugging-port=0',
      '--user-data-dir=path with spaces/測試',
      '',
      '$(literal)',
      '$HOME',
    ];
    const child = launch(directory, args);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.deepEqual(
      result.args,
      args,
      'No sandbox-disabling argument may be added when unshare fails',
    );
    assert.equal(
      result.pid,
      child.pid,
      'AppRun must exec the application rather than leave a shell parent',
    );
    assert.equal(result.appdir, directory);
    assert.ok(result.path.startsWith(`${directory}:${directory}/usr/sbin:`));
    assert.equal(
      result.data,
      `${directory}/usr/share:/existing/data:/usr/share/gnome:/usr/local/share:/usr/share`,
    );
    assert.equal(result.libraries, `${directory}/usr/lib:/existing/lib`);
    assert.equal(result.schemas, `${directory}/usr/share/glib-2.0/schemas:/existing/schemas`);
    await assert.rejects(lstat(path.join(directory, 'unshare-called')), { code: 'ENOENT' });
  },
);

test(
  'launcher honors AppImage APPDIR, resolves a symlink entry and propagates application failure',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await fixture(t);
    const linkDirectory = path.join(directory, 'links');
    await mkdir(linkDirectory);
    const linkedEntry = path.join(linkDirectory, 'launch');
    await symlink(path.join(directory, 'AppRun'), linkedEntry);
    assert.equal(launch(directory, ['symlink'], {}, linkedEntry).status, 0);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).appdir,
      directory,
    );
    const child = launch(directory, ['original'], { APPDIR: directory, APP_RUN_EXIT_CODE: '73' });
    assert.equal(child.status, 73, child.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')).args, [
      'original',
    ]);
  },
);

test(
  'actual AppImage launcher oracle rejects generated fallback bytes, unsafe desktop arguments and wrong modes',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await fixture(t);
    const accepted = await assertAppImageLauncher(directory);
    assert.equal(accepted.status, 'passed');
    assert.equal(accepted.appRunSha256, accepted.controlledAppRunSha256);
    assert.equal(accepted.desktopExec, 'AppRun %U');
    await writeFile(
      path.join(directory, 'AppRun'),
      '#!/bin/sh\nexec ./disrunner --no-sandbox "$@"\n',
    );
    await assert.rejects(
      assertAppImageLauncher(directory),
      /exactly match the controlled launcher/u,
    );
    await copyFile(launcher, path.join(directory, 'AppRun'));
    for (const flag of ['--no-sandbox', '--disable-setuid-sandbox']) {
      await writeFile(
        path.join(directory, 'disrunner.desktop'),
        `[Desktop Entry]\nExec=AppRun ${flag} %U\n`,
      );
      await assert.rejects(assertAppImageLauncher(directory), /without sandbox-disable arguments/u);
    }
    await writeFile(path.join(directory, 'disrunner.desktop'), '[Desktop Entry]\nExec=AppRun %U\n');
    await chmod(path.join(directory, 'AppRun'), 0o644);
    await assert.rejects(assertAppImageLauncher(directory), /mode 0755/u);
  },
);

test(
  'artifact validation rejects symlink entry files even when their targets contain valid bytes',
  { skip: process.platform !== 'linux' },
  async (t) => {
    for (const name of ['AppRun', 'disrunner.desktop']) {
      const directory = await fixture(t);
      await assertAppImageLauncher(directory);
      const filename = path.join(directory, name);
      const target = path.join(directory, 'valid-target');
      await copyFile(filename, target);
      await rm(filename);
      await symlink(target, filename);
      await assert.rejects(assertAppImageLauncher(directory), undefined, name);
    }
  },
);

test(
  'artifact validation rejects nonregular and oversized entries without blocking on a FIFO',
  { skip: process.platform !== 'linux' },
  async (t) => {
    for (const name of ['AppRun', 'disrunner.desktop']) {
      for (const kind of ['directory', 'fifo', 'oversized']) {
        const directory = await fixture(t);
        await assertAppImageLauncher(directory);
        const filename = path.join(directory, name);
        const maximum = name === 'AppRun' ? (await readFile(launcher)).length : 64 * 1024;
        await rm(filename);
        if (kind === 'directory') await mkdir(filename);
        else if (kind === 'fifo') {
          const created = spawnSync('mkfifo', [filename]);
          assert.equal(created.status, 0);
        } else {
          await writeFile(filename, Buffer.alloc(maximum + 1), { mode: 0o755 });
        }
        const child = spawnSync(process.execPath, [oracle, directory], {
          encoding: 'utf8',
          timeout: 2000,
        });
        assert.equal(child.error, undefined, `${name}/${kind} must terminate normally`);
        assert.equal(child.signal, null);
        assert.equal(child.status, 1, `${name}/${kind} must fail validation`);
        assert.match(child.stderr, /regular file|artifact size/u);
      }
    }
  },
);

function evidence({ mainFilters = 1, rendererFilters = 2, isolated = true } = {}) {
  const namespaces = { user: 'user:[1]', pid: 'pid:[2]', mnt: 'mnt:[3]', net: 'net:[4]' };
  return {
    platform: 'linux',
    main: {
      pid: 2000,
      uid: [1000, 1000, 1000, 1000],
      argv: ['/app/disrunner', '--remote-debugging-port=0'],
      seccomp: 2,
      seccompFilters: mainFilters,
      namespaces: { ...namespaces },
    },
    renderers: [
      {
        pid: 2002,
        ancestors: [2001, 2000],
        uid: [1000, 1000, 1000, 1000],
        argv: ['/app/disrunner', '--type=renderer'],
        noNewPrivs: 1,
        capEff: '0000000000000000',
        seccomp: 2,
        seccompFilters: rendererFilters,
        namespaces: { ...namespaces, ...(isolated ? { pid: 'pid:[5]' } : {}) },
        namespaceReadErrors: {},
      },
    ],
  };
}

test('sandbox evidence proves additional renderer protection beyond inherited container seccomp', () => {
  const proof = assertLinuxSandboxEvidence(evidence())[0];
  assert.equal(proof.additionalSeccompFilters, true);
  assert.deepEqual(proof.isolatedNamespaces, ['pid']);
  const oldKernel = assertLinuxSandboxEvidence(
    evidence({ mainFilters: null, rendererFilters: null }),
  )[0];
  assert.equal(oldKernel.additionalSeccompFilters, null);
  assert.deepEqual(oldKernel.isolatedNamespaces, ['pid']);
  const restrictedProc = evidence();
  restrictedProc.renderers[0].namespaces = { user: null, pid: null, mnt: null, net: null };
  restrictedProc.renderers[0].namespaceReadErrors = {
    user: 'EACCES',
    pid: 'EACCES',
    mnt: 'EACCES',
    net: 'EACCES',
  };
  assert.equal(assertLinuxSandboxEvidence(restrictedProc)[0].additionalSeccompFilters, true);
});

test('sandbox evidence handles Chromium process-title arguments without losing switch boundaries', () => {
  const rewritten = evidence();
  rewritten.renderers[0].argv = ['/app/disrunner --type=renderer --enable-sandbox --lang=en-US'];
  assert.equal(assertLinuxSandboxEvidence(rewritten)[0].additionalSeccompFilters, true);
  for (const title of [
    '/app/disrunner --type=renderer-extra --enable-sandbox',
    '/app/disrunner --other=--type=renderer --enable-sandbox',
  ]) {
    const invalid = evidence();
    invalid.renderers[0].argv = [title];
    assert.throws(() => assertLinuxSandboxEvidence(invalid), /actual Chromium renderer/u);
  }
});

test('sandbox oracle rejects inherited-only seccomp, disabled protection, root and unrelated renderer PIDs', () => {
  assert.throws(
    () => assertLinuxSandboxEvidence(evidence({ rendererFilters: 1 })),
    /beyond filters inherited/u,
  );
  assert.throws(
    () =>
      assertLinuxSandboxEvidence(
        evidence({ mainFilters: null, rendererFilters: null, isolated: false }),
      ),
    /Inherited host\/container seccomp alone/u,
  );
  for (const [field, value] of [
    ['noNewPrivs', 0],
    ['capEff', '0000000000000001'],
    ['seccomp', 0],
    ['uid', [0, 0, 0, 0]],
    ['ancestors', [1]],
  ]) {
    const invalid = evidence();
    invalid.renderers[0][field] = value;
    assert.throws(() => assertLinuxSandboxEvidence(invalid), field);
  }
  for (const argument of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-seccomp-filter-sandbox',
    '--disable-namespace-sandbox',
    '--no-zygote-sandbox',
  ]) {
    for (const target of ['main', 'renderer']) {
      for (const rewritten of [false, true]) {
        const invalid = evidence();
        const record = target === 'main' ? invalid.main : invalid.renderers[0];
        record.argv.push(argument);
        if (rewritten) record.argv = [record.argv.join(' ')];
        assert.throws(() => assertLinuxSandboxEvidence(invalid), /must not disable/u);
      }
    }
  }
  const noRenderer = evidence();
  noRenderer.renderers = [];
  assert.throws(() => assertLinuxSandboxEvidence(noRenderer), /loaded application renderer/u);
});

test('strict Linux acceptance rejects root before launching rather than adding a disabling flag', () => {
  requireLinuxNonRoot({ platform: 'linux', uid: 1000, euid: 1000 });
  for (const [uid, euid] of [
    [0, 0],
    [1000, 0],
    [0, 1000],
  ])
    assert.throws(
      () => requireLinuxNonRoot({ platform: 'linux', uid, euid }),
      /requires a non-root user/u,
    );
  requireLinuxNonRoot({ platform: 'win32', uid: undefined, euid: undefined });
});
