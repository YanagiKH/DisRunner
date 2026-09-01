import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifests = ['package.json'];
for (const workspaceDirectory of ['apps', 'packages', 'examples']) {
  for (const entry of await readdir(path.join(root, workspaceDirectory), { withFileTypes: true })) {
    if (entry.isDirectory())
      manifests.push(path.join(workspaceDirectory, entry.name, 'package.json'));
  }
}

const versions = new Map();
for (const manifest of manifests.sort()) {
  const parsed = JSON.parse(await readFile(path.join(root, manifest), 'utf8'));
  if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(parsed.version)) {
    throw new Error(`${manifest} does not contain a semantic version.`);
  }
  versions.set(manifest, parsed.version);
}

const rootVersion = versions.get('package.json');
for (const [manifest, version] of versions) {
  if (version !== rootVersion) {
    throw new Error(`${manifest} is ${version}; every workspace must match root ${rootVersion}.`);
  }
}

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag !== undefined && releaseTag !== `v${rootVersion}`) {
  throw new Error(`Release tag ${releaseTag} does not match workspace version v${rootVersion}.`);
}

console.log(`All ${versions.size} package manifests use ${rootVersion}.`);
