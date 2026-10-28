#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
node_path="$(node -p process.execPath)"
version="$("$node_path" -p "require(process.argv[1]).version" "$root/package.json")"
architecture="$("$node_path" -p process.arch)"
task_directory="$(mktemp -d "${TMPDIR:-/tmp}/DisRunner installer 測試.XXXXXX")"
evidence_directory="${DISRUNNER_INSTALLER_EVIDENCE:-$root/apps/desktop/release/installer-evidence}"
install_directory="$task_directory/application"
mount_directory="$task_directory/image"
mounted=false
external_instance=""
mkdir -p "$install_directory" "$mount_directory" "$evidence_directory"
cleanup_external_helper() {
  local phase="${1:-exit}"
  if [[ -n "$external_instance" ]]; then
    if ! "$node_path" "$root/.github/scripts/prepare-linux-sandbox.mjs" --cleanup-external-helper "$external_instance" > "$evidence_directory/external-suid-cleanup-${phase}.json"; then
      return 1
    fi
    external_instance=""
  fi
}
cleanup() {
  status="$?"
  trap - EXIT
  if ! cleanup_external_helper; then
    status=1
  fi
  if [[ "$mounted" = true ]]; then
    if ! hdiutil detach "$mount_directory"; then
      hdiutil detach -force "$mount_directory" || true
      status=1
    fi
  fi
  rm -rf "$task_directory"
  exit "$status"
}
trap cleanup EXIT

case "$(uname -s)" in
  Darwin)
    platform="macos-$architecture"
    artifact="${DISRUNNER_INSTALLER_ARTIFACT:-$root/apps/desktop/release/DisRunner-${version}-mac-${architecture}.dmg}"
    test -f "$artifact"
    hdiutil attach -readonly -nobrowse -mountpoint "$mount_directory" "$artifact" > "$evidence_directory/mount.txt"
    mounted=true
    test -d "$mount_directory/DisRunner.app"
    executable="$install_directory/DisRunner.app/Contents/MacOS/DisRunner"
    ;;
  Linux)
    platform="linux-$architecture"
    image_architecture="$architecture"
    if [[ "$image_architecture" = x64 ]]; then image_architecture=x86_64; fi
    artifact="${DISRUNNER_INSTALLER_ARTIFACT:-$root/apps/desktop/release/DisRunner-${version}-linux-${image_architecture}.AppImage}"
    test -f "$artifact"
    chmod u+x "$artifact"
    executable="$install_directory/squashfs-root/AppRun"
    ;;
  *) echo 'Use installer-roundtrip.ps1 for Windows.' >&2; exit 1 ;;
esac

workspace="$task_directory/project/.disrunner/workspace.json"
mkdir -p "$(dirname "$workspace")"
printf '%s\n' '{"version":1,"resources":[],"scenarios":[],"options":{"seed":42042,"mode":"strict"}}' > "$workspace"
cp "$workspace" "$evidence_directory/workspace-before.json"
export DISRUNNER_SMOKE_RENDERER_CDP=1
export DISRUNNER_PACKAGED_EXECUTABLE="$executable"
for stage in installed reinstalled; do
  if [[ "$platform" = macos-* ]]; then
    rm -rf "$install_directory/DisRunner.app"
    ditto "$mount_directory/DisRunner.app" "$install_directory/DisRunner.app"
    if [[ "${RELEASE_PRERELEASE:-true}" = false ]]; then
      codesign --verify --deep --strict "$install_directory/DisRunner.app"
      spctl --assess --type execute "$install_directory/DisRunner.app"
      xcrun stapler validate "$install_directory/DisRunner.app"
    fi
  else
    rm -rf "$install_directory/squashfs-root"
    (cd "$install_directory" && "$artifact" --appimage-extract > "$evidence_directory/extract-${stage}.txt")
    "$node_path" "$root/apps/desktop/tests/e2e/linux-sandbox.mjs" "$install_directory/squashfs-root" --output "$evidence_directory/launcher-${stage}.json"
    if [[ "${DISRUNNER_TEST_INSTALL_SUID_SANDBOX:-0}" = 1 ]]; then
      if [[ -z "$external_instance" ]]; then
        external_instance="$("$node_path" -p 'require("node:crypto").randomUUID()')"
      fi
      "$node_path" "$root/.github/scripts/prepare-linux-sandbox.mjs" --external-helper "$install_directory/squashfs-root" --instance "$external_instance" > "$evidence_directory/suid-${stage}.json"
      CHROME_DEVEL_SANDBOX="$("$node_path" --input-type=module - "$evidence_directory/suid-${stage}.json" "$external_instance" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const receipt = JSON.parse(await readFile(process.argv[2], 'utf8'));
const expected = '/tmp/disrunner-sandbox-' + process.argv[3] + '/chrome-sandbox';
assert.equal(receipt.instance, process.argv[3]);
assert.equal(receipt.helperPath, expected);
assert.equal(receipt.scope, 'temporary-ci-external-suid-helper');
assert.equal(receipt.adjacentHelperAbsent, true);
assert.equal(receipt.uid, 0);
assert.equal(receipt.gid, 0);
assert.equal(receipt.mode, '4755');
process.stdout.write(receipt.helperPath);
NODE
)"
      export CHROME_DEVEL_SANDBOX
    fi
    export DISRUNNER_LINUX_SANDBOX_EVIDENCE="$evidence_directory/$stage-linux-sandbox"
  fi
  test -x "$executable"
  export DISRUNNER_SDK_UI_EVIDENCE="$evidence_directory/$stage-sdk-ui"
  "$node_path" "$root/apps/desktop/tests/e2e/package-smoke.mjs"
  "$node_path" "$root/apps/desktop/tests/e2e/sdk-ui-smoke.mjs"
  cmp -s "$workspace" "$evidence_directory/workspace-before.json"
done

if [[ "$mounted" = true ]]; then
  hdiutil detach "$mount_directory"
  mounted=false
fi
cleanup_external_helper uninstall
rm -rf "$install_directory"
test ! -e "$executable"
cmp -s "$workspace" "$evidence_directory/workspace-before.json"
export DISRUNNER_TESTED_INSTALLER="$artifact"
export DISRUNNER_INSTALLER_EVIDENCE="$evidence_directory"
export DISRUNNER_INSTALLER_PLATFORM="$platform"
export DISRUNNER_INSTALLER_REPOSITORY="$root"
"$node_path" --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const hash = createHash('sha256');
for await (const chunk of createReadStream(process.env.DISRUNNER_TESTED_INSTALLER)) hash.update(chunk);
const receipt = JSON.stringify({
  schemaVersion: 1,
  sourceSha: process.env.GITHUB_SHA ?? null,
  platform: process.env.DISRUNNER_INSTALLER_PLATFORM,
  osRelease: os.release(),
  installer: path.basename(process.env.DISRUNNER_TESTED_INSTALLER),
  installerSha256: hash.digest('hex'),
  stages: ['installed-raw-and-sdk-ui', 'reinstalled-raw-and-sdk-ui', 'removed'],
  workspaceSentinelPreserved: true,
  externalSandboxHelperRemoved: process.platform === 'linux' && process.env.DISRUNNER_TEST_INSTALL_SUID_SANDBOX === '1' ? true : null,
  completedAt: new Date().toISOString(),
}, null, 2) + '\n';
await writeFile(path.join(process.env.DISRUNNER_INSTALLER_EVIDENCE, 'result.json'), receipt);
if (process.env.RELEASE_TAG) await writeFile(path.join(process.env.DISRUNNER_INSTALLER_REPOSITORY, 'apps/desktop/release', `disrunner-${process.env.RELEASE_TAG}-installation-${process.env.DISRUNNER_INSTALLER_PLATFORM}.json`), receipt);
NODE
