#!/usr/bin/env bash
set -euo pipefail

test "${RUNNER_OS:-}" = macOS
[[ "${APPLE_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]]
[[ "${RELEASE_ARCH:-}" = arm64 || "${RELEASE_ARCH:-}" = x64 ]]

shopt -s nullglob
applications=(apps/desktop/release/mac*/DisRunner.app)
test "${#applications[@]}" = 1
application="${applications[0]}"
dmg="apps/desktop/release/DisRunner-${RELEASE_VERSION}-mac-${RELEASE_ARCH}.dmg"
test -f "$dmg"

# electron-builder signs and notarizes the application before creating the disk image.
codesign --verify --deep --strict --verbose=2 "$application"
details="$(codesign --display --verbose=4 "$application" 2>&1)"
printf '%s\n' "$details" | grep -Fxq "TeamIdentifier=${APPLE_TEAM_ID}"
spctl --assess --type execute --verbose=2 "$application"
xcrun stapler validate "$application"

codesign --verify --strict --verbose=2 "$dmg"
dmg_details="$(codesign --display --verbose=4 "$dmg" 2>&1)"
printf '%s\n' "$dmg_details" | grep -Fxq "TeamIdentifier=${APPLE_TEAM_ID}"

notary_result="${RUNNER_TEMP}/disrunner-${RELEASE_ARCH}-dmg-notarization.json"
xcrun notarytool submit "$dmg" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait --timeout 20m --output-format json > "$notary_result"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (result.status !== "Accepted") throw new Error("Disk image notarization was not accepted.");
' "$notary_result"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
# Signing and stapling changed the final disk image; a pre-signing blockmap is stale.
rm -f "${dmg}.blockmap"

export DISRUNNER_VERIFIED_DMG="$dmg"
export DISRUNNER_NOTARY_RESULT="$notary_result"
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dmg = process.env.DISRUNNER_VERIFIED_DMG;
const notary = JSON.parse(await readFile(process.env.DISRUNNER_NOTARY_RESULT, 'utf8'));
const receipt = {
  schemaVersion: 1,
  tag: process.env.RELEASE_TAG,
  sourceSha: process.env.GITHUB_SHA,
  platform: `macos-${process.env.RELEASE_ARCH}`,
  verifier: ['codesign', 'spctl', 'stapler', 'notarytool'],
  verifiedAt: new Date().toISOString(),
  teamId: process.env.APPLE_TEAM_ID,
  notarization: { id: notary.id, status: notary.status },
  files: [{ file: path.basename(dmg), sha256: createHash('sha256').update(await readFile(dmg)).digest('hex') }],
};
await writeFile(path.join(path.dirname(dmg), `disrunner-${process.env.RELEASE_TAG}-signing-macos-${process.env.RELEASE_ARCH}.json`), JSON.stringify(receipt, null, 2) + '\n');
NODE
