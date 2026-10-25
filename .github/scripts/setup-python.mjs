import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const version = '3.12.14';
const runnerTemp = process.env.RUNNER_TEMP;
assert.ok(runnerTemp && path.isAbsolute(runnerTemp), 'RUNNER_TEMP must be an absolute directory.');
for (const variable of ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT'])
  assert.ok(process.env[variable], `${variable} is required to publish the prepared interpreter.`);

function execute(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16_384,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(executable)} failed while preparing Python.`);
  return result.stdout;
}

const uv = process.platform === 'win32' ? 'uv.exe' : 'uv';
assert.match(execute(uv, ['--version'], true), /^uv 0\.12\.23(?:\s|$)/u, 'The uv version differs.');
execute(uv, ['--no-config', 'python', 'install', `cpython@${version}`, '--no-progress']);
const environment = await mkdtemp(path.join(runnerTemp, `disrunner-python-${version}-`));
try {
  execute(uv, [
    '--no-config',
    'venv',
    '--no-project',
    '--managed-python',
    '--python',
    `cpython@${version}`,
    environment,
  ]);
  const binaryDirectory = path.join(environment, process.platform === 'win32' ? 'Scripts' : 'bin');
  const executable = path.join(
    binaryDirectory,
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  execute(executable, ['-I', '-m', 'ensurepip', '--default-pip']);
  const actual = JSON.parse(
    execute(
      executable,
      [
        '-I',
        '-c',
        'import json, platform, sys; print(json.dumps({"version": platform.python_version(), "implementation": sys.implementation.name, "prefix": sys.prefix}))',
      ],
      true,
    ),
  );
  assert.equal(actual.version, version, 'The prepared Python patch version differs.');
  assert.equal(actual.implementation, 'cpython', 'The prepared interpreter must be CPython.');
  assert.equal(
    path.resolve(actual.prefix),
    path.resolve(environment),
    'Python did not select its venv.',
  );
  await appendFile(process.env.GITHUB_PATH, `${binaryDirectory}\n`);
  await appendFile(
    process.env.GITHUB_ENV,
    [
      `VIRTUAL_ENV=${environment}`,
      `pythonLocation=${environment}`,
      `UV_PYTHON=${executable}`,
      `DISRUNNER_TEST_PYTHON=${executable}`,
      '',
    ].join('\n'),
  );
  await appendFile(process.env.GITHUB_OUTPUT, `python_path=${executable}\n`);
  console.log(`Prepared CPython ${version} with bundled pip.`);
} catch (error) {
  await rm(environment, { recursive: true, force: true });
  throw error;
}
