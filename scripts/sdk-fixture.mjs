import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Link the pinned SDK package into a copied Bot without relocating its dependencies. */
export async function linkDiscordJsFixture(exampleDirectory, entryPoint) {
  const fromExample = createRequire(path.join(path.resolve(exampleDirectory), 'package.json'));
  const sdkEntry = await realpath(fromExample.resolve('discord.js'));
  const packageFile = await realpath(createRequire(sdkEntry).resolve('../package.json'));
  const packageRoot = path.dirname(packageFile);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(metadata.name, 'discord.js');
  assert.equal(metadata.version, '14.27.0', 'The fixture requires the pinned SDK version');

  const fixtureModules = path.join(path.dirname(path.resolve(entryPoint)), 'node_modules');
  await mkdir(fixtureModules, { recursive: true });
  const modulesInfo = await lstat(fixtureModules);
  assert.ok(
    modulesInfo.isDirectory() && !modulesInfo.isSymbolicLink(),
    'The copied Bot must own its node_modules directory',
  );
  // A whole node_modules junction leaves pnpm's relative links rooted on the wrong Windows drive.
  await symlink(packageRoot, path.join(fixtureModules, 'discord.js'), 'junction');
  const fixtureEntry = await realpath(
    createRequire(path.resolve(entryPoint)).resolve('discord.js'),
  );
  assert.equal(
    fixtureEntry,
    sdkEntry,
    'The copied Bot must resolve the original physical SDK entry',
  );

  return {
    version: metadata.version,
    sdkEntry,
    fixtureEntry,
    packageRoot,
    fixtureModules: await realpath(fixtureModules),
  };
}
