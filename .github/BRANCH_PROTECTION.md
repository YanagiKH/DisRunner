# Repository protection contract

GitHub repository settings are part of the release security boundary. The live configuration must match this file before a release tag is created.

## `main`

- Require a pull request with at least one approving review for changes after the bootstrap release.
- Dismiss stale approvals and require approval of the most recent reviewable push.
- Require conversation resolution.
- Require these exact GitHub Actions checks to pass on the current commit:
  - `All green`
  - `CodeQL`
  - `Code scanning high-severity policy`
  - `pnpm audit and security suite`
- Require the branch to be up to date, signed commits where the repository policy supports them, and linear history.
- Block force pushes and branch deletion, including for administrators except documented emergency bypasses.

## Release tags and environment

- A repository ruleset targeting `v*.*.*` tags must block tag updates and deletions after creation. Release tags are annotated and point to the exact current `main` commit.
- The `release`, `release-windows`, `release-macos`, and `release-linux` environments limit deployment branches/tags to the release policy. Signing secrets, when configured, are environment-scoped.
- Existing GitHub Releases and their assets are immutable. A correction uses a new patch version.

## Drift audit

Before tagging, inspect branch protection/rulesets and environments through the GitHub API. Any missing required check, update/delete protection, or unexpected bypass actor blocks release. Workflow checks reduce race windows; live tag protection is what prevents a tag from moving after the final workflow verification.
