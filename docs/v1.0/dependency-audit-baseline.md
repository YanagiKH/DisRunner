# Dependency audit baseline

Status: local M0 remediation evidence, not release certification. Checked on 2026-10-21 with Node 22.23.2 and pnpm 11.19.0. The repository version remains 0.1.0 Preview.

The original frozen dependency graph reported 40 advisories: 3 critical, 17 high, 16 moderate and 4 low. Compatible version updates, scoped transitive overrides and a Vitest 4 migration reduced the final checked graph to 1 moderate advisory, with no high or critical advisories. Counts refer to advisories, not independently proven application vulnerabilities, and can change as the advisory database changes.

## Remaining advisory

- Package: `sprintf-js` 1.1.3, through the optional packaging path `electron-builder → app-builder-lib → @electron/get → global-agent → roarr`.
- Advisory: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), denial of service through unbounded precision specifiers, rated moderate.
- The audit names `>=1.1.4` as patched, but the official registry returned E404 for 1.1.4 and its published-version list ended at 1.1.3 on the check date. No nonexistent version or incompatible major override was installed.
- This is a development/packaging dependency path; the complete reachability analysis remains open. It is not described as proven unreachable or silently excluded from audit.
- Follow-up owner: the project integration maintainer. Recheck availability and reachability before the next release candidate, or by 2026-10-28, whichever is earlier. Do not lower audit thresholds or remove the check.

## Compatibility evidence and limits

Full `pnpm run verify` passed after the dependency migration, including the ordinary test suites and workspace build. The test runner resolves to Vitest 4.1.12; coverage thresholds are unchanged and the source include is explicit. A Linux x64 unpacked Electron build succeeded with `--publish never`.

The unpacked build is not evidence of a running packaged GUI. No new Windows/macOS, signed installer, GUI smoke, performance, or release certification is asserted here. The normal repository CI and release gates still apply to the exact proposed head.
