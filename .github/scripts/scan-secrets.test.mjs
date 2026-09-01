#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url));

test('accepts a canonical root with framework-style internal symlinks without rescanning', async (context) => {
  const workspace = await createWorkspace(context);
  const payload = path.join(workspace, 'payload');
  const framework = path.join(payload, 'DisRunner Framework.framework');
  const version = path.join(framework, 'Versions', 'A');
  const resources = path.join(version, 'Resources');
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, 'Info.plist'), 'synthetic framework fixture\n', 'utf8');

  await createDirectoryLink(version, path.join(framework, 'Versions', 'Current'), 'A');
  await createDirectoryLink(
    resources,
    path.join(framework, 'Resources'),
    path.join('Versions', 'Current', 'Resources'),
  );
  await createDirectoryLink(framework, path.join(version, 'Loop'), path.join('..', '..'));

  const rootLink = path.join(workspace, 'scan-root');
  await createDirectoryLink(payload, rootLink, 'payload');

  const result = runScanner(rootLink);
  assert.equal(result.status, 0, diagnostic(result));
  assert.match(
    result.stdout,
    /Credential scan passed: 1 files, \d+ bytes, 3 internal symlinks skipped\./u,
  );
});

test('fails closed when a symlink resolves outside its canonical scan root', async (context) => {
  const workspace = await createWorkspace(context);
  const scanRoot = path.join(workspace, 'scan-root');
  const outside = path.join(workspace, 'outside');
  await mkdir(scanRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(scanRoot, 'safe.txt'), 'synthetic safe fixture\n', 'utf8');
  await writeFile(path.join(outside, 'outside.txt'), 'outside root\n', 'utf8');
  await createDirectoryLink(outside, path.join(scanRoot, 'Escape.framework'), '../outside');

  const result = runScanner(scanRoot);
  assert.notEqual(result.status, 0, diagnostic(result));
  assert.match(result.stderr, /Symbolic link escapes canonical scan root:/u);
  assert.doesNotMatch(result.stdout, /Credential scan passed/u);
});

test('rejects production-shaped Discord tokens and uppercase secret assignments', async (context) => {
  const workspace = await createWorkspace(context);
  const scanRoot = path.join(workspace, 'scan-root');
  await mkdir(scanRoot, { recursive: true });

  const snowflakeSegment = Buffer.from('123456789012345678', 'ascii').toString('base64url');
  const timestampSegment = Buffer.from([0, 0, 0, 1]).toString('base64url');
  const syntheticToken = `${snowflakeSegment}.${timestampSegment}.${'x'.repeat(24)}`;
  const syntheticAssignment = `PASSWORD=${'y'.repeat(24)}`;
  await writeFile(
    path.join(scanRoot, 'credentials.txt'),
    `${syntheticToken}\n${syntheticAssignment}\n`,
    'utf8',
  );

  const result = runScanner(scanRoot);
  assert.notEqual(result.status, 0, diagnostic(result));
  assert.match(result.stderr, /\[Discord token, secret assignment\]/u);
  assert.equal(result.stderr.includes(syntheticToken), false);
  assert.equal(result.stderr.includes(syntheticAssignment), false);
});

test('accepts non-semantic token-shaped binary runs and lowercase property assignments', async (context) => {
  const workspace = await createWorkspace(context);
  const scanRoot = path.join(workspace, 'scan-root');
  await mkdir(scanRoot, { recursive: true });

  const randomBinaryRun = `${'a'.repeat(21)}.${'b'.repeat(6)}.${'c'.repeat(23)}`;
  await writeFile(
    path.join(scanRoot, 'native-binary-fixture.bin'),
    Buffer.from(`\0${randomBinaryRun}\0password=ordinaryIdentifier\0`, 'latin1'),
  );

  const result = runScanner(scanRoot);
  assert.equal(result.status, 0, diagnostic(result));
  assert.match(result.stdout, /Credential scan passed:/u);
});

function runScanner(root) {
  return spawnSync(process.execPath, [scanner, root], {
    cwd: path.dirname(scanner),
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function createDirectoryLink(target, link, relativeTarget) {
  await symlink(
    process.platform === 'win32' ? target : relativeTarget,
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

async function createWorkspace(context) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'disrunner-secret-scanner-'));
  context.after(async () => {
    const canonicalTemp = await realpath(tmpdir());
    const canonicalWorkspace = await realpath(workspace);
    const relative = path.relative(canonicalTemp, canonicalWorkspace);
    assert.ok(
      relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      `Refusing to remove unexpected test path: ${canonicalWorkspace}`,
    );
    await rm(canonicalWorkspace, { recursive: true, force: true });
  });
  return workspace;
}

function diagnostic(result) {
  return `status=${String(result.status)} signal=${String(result.signal)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}
