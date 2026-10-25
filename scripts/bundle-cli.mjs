import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `disrunner-cli-${manifest.version}`;
const outputRoot = path.join(root, 'release');
const output = path.join(outputRoot, name);
await mkdir(outputRoot, { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(output);

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22.23',
  format: 'esm',
  legalComments: 'eof',
  metafile: true,
  external: [
    '@disrunner/core',
    '@disrunner/runtime',
    '@disrunner/adapter-discordjs',
    '@disrunner/adapter-discordpy',
    'bufferutil',
    'utf-8-validate',
  ],
  banner: {
    js: "import { createRequire as __disrunnerCreateRequire } from 'node:module'; const require = __disrunnerCreateRequire(import.meta.url);",
  },
};

const builds = [];
builds.push(
  await build({
    ...shared,
    entryPoints: ['apps/cli/src/index.ts'],
    outfile: path.join(output, 'disrunner.mjs'),
  }),
);
for (const packageName of ['core', 'runtime']) {
  const directory = path.join(output, 'node_modules', '@disrunner', packageName);
  await mkdir(directory, { recursive: true });
  builds.push(
    await build({
      ...shared,
      entryPoints: [`packages/${packageName}/src/index.ts`],
      outfile: path.join(directory, 'index.js'),
    }),
  );
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify(
      {
        name: `@disrunner/${packageName}`,
        version: manifest.version,
        type: 'module',
        exports: './index.js',
      },
      null,
      2,
    ) + '\n',
  );
}

for (const packageName of ['adapter-discordjs', 'adapter-discordpy']) {
  const source = path.join(root, 'packages', packageName);
  const directory = path.join(output, 'node_modules', '@disrunner', packageName);
  await cp(source, directory, {
    recursive: true,
    filter: (file) =>
      !['node_modules', 'tests', '__pycache__', 'dist', '.venv'].includes(path.basename(file)),
  });
}

await cp(
  path.join(root, 'examples', 'raw-webhook-bot'),
  path.join(output, 'examples', 'raw-webhook-bot'),
  {
    recursive: true,
    filter: (file) => !['node_modules', 'tests'].includes(path.basename(file)),
  },
);
await cp(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
const dependencyRoots = new Set();
for (const result of builds) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.split(/[\\/]/u).includes('node_modules')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== root && directory !== path.dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (typeof metadata.name === 'string') {
          dependencyRoots.add(directory);
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
  }
}
const notices = [];
for (const directory of [...dependencyRoots].sort()) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter((file) =>
    /^(?:licen[cs]e|notice)(?:[.-]|$)/iu.test(file),
  );
  if (licenses.length === 0) throw new Error(`Missing license notice for ${metadata.name}.`);
  const texts = await Promise.all(
    licenses.sort().map((file) => readFile(path.join(directory, file), 'utf8')),
  );
  notices.push(`${metadata.name} ${metadata.version}\n${texts.join('\n')}`);
}
await writeFile(
  path.join(output, 'THIRD_PARTY_NOTICES.txt'),
  notices.join('\n\n----------------------------------------\n\n') + '\n',
);
await writeFile(
  path.join(output, 'package.json'),
  JSON.stringify(
    { name: '@disrunner/cli-bundle', version: manifest.version, type: 'module', private: true },
    null,
    2,
  ) + '\n',
);
await writeFile(
  path.join(output, 'disrunner'),
  '#!/bin/sh\nexec node "$(dirname "$0")/disrunner.mjs" "$@"\n',
);
await chmod(path.join(output, 'disrunner'), 0o755);
await writeFile(
  path.join(output, 'disrunner.cmd'),
  '@echo off\r\nnode "%~dp0disrunner.mjs" %*\r\n',
);
await writeFile(
  path.join(output, 'README.txt'),
  `DisRunner ${manifest.version} CLI\n\nRequires Node.js 22.23.2 or a compatible Node.js 22 release. No package installation or Electron is required.\n\nRun: node disrunner.mjs help\nTry the bundled local bot: node disrunner.mjs bot-test examples/ping.bot-case.json --project examples/raw-webhook-bot\n\nPrepare your own bot dependencies before disconnecting from the network. discord.js and discord.py projects require their documented pinned SDK versions and, for Python, a configured interpreter.\n`,
);
await writeFile(
  path.join(output, 'examples', 'ping.bot-case.json'),
  JSON.stringify(
    {
      version: 1,
      execution: 'bot',
      name: 'Bundled raw webhook ping',
      context: { actorId: '3000', guildId: '1000', channelId: '2000' },
      steps: [
        {
          requestId: 'ping',
          input: '/ping',
          expect: { responseType: 'message', content: 'Pong! Offline and deterministic.' },
        },
      ],
    },
    null,
    2,
  ) + '\n',
);

const files = {};
async function index(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const key = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await index(file, key);
    else
      files[key] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
  }
}
await index(output);
await writeFile(
  path.join(output, 'bundle-manifest.json'),
  JSON.stringify({ version: manifest.version, node: manifest.engines.node, files }, null, 2) + '\n',
);
const archive = path.join(outputRoot, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', outputRoot, name], { stdio: 'inherit' });
console.log(archive);
