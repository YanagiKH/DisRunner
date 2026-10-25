# Release process

The canonical source, release feed, checks, and provenance authority is **[`YanagiKH/DisRunner`](https://github.com/YanagiKH/DisRunner)**. A workflow definition is not evidence that a release exists or that every target passed; use the completed run and its artifacts as the record.

## Canonical release and optional mirror

[`YanagiKH/Discord-Extensions`](https://github.com/YanagiKH/Discord-Extensions) is a separate repository. DisRunner releases remain canonical in `YanagiKH/DisRunner`; an optional target-side mirror uses the namespaced tag `disrunner-vX.Y.Z` so it cannot be confused with another extension's version.

The repository includes a reviewed [target-side mirror workflow template](examples/discord-extensions-release-mirror.yml). It does nothing until a maintainer installs it in the target repository. The source release workflow does not push across repositories and receives no cross-repository token.

When installed, the mirror workflow is expected to:

1. fetch the latest non-draft, non-prerelease canonical DisRunner release and annotated tag;
2. require both macOS architectures, Windows and Linux distributions, the standalone CLI, runtime qualification and installation/signing receipts, SBOM, `SHA256SUMS.txt`, and the exact provenance bundle;
3. verify every checksum-listed artifact against `SHA256SUMS.txt`;
4. verify every checksum-listed artifact with `gh attestation verify`, the canonical repository, release workflow identity, source tag/ref, and source commit digest;
5. stage uploads in a workflow-owned draft, resume only a byte-identical verified partial draft, and publish only after the remote asset set is exact;
6. publish the same files once under an immutable-by-policy namespaced mirror tag, or verify and leave an existing published mirror untouched.

The provenance bundle is named `disrunner-vX.Y.Z-provenance.sigstore.json`. It is produced **after** `SHA256SUMS.txt` because it attests the subjects listed by that manifest; the bundle therefore is not expected to checksum itself. The mirror excludes only that exact provenance filename from the manifest-membership comparison, then uses it to cryptographically verify every listed subject. Merely copying a checksum file or provenance bundle without those verification steps is not an acceptable mirror.

The mirror remains a distribution convenience. Canonical issues, source tag, workflow run, attestation identity, advisories, and `latest` status stay in `YanagiKH/DisRunner`.

## Release prerequisites

1. The release tag resolves to the reviewed commit on `main` according to the workflow's preflight policy.
2. Required canonical CI/security checks are fresh and green for that commit.
3. A successful `push` to `main` CI run has completed the full runtime qualification for that commit: 100 lifecycle cycles for each of the three adapters and a two-hour soak, with observed latency/RSS and confirmed process/listener cleanup.
4. Node 22.23.2, pnpm 11.19.0, Python 3.12.14, and the pinned SDK dependencies are installed; `pnpm install --frozen-lockfile` and `pnpm run verify:release` pass in every release validation job.
5. All four platform package, renderer, SDK, and distribution operation jobs succeed, along with the extracted standalone CLI test.
6. Version, changelog, compatibility matrix, roadmap, schemas, and known limitations agree.
7. No unresolved critical/high security finding or unreviewed blocking dependency alert remains.
8. Stable Windows signing and Apple signing/notarization credentials are configured in the corresponding release environments; native signature verification passes for the final artifacts.
9. Release artifacts are bounded, secret-scanned, and contain no private test data.

`All green` includes a Linux runtime qualification job. Pull requests run three cycles per adapter and a 15-second smoke measurement; their receipts have `qualified: false` and `verdict: "smoke-passed"`. Main pushes and manual CI runs use the full measurement. Full qualification requires clean, unchanged source and built runtime bytes; an independent validator checks the report's integrity, source SHA, version, coverage, thresholds and complete runtime/adapter artifact hashes. This measurement covers the shared runtime and three example Bot processes on that Linux runner. Desktop rendering, installers, minimum OS certification and CPU utilization require separate evidence.

CI and release jobs provision CPython 3.12.14 with pinned `setup-uv` and uv 0.12.23, using the managed Python distribution for each target. A temporary virtual environment receives bundled pip, and both `python` on `PATH` and `DISRUNNER_TEST_PYTHON` point to that environment. SDK dependencies are then installed from the locked requirements. The interpreter's exact patch version is checked; jobs do not substitute another Python patch when a platform's official installer is unavailable.

The package smoke executes the packaged renderer, preload bridge, local Bot runtime, Ed25519-signed requests, HMAC-authenticated responses, forged-listener rejection, callback failure handling, and close cleanup. Windows attaches to the renderer over Chromium CDP and exercises the preload API; it avoids evaluating native Electron objects in the main process.

Every packaged target also runs real discord.js and discord.py projects through the UI, including commands, buttons/select menus, modals, attachments, workspace persistence, and direct messages. The distribution operation tests then exercise the distributed payload in a directory containing spaces and non-ASCII characters: Windows installs, reinstalls, and uninstalls the NSIS package; macOS mounts the DMG, copies and replaces the application, and removes it; Linux extracts, replaces, and removes the AppImage payload. Each test reruns the raw and SDK UI checks after installation/replacement and verifies that an external workspace sentinel remains unchanged. Linux removal checks cover the extracted portable application, not a system package-manager installation.

The standalone CLI archive is extracted outside the checkout and tested with its bundled raw example. It still requires Node 22.23.2. Its local dependencies and example are included so the test does not install packages or fetch Bot dependencies during execution. The Linux release gate separately runs raw and SDK conformance in a network namespace with only loopback enabled, after dependency preparation.

Branch rules, tag rules, environment reviewers, GitHub immutable-release settings, and signing credentials live in repository settings. Naming an environment in YAML does not prove those protections exist; maintainers must verify them separately.

## Channels and signing

Stable tags use `vX.Y.Z`. Preview tags use `vX.Y.Z-beta`, `vX.Y.Z-beta.N`, or `vX.Y.Z-rc.N`; previews are marked as GitHub prereleases and never become `latest`. Both channels require the annotated tag at the current `main` commit, trusted green checks, and the validation/package tests.

Stable packages cannot fall back to unsigned output. The Windows environment requires `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`. The macOS environment requires `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. These are GitHub Actions secret names; keep certificate files, private keys, passwords, and account credentials out of repository files and logs.

Windows verifies Authenticode signatures on both the installer and application, including a matching signer identity. macOS verifies the application and DMG signing identity, requires accepted notarization, staples the tickets, and checks `codesign`, `spctl`, and `stapler` results. Preview builds may be unsigned and do not satisfy the stable signing requirement. The canonical stable mirror ignores preview releases.

## Published assets

For version `X.Y.Z` and tag `vX.Y.Z`, a complete stable release contains:

- `DisRunner-X.Y.Z-win-x64.exe`
- `DisRunner-X.Y.Z-mac-arm64.dmg` and `DisRunner-X.Y.Z-mac-x64.dmg`
- `DisRunner-X.Y.Z-linux-x86_64.AppImage` (the target platform is named `linux-x64`)
- `disrunner-cli-X.Y.Z.tar.gz`
- `disrunner-vX.Y.Z-runtime-qualification.json`
- `disrunner-vX.Y.Z-installation-{linux-x64,windows-x64,macos-arm64,macos-x64}.json`
- `disrunner-vX.Y.Z-signing-{windows-x64,macos-arm64,macos-x64}.json`
- `disrunner-vX.Y.Z-sbom.cdx.json`, `SHA256SUMS.txt`, and `disrunner-vX.Y.Z-provenance.sigstore.json`

The brace lists describe separate files. Installer `.blockmap` files are optional; a DMG blockmap created before final signing/stapling is removed. Installation receipts identify the tested artifact by SHA-256 and record the completed operation stages. Signing receipts record native verification for stable packages. The runtime qualification receipt is downloaded from the exact successful canonical main-push CI run, then checked against a fresh runtime build before inclusion. The checksum manifest includes every published payload and receipt, while excluding itself and the exact provenance bundle. The publish job rejects missing or unexpected files. Previews require the same distribution, installation and full runtime qualification assets, with their preview version in the filenames, but do not require signing receipts.

## Create a canonical release

1. Prepare and review the release commit on `main`. Wait for that commit's full CI run, including the two-hour runtime qualification, and Security checks to pass before creating its immutable tag.
2. Create an annotated semantic-version tag pointing to that exact commit:

   ```bash
   git tag -a v1.0.0 -m "DisRunner v1.0.0"
   git push origin v1.0.0
   ```

3. The tag-triggered `Release` workflow resolves the annotated tag, waits for the required checks, reruns the release suite, and packages each target. A manual dispatch is accepted only when both the workflow ref and input name that same tag.
4. Preflight binds the release to a successful canonical `push`/`main` CI run for the same SHA. The publish job downloads only that run's `runtime-qualification-<SHA>` artifact and independently verifies the full receipt against a fresh runtime build. It then collects desktop packages, the standalone CLI and required receipts; generates the CycloneDX SBOM and `SHA256SUMS.txt`; scans artifacts; creates the GitHub Actions provenance attestation; and stages its Sigstore bundle.
5. Immediately before publication, the workflow rechecks tag/main identity and required checks.
6. It creates a marker-bound draft transaction. A complete workflow-owned draft can resume; an incomplete workflow-owned draft is deleted and rebuilt; an unrelated human draft fails closed.
7. It downloads and verifies the remote draft assets by exact name, size, GitHub SHA-256 digest, checksum manifest, and provenance. It snapshots the verified release ID and assets, rechecks `main`, the annotated tag, and required checks, then atomically changes the draft to published.
8. A pre-existing published release is never overwritten: the workflow verifies its complete internally consistent asset set and exits, or fails on any mismatch.
9. If the optional mirror workflow is installed in `Discord-Extensions`, that separate target-side job later verifies and mirrors the canonical release through the same draft-before-publish pattern.

Do not manually replace an asset under an existing tag. Installers, SBOMs, and provenance bundles can contain run-specific bytes, so retry safety is established from the already-uploaded release's checksum and provenance closure rather than expecting a rebuild to be byte-identical. Workflow refusal to mutate a published release provides policy enforcement for this path; a repository-wide immutable-release guarantee exists only if GitHub's corresponding repository setting is also enabled.

## Verify provenance

Use the canonical release's exact provenance bundle and repository identity. The target mirror template is the executable reference for the expected `gh attestation verify` arguments. Verification should establish at least:

- artifact digest matches a subject in the bundle;
- signer repository is `YanagiKH/DisRunner`;
- signer workflow is `.github/workflows/release.yml`;
- source digest is the annotated tag's commit;
- source ref is the released tag.

A successful attestation verifies build provenance for the artifact. It does not prove that the software is vulnerability-free, that a package is code-signed/notarized, or that every optional target ran.

## Release evidence

Retain the source commit and annotated tag, workflow run, toolchain/lockfile, required check conclusions, full runtime qualification receipt, validation and package results, artifact hashes, SBOM, provenance verification, installation receipts, stable signing/notarization receipts, compatibility declaration, and release notes. CI uploads `runtime-qualification-<SHA>` with 30-day retention, including failed or in-progress evidence when available. The release retains its verified full receipt as a canonical asset. The workflow uploads detailed SDK UI and installer logs under `release-operation-<platform>-<tag>` with 30-day retention; the release assets retain the summary receipts. Inspect the completed target jobs and receipts before declaring a version released on that platform.

## Revoke or supersede

- Mark the affected release clearly; do not silently delete evidence.
- Publish a fixed patch through the same gate.
- Revoke or rotate compromised credentials/signatures as required.
- Document affected versions, impact, mitigation, and migration behavior.
- Update the mirror with a new namespaced patch release; do not rewrite the previous mirror.

“All green” means fresh direct evidence for the declared checks. It reduces risk and does not guarantee that no defect remains.
