# Contributing to DisRunner

Thank you for helping build safer Discord bots. Contributions must preserve deterministic behavior, offline defaults, protocol traceability, and honest compatibility claims.

## Before you start

- Search existing issues and the [roadmap](ROADMAP.md).
- Use a feature request for a new behavior and an adapter request for SDK compatibility.
- Discuss large schema, security-boundary, or public API changes before implementation.
- Never include real tokens, private messages, user identifiers, or proprietary Discord client assets.

## Development setup

```bash
git clone https://github.com/YanagiKH/DisRunner.git
cd DisRunner
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run dev
```

The supported toolchain is Node.js `>=22.23.2 <23` and the repository-pinned pnpm `11.19.0`.

## Required checks

Run the narrow test while developing, then the full gate before opening a pull request:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:offline
pnpm run test:security
pnpm run build
pnpm run test:e2e
```

`pnpm run verify` covers the merge gate; `pnpm run verify:release` adds E2E and performance checks. A pull request is not ready while any required check is red or skipped without an approved reason.

## Test expectations

- Map each behavior to an observable assertion, including failure and boundary cases.
- Use a fixed seed and virtual clock for deterministic protocol tests.
- Test the 2,999/3,000/3,001 ms interaction boundary where timing is involved.
- Include permission-source evidence for permission behavior and headers/bucket identity for rate limits.
- Add contract fixtures for supported protocol payloads, preserving unknown fields where intended.
- Prove offline behavior without placing a real Discord token in the environment.
- Redact snapshots, traces, reports, console output, and uploaded artifacts.

## Pull requests

Keep changes scoped and explain:

1. the user-visible behavior;
2. the requirement/risk it addresses;
3. fresh verification commands and results;
4. compatibility, migration, privacy, and security effects;
5. screenshots for visible UI changes.

Maintainers may require a changeset/changelog entry for user-visible changes. Do not edit generated release artifacts manually.

## Commit and style guidance

- Prefer focused commits and imperative summaries.
- Follow the existing TypeScript and Prettier configuration.
- Keep core behavior independent of Electron so CLI and desktop paths share one engine.
- Use public behavior and stable seams in tests; avoid tautological mocks.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE) and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
