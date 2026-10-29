import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/security.yml', import.meta.url), 'utf8');
const policyJob = workflow.match(
  /(?:^|\n) {2}code-scanning-policy:\n([\s\S]*?)(?=\n {2}[\w-]+:|$)/u,
)?.[1];
assert.ok(policyJob, 'The main code-scanning policy job must exist.');
const lines = policyJob.split('\n');
const start = lines.indexOf('        run: |');
assert.ok(start >= 0, 'The policy must contain its executable shell script.');
const scriptLines = [];
for (const line of lines.slice(start + 1)) {
  if (line.trim() && !line.startsWith('          ')) break;
  scriptLines.push(line.slice(10));
}
const script = scriptLines.join('\n');
assert.match(script, /^set -euo pipefail/u);

const sha = '1'.repeat(40);
const analysis = (category, overrides = {}) => ({
  commit_sha: sha,
  tool: { name: 'CodeQL' },
  category,
  ...overrides,
});
// SARIF IDs end in "/"; GitHub's REST category excludes that run-ID delimiter.
// https://docs.github.com/code-security/reference/code-scanning/sarif-files/sarif-support#runautomationdetails-object
const ready = () => [analysis('/language:javascript-typescript'), analysis('/language:python')];

// Only the GitHub API and polling clock are replaced. Bash and jq execute the
// actual configured policy, including its critical/high alert checks.
const boundaries = String.raw`
seq() { printf '1\n'; }
sleep() { :; }
gh() {
  test "$1" = api || return 91
  case "$2" in
    "repos/$GITHUB_REPOSITORY/code-scanning/analyses?ref=refs/heads/main&per_page=100")
      printf '%s\n' "$ANALYSES_FIXTURE" ;;
    "repos/$GITHUB_REPOSITORY/code-scanning/alerts?state=open&severity=critical&per_page=100")
      test "$3" = --jq && test "$4" = length || return 92
      printf '%s\n' "$CRITICAL_FIXTURE" ;;
    "repos/$GITHUB_REPOSITORY/code-scanning/alerts?state=open&severity=high&per_page=100")
      test "$3" = --jq && test "$4" = length || return 93
      printf '%s\n' "$HIGH_FIXTURE" ;;
    *) printf 'Unexpected policy API request\n' >&2; return 94 ;;
  esac
}
`;

function runPolicy(analyses, { critical = 0, high = 0 } = {}) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', boundaries + script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_SHA: sha,
      ANALYSES_FIXTURE: JSON.stringify(analyses),
      CRITICAL_FIXTURE: String(critical),
      HIGH_FIXTURE: String(high),
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

test('the current commit and both REST language categories pass with no high findings', () => {
  const result = runPolicy(ready());
  assert.equal(result.status, 0, result.stderr);
});

test('missing, duplicate, stale and non-CodeQL analyses cannot satisfy both languages', () => {
  for (const records of [
    [],
    [ready()[0]],
    [ready()[0], ready()[0]],
    [ready()[0], analysis('/language:python', { commit_sha: '2'.repeat(40) })],
    [ready()[0], analysis('/language:python', { tool: { name: 'Other scanner' } })],
  ]) {
    const result = runPolicy(records);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Both JavaScript\/TypeScript and Python CodeQL results/u);
  }
});

test('SARIF automation IDs and similar category prefixes are not REST language categories', () => {
  for (const records of [
    [analysis('/language:javascript-typescript/'), analysis('/language:python/')],
    [ready()[0], analysis('/language:python/other')],
  ]) {
    assert.notEqual(runPolicy(records).status, 0);
  }
});

test('critical and high findings still block an otherwise complete current analysis', () => {
  for (const severity of ['critical', 'high']) {
    const result = runPolicy(ready(), { [severity]: 1 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Open ${severity} code-scanning alerts block`));
  }
});

test('unrelated analyses do not hide the complete current pair', () => {
  const result = runPolicy([
    analysis('/language:python', { commit_sha: '2'.repeat(40) }),
    analysis('/language:other'),
    ...ready(),
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('malformed analysis data and alert counts fail closed', () => {
  assert.notEqual(runPolicy({ unexpected: 'not an analysis list' }).status, 0);
  assert.notEqual(runPolicy(ready(), { high: 'invalid' }).status, 0);
});
