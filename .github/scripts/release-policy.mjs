import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta(?:\.(?:0|[1-9]\d*))?|rc\.(?:0|[1-9]\d*)))?$/u;

export function parseReleaseVersion(version) {
  if (typeof version !== 'string' || version.length > 80 || !VERSION.test(version)) {
    throw new TypeError('Version must be X.Y.Z, X.Y.Z-beta[.N], or X.Y.Z-rc.N.');
  }
  const suffix = version.split('-')[1];
  const channel = suffix === undefined ? 'stable' : suffix.startsWith('beta') ? 'beta' : 'rc';
  return Object.freeze({ version, tag: `v${version}`, channel, prerelease: channel !== 'stable' });
}

export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new TypeError('Release tag must start with v.');
  }
  return parseReleaseVersion(tag.slice(1));
}

export function requiredSigningVariables(platform, tag) {
  if (parseReleaseTag(tag).prerelease) return [];
  if (platform === 'Windows') return ['CSC_LINK', 'CSC_KEY_PASSWORD'];
  if (platform === 'macOS') {
    return [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ];
  }
  if (platform === 'Linux') return [];
  throw new TypeError('Unknown release platform.');
}

export function assertSigningEnvironment(platform, tag, environment) {
  const missing = requiredSigningVariables(platform, tag).filter(
    (name) => typeof environment[name] !== 'string' || environment[name].trim() === '',
  );
  if (missing.length !== 0) {
    throw new Error(
      `Stable ${platform} release requires configured signing variables: ${missing.join(', ')}.`,
    );
  }
}

async function main() {
  const release = parseReleaseTag(process.env.RELEASE_TAG);
  if (process.argv.includes('--check-signing')) {
    assertSigningEnvironment(process.env.RUNNER_OS, release.tag, process.env);
    console.log(`Signing prerequisites satisfied for the ${release.channel} channel.`);
    return;
  }
  const metadata = `channel=${release.channel}\nprerelease=${release.prerelease}\nversion=${release.version}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, metadata);
  process.stdout.write(metadata);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
