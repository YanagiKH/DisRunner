import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const namespaceNames = ['user', 'pid', 'mnt', 'net'];
const controlledLauncher = new URL('../../build/linux/AppRun', import.meta.url);
const sandboxDisableArgument =
  /(?:^|[\s\0])--(?:no-sandbox|no-zygote-sandbox|disable-(?:[a-z-]*-)?sandbox)(?=[=\s\0]|$)/u;

export function requireLinuxNonRoot({
  platform = process.platform,
  uid = process.getuid?.(),
  euid = process.geteuid?.(),
} = {}) {
  if (platform !== 'linux') return;
  assert.ok(
    Number.isInteger(uid) && uid > 0 && Number.isInteger(euid) && euid > 0,
    'Linux packaged acceptance requires a non-root user and an available OS sandbox.',
  );
}

function assertProcessIdentity(record, description) {
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0, `${description}: invalid PID`);
  assert.ok(
    Array.isArray(record.uid) &&
      record.uid.length === 4 &&
      record.uid.every((id) => Number.isSafeInteger(id) && id > 0),
    `${description}: process must have non-root real, effective, saved and filesystem UIDs`,
  );
  assert.ok(record.argv.length > 0, `${description}: actual process arguments are required`);
  assert.equal(
    sandboxDisableArgument.test(record.argv.join('\0')),
    false,
    `${description}: actual process arguments must not disable the sandbox`,
  );
}

export function assertLinuxSandboxEvidence(evidence) {
  assert.equal(evidence.platform, 'linux');
  assertProcessIdentity(evidence.main, 'Browser main process');
  assert.ok(evidence.renderers.length > 0, 'A loaded application renderer must be observed');
  return evidence.renderers.map((renderer) => {
    assertProcessIdentity(renderer, 'Application renderer');
    assert.notEqual(renderer.pid, evidence.main.pid, 'Renderer must be a separate OS process');
    assert.ok(
      /(?:^|[\s\0])--type=renderer(?=[\s\0]|$)/u.test(renderer.argv.join('\0')),
      'Observed renderer PID must identify an actual Chromium renderer',
    );
    assert.equal(
      renderer.ancestors.at(-1),
      evidence.main.pid,
      'Observed renderer must belong to the launched application process tree',
    );
    assert.equal(renderer.noNewPrivs, 1, 'Renderer must enable NoNewPrivs');
    assert.match(renderer.capEff, /^[0-9a-f]+$/iu);
    assert.equal(
      BigInt(`0x${renderer.capEff}`),
      0n,
      'Renderer must have no effective capabilities',
    );
    assert.equal(renderer.seccomp, 2, 'Renderer must use a seccomp filter');
    const isolatedNamespaces = namespaceNames.filter(
      (name) =>
        renderer.namespaces[name] !== null &&
        evidence.main.namespaces[name] !== null &&
        renderer.namespaces[name] !== evidence.main.namespaces[name],
    );
    for (const count of [evidence.main.seccompFilters, renderer.seccompFilters])
      assert.ok(
        count === null || (Number.isSafeInteger(count) && count >= 0),
        'Seccomp filter counts must be non-negative integers or explicitly unavailable',
      );
    const filterCountsAvailable =
      Number.isInteger(evidence.main.seccompFilters) && Number.isInteger(renderer.seccompFilters);
    const additionalSeccompFilters = filterCountsAvailable
      ? renderer.seccompFilters > evidence.main.seccompFilters
      : null;
    if (filterCountsAvailable)
      assert.equal(
        additionalSeccompFilters,
        true,
        'Renderer must add seccomp filters beyond filters inherited by the browser main process',
      );
    assert.ok(
      additionalSeccompFilters === true || isolatedNamespaces.length > 0,
      'Inherited host/container seccomp alone is insufficient: additional renderer sandbox evidence is required',
    );
    return {
      pid: renderer.pid,
      mainSeccompFilters: evidence.main.seccompFilters,
      rendererSeccompFilters: renderer.seccompFilters,
      additionalSeccompFilters,
      isolatedNamespaces,
      namespaceReadErrors: renderer.namespaceReadErrors,
    };
  });
}

async function readProcess(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'A valid OS process PID is required');
  const directory = `/proc/${pid}`;
  const status = Object.fromEntries(
    (await readFile(path.join(directory, 'status'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  );
  assert.equal(Number(status.Pid), pid, 'Observed process identity must match its /proc entry');
  const namespaces = {};
  const namespaceReadErrors = {};
  for (const name of namespaceNames) {
    try {
      namespaces[name] = await readlink(path.join(directory, 'ns', name));
    } catch (error) {
      namespaces[name] = null;
      namespaceReadErrors[name] = error.code ?? error.name;
    }
  }
  return {
    pid,
    ppid: Number(status.PPid),
    uid: (status.Uid ?? '').split(/\s+/u).map(Number),
    argv: (await readFile(path.join(directory, 'cmdline'), 'utf8')).split('\0').filter(Boolean),
    noNewPrivs: Number(status.NoNewPrivs),
    capEff: status.CapEff ?? '',
    seccomp: Number(status.Seccomp),
    seccompFilters: status.Seccomp_filters === undefined ? null : Number(status.Seccomp_filters),
    namespaces,
    namespaceReadErrors,
  };
}

async function rendererAncestors(renderer, mainPid) {
  const ancestors = [];
  let next = renderer.ppid;
  while (next > 1 && ancestors.length < 16 && !ancestors.includes(next)) {
    ancestors.push(next);
    if (next === mainPid) return ancestors;
    const status = await readFile(`/proc/${next}/status`, 'utf8');
    next = Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]);
  }
  return ancestors;
}

async function writeEvidence(filename, evidence) {
  if (filename === undefined) return;
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(evidence, null, 2)}\n`);
}

export async function captureLinuxSandbox({ mainPid, browser, rendererPids, evidencePath }) {
  if (process.platform !== 'linux') return null;
  requireLinuxNonRoot();
  const evidence = {
    schemaVersion: 1,
    platform: 'linux',
    architecture: process.arch,
    osRelease: release(),
    observedAt: new Date().toISOString(),
    status: 'failed',
    main: null,
    renderers: [],
    note: 'OS process evidence collected after the application page loaded; BrowserWindow preferences alone are not sandbox evidence.',
  };
  try {
    if (rendererPids === undefined) {
      assert.ok(browser, 'Browser CDP access or explicit renderer OS PIDs are required');
      const session = await browser.newBrowserCDPSession();
      try {
        const { processInfo } = await session.send('SystemInfo.getProcessInfo');
        assert.equal(
          Number(processInfo.find((record) => record.type === 'browser')?.id),
          mainPid,
          'CDP browser process must match the launched application PID',
        );
        rendererPids = processInfo
          .filter((record) => record.type === 'renderer')
          .map((record) => Number(record.id));
      } finally {
        await session.detach();
      }
    }
    evidence.main = await readProcess(mainPid);
    for (const pid of new Set(rendererPids)) {
      const renderer = await readProcess(pid);
      renderer.ancestors = await rendererAncestors(renderer, mainPid);
      evidence.renderers.push(renderer);
    }
    evidence.proofs = assertLinuxSandboxEvidence(evidence);
    evidence.status = 'passed';
    return evidence;
  } catch (error) {
    evidence.error = error.message;
    throw error;
  } finally {
    await writeEvidence(evidencePath, evidence);
  }
}

export async function packagedExecutablePath(launchEntry) {
  return process.platform === 'linux' && path.basename(launchEntry) === 'AppRun'
    ? path.join(path.dirname(launchEntry), 'disrunner')
    : launchEntry;
}

async function readArtifactFile(filename, maximumBytes, expectedMode) {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile(), 'AppImage entry must be a regular file');
    assert.ok(before.size > 0n && before.size <= BigInt(maximumBytes), 'Invalid artifact size');
    if (expectedMode !== undefined)
      assert.equal(
        Number(before.mode & 0o7777n),
        expectedMode,
        'AppImage AppRun must have mode 0755',
      );
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    assert.ok(length <= maximumBytes, 'Invalid artifact size');
    assert.equal(BigInt(length), before.size, 'Artifact changed during its bounded read');
    const after = await file.stat({ bigint: true });
    for (const field of ['size', 'mode', 'mtimeNs', 'ctimeNs'])
      assert.equal(after[field], before[field], 'Artifact changed during its bounded read');
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function assertAppImageLauncher(appDirectory) {
  const appRun = path.join(appDirectory, 'AppRun');
  const expected = await readFile(controlledLauncher);
  const actual = await readArtifactFile(appRun, expected.length, 0o755);
  assert.deepEqual(
    actual,
    expected,
    'Actual AppImage AppRun must exactly match the controlled launcher',
  );
  const desktopFiles = (await readdir(appDirectory)).filter((name) => name.endsWith('.desktop'));
  assert.equal(desktopFiles.length, 1, 'AppImage must contain one desktop entry');
  const desktopBytes = await readArtifactFile(path.join(appDirectory, desktopFiles[0]), 64 * 1024);
  const desktop = desktopBytes.toString('utf8');
  const execLines = desktop.split(/\r?\n/u).filter((line) => line.startsWith('Exec='));
  assert.deepEqual(
    execLines,
    ['Exec=AppRun %U'],
    'AppImage desktop entry must use the controlled AppRun without sandbox-disable arguments',
  );
  return {
    schemaVersion: 1,
    status: 'passed',
    appDirectory: await realpath(appDirectory),
    appRunSha256: createHash('sha256').update(actual).digest('hex'),
    controlledAppRunSha256: createHash('sha256').update(expected).digest('hex'),
    desktopFile: desktopFiles[0],
    desktopSha256: createHash('sha256').update(desktopBytes).digest('hex'),
    desktopExec: execLines[0].slice('Exec='.length),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appDirectory, outputFlag, output] = process.argv.slice(2);
  assert.ok(
    appDirectory,
    'Usage: node linux-sandbox.mjs <extractedAppDirectory> [--output <json>]',
  );
  assert.ok(outputFlag === undefined || (outputFlag === '--output' && output));
  const evidence = await assertAppImageLauncher(path.resolve(appDirectory));
  await writeEvidence(output, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
