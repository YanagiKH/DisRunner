import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'Run these diagnostics on native Windows.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'DisRunner native SDK 測試 '));
const origin = performance.now();
const events = [];
const children = [];
const results = [];
const spawn = childProcess.spawn;
let phase = 'SDK resolution';
const at = () => Math.round((performance.now() - origin) * 1000) / 1000;
const describeError = (error) => ({
  code: error.code,
  name: error.name,
  message: error.message,
});

try {
  const example = path.join(root, 'examples', 'discordjs-bot');
  await symlink(
    path.join(example, 'node_modules'),
    path.join(directory, 'node_modules'),
    'junction',
  );
  const resolution = {};
  for (const [label, entry] of [
    ['example', path.join(example, 'bot.cjs')],
    ['temporary', path.join(directory, 'bot.cjs')],
  ]) {
    try {
      const require = createRequire(entry);
      const resolved = require.resolve('discord.js');
      const manifest = JSON.parse(
        await readFile(createRequire(resolved).resolve('../package.json'), 'utf8'),
      );
      resolution[label] = {
        resolved,
        realpath: await realpath(resolved),
        version: manifest.version,
      };
    } catch (error) {
      resolution[label] = { error: describeError(error) };
    }
  }
  results.push({
    phase,
    resolution,
    temporaryModules: await realpath(path.join(directory, 'node_modules')),
  });

  childProcess.spawn = function (executable, args, options) {
    const helper = path.basename(executable).toLowerCase() === 'taskkill';
    const record = {
      phase,
      kind: helper ? 'taskkill' : 'bot',
      atMs: at(),
      ...(helper ? { args } : {}),
    };
    const child = spawn.call(
      this,
      executable,
      args,
      helper ? { ...options, stdio: ['ignore', 'pipe', 'pipe'] } : options,
    );
    record.pid = child.pid;
    events.push(record);
    children.push({ child, record });
    if (helper) {
      record.output = '';
      record.errorOutput = '';
      child.stdout.on('data', (chunk) => {
        record.output = (record.output + String(chunk)).slice(0, 4096);
      });
      child.stderr.on('data', (chunk) => {
        record.errorOutput = (record.errorOutput + String(chunk)).slice(0, 4096);
      });
    }
    child.on('error', (error) => {
      record.error = describeError(error);
      record.errorAtMs = at();
    });
    child.once('exit', (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exitAtMs = at();
    });
    child.once('close', () => {
      record.closeAtMs = at();
    });
    return child;
  };
  syncBuiltinESMExports();
  const { BotRunner } = await import(
    pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
  );
  for (const [index, alive] of [false, false, false, false, false, true].entries()) {
    phase = `${alive ? 'remain-live' : 'natural-exit'}-${index}`;
    let resolveControl;
    const control = new Promise((resolve) => {
      resolveControl = resolve;
    });
    const runner = new BotRunner({
      onControl(record) {
        if (record.kind !== 'adapter-error') return;
        events.push({ phase, kind: 'adapter-error', atMs: at() });
        resolveControl(
          runner.stop(1000).then(
            (value) => ({ ok: true, status: value.status, exitCode: value.exitCode }),
            (error) => ({
              ok: false,
              error: describeError(error),
              snapshot: runner.snapshot(),
              evidence: runner.evidence(),
            }),
          ),
        );
      },
    });
    const line = `DISRUNNER_ADAPTER_ERROR ${JSON.stringify({ code: 'unsupported', message: 'Unsupported fixture version.' })}\n`;
    const script = `require('node:fs').writeSync(1,${JSON.stringify(line)});${alive ? 'setInterval(()=>{},1000);' : 'process.exitCode=1;'}`;
    try {
      await runner.start({
        executable: process.execPath,
        args: ['-e', script],
        cwd: directory,
        workspaceRoot: directory,
        restBaseUrl: 'http://127.0.0.1:1/api/v10',
        gatewayUrl: 'ws://127.0.0.1:2/gateway',
      });
      let timer;
      const result = await Promise.race([
        control,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Diagnostic exceeded its deadline.')), 7000);
        }),
      ]).finally(() => clearTimeout(timer));
      results.push({ phase, ...result });
    } finally {
      // These fixtures create no descendants. Only their original live ChildProcess handles
      // may be terminated here; never target an already departed PID.
      for (const item of children.filter((item) => item.record.phase === phase)) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
      }
      await runner.stop(100).catch(() => {});
    }
    await delay(20);
  }
} finally {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  await rm(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify({ nativeWindows: true, node: process.version, results, events }, null, 2),
  );
}
