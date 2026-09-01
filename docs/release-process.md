# Release process

The canonical source, release feed, checks, and provenance authority is **[`YanagiKH/DisRunner`](https://github.com/YanagiKH/DisRunner)**. A workflow definition is not evidence that a release exists or that every target passed; use the completed run and its artifacts as the record.

## Canonical release and optional mirror

[`YanagiKH/Discord-Extensions`](https://github.com/YanagiKH/Discord-Extensions) is a separate repository. DisRunner releases remain canonical in `YanagiKH/DisRunner`; an optional target-side mirror uses the namespaced tag `disrunner-vX.Y.Z` so it cannot be confused with another extension's version.

The repository includes a reviewed [target-side mirror workflow template](examples/discord-extensions-release-mirror.yml). It does nothing until a maintainer installs it in the target repository. The source release workflow does not push across repositories and receives no cross-repository token.

When installed, the mirror workflow is expected to:

1. fetch the latest non-draft, non-prerelease canonical DisRunner release and annotated tag;
2. require the Windows, macOS, Linux, SBOM, `SHA256SUMS.txt`, and exact provenance bundle assets;
3. verify every checksum-listed artifact against `SHA256SUMS.txt`;
4. verify every checksum-listed artifact with `gh attestation verify`, the canonical repository, release workflow identity, source tag/ref, and source commit digest;
5. stage uploads in a workflow-owned draft, resume only a byte-identical verified partial draft, and publish only after the remote asset set is exact;
6. publish the same files once under an immutable-by-policy namespaced mirror tag, or verify and leave an existing published mirror untouched.

The provenance bundle is named `disrunner-vX.Y.Z-provenance.sigstore.json`. It is produced **after** `SHA256SUMS.txt` because it attests the subjects listed by that manifest; the bundle therefore is not expected to checksum itself. The mirror excludes only that exact provenance filename from the manifest-membership comparison, then uses it to cryptographically verify every listed subject. Merely copying a checksum file or provenance bundle without those verification steps is not an acceptable mirror.

The mirror remains a distribution convenience. Canonical issues, source tag, workflow run, attestation identity, advisories, and `latest` status stay in `YanagiKH/DisRunner`.

## Release prerequisites

1. The release tag resolves to the reviewed commit on `main` according to the workflow's preflight policy.
2. Required canonical CI/security checks are fresh and green for that commit.
3. `pnpm install --frozen-lockfile` and `pnpm run verify:release` pass in the release validation job.
4. Every platform package/smoke job required by the workflow succeeds.
5. Version, changelog, compatibility matrix, roadmap, schemas, and known limitations agree.
6. No unresolved critical/high security finding or unreviewed blocking dependency alert remains.
7. Required signing/notarization credentials and repository environment protections are configured before claiming signed official packages.
8. Release artifacts are bounded, secret-scanned, and contain no private test data.

The macOS/Linux package smoke executes the packaged renderer, preload bridge, local bot runtime, Ed25519-signed requests, HMAC-authenticated responses, forged-response rejection, callback failure evidence, and close cleanup. The Windows package smoke validates launch, packaged Electron identity, ASAR presence, stability, and process-tree cleanup; it does not execute the packaged renderer/runtime because Electron's Windows CDP path can deadlock. A green Windows package job must therefore be read together with the separate cross-platform renderer E2E, runtime-manager signed-transport/forged-listener, raw-webhook loopback, and security jobs.

Branch rules, tag rules, environment reviewers, GitHub immutable-release settings, and signing credentials live in repository settings. Naming an environment in YAML does not prove those protections exist; maintainers must verify them separately.

## Create a canonical release

1. Prepare and review the release commit on `main`.
2. Create an annotated semantic-version tag pointing to that exact commit:

   ```bash
   git tag -a v0.1.0 -m "DisRunner v0.1.0"
   git push origin v0.1.0
   ```

3. The tag-triggered `Release` workflow resolves the annotated tag, waits for the required checks, reruns the release suite, and packages each target. A manual dispatch is accepted only when both the workflow ref and input name that same tag.
4. The publish job collects packages, generates the CycloneDX SBOM and `SHA256SUMS.txt`, scans artifacts, creates the GitHub Actions provenance attestation, and stages its Sigstore bundle.
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

Retain the source commit and annotated tag, workflow run, toolchain/lockfile, required check conclusions, validation and package results, artifact hashes, SBOM, provenance bundle/verification result, optional platform signatures/notarization records, compatibility declaration, and release notes.

## Revoke or supersede

- Mark the affected release clearly; do not silently delete evidence.
- Publish a fixed patch through the same gate.
- Revoke or rotate compromised credentials/signatures as required.
- Document affected versions, impact, mitigation, and migration behavior.
- Update the mirror with a new namespaced patch release; do not rewrite the previous mirror.

“All green” means fresh direct evidence for the declared checks. It reduces risk and does not guarantee that no defect remains.
