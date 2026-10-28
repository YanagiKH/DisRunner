# Dependency audit baseline

Checked on 2026-10-25 for v1.0.0 with Node 22.23.2 and pnpm 11.19.0. `pnpm audit --audit-level=high` reports no known vulnerabilities in the locked dependency graph. The 11 pinned Python SDK requirements also report no known vulnerabilities with pip-audit 2.10.1.

The audit includes development and optional packaging dependencies. Scoped overrides remain within the affected parents' compatible ranges; `ajv` resolves `fast-uri` 3.1.9, including the packaging toolchain. The earlier `sprintf-js` packaging advisory is no longer present in this graph.

Audit results depend on the advisory database and do not establish runtime reachability or absence of vulnerabilities. CI repeats the audit and security tests for the proposed commit; release publication requires the trusted checks for the exact main commit.

The Python check uses `pip-audit --disable-pip --no-deps -r packages/adapter-discordpy/requirements.txt`. All transitive runtime requirements are listed with exact versions; the audit tool is installed separately from the application and Bot environment.

Dependency compatibility is checked by the complete workspace verification, real SDK conformance and packaged application tests. Signed installers and platform operation receipts require their separate release checks.
