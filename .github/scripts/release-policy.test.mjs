import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSigningEnvironment,
  parseReleaseTag,
  parseReleaseVersion,
} from './release-policy.mjs';

test('stable, beta and RC versions have explicit release channels', () => {
  assert.deepEqual(parseReleaseTag('v1.0.0'), {
    version: '1.0.0',
    tag: 'v1.0.0',
    channel: 'stable',
    prerelease: false,
  });
  assert.equal(parseReleaseTag('v0.9.0-beta').channel, 'beta');
  assert.equal(parseReleaseTag('v1.0.0-beta.2').prerelease, true);
  assert.equal(parseReleaseTag('v1.0.0-rc.3').channel, 'rc');
});

test('ambiguous versions and unsafe refs are rejected before any release mutation', () => {
  for (const version of [
    '01.0.0',
    '1.00.0',
    '1.0.0-rc',
    '1.0.0-rc.01',
    '1.0.0-beta.01',
    '1.0.0+local',
    '1.0.0\n',
    '1.0.0-rc.1/other',
  ]) {
    assert.throws(() => parseReleaseVersion(version), /Version must/u);
  }
  for (const tag of ['1.0.0', 'refs/tags/v1.0.0', 'v1.0.0;echo bad', '', null]) {
    assert.throws(() => parseReleaseTag(tag));
  }
});

test('stable platform builds fail without credentials while prereleases are labelled separately', () => {
  assert.throws(
    () => assertSigningEnvironment('Windows', 'v1.0.0', {}),
    /CSC_LINK, CSC_KEY_PASSWORD/u,
  );
  assert.throws(
    () => assertSigningEnvironment('macOS', 'v1.0.0', { CSC_LINK: 'configured' }),
    /APPLE_TEAM_ID/u,
  );
  assert.doesNotThrow(() => assertSigningEnvironment('Linux', 'v1.0.0', {}));
  assert.doesNotThrow(() => assertSigningEnvironment('Windows', 'v1.0.0-rc.1', {}));
  assert.doesNotThrow(() =>
    assertSigningEnvironment('Windows', 'v1.0.0', {
      CSC_LINK: 'configured',
      CSC_KEY_PASSWORD: 'configured',
    }),
  );
});

test('missing-credential diagnostics never include supplied credential values', () => {
  assert.throws(
    () => assertSigningEnvironment('macOS', 'v1.0.0', { CSC_LINK: 'private-certificate-data' }),
    (error) =>
      !error.message.includes('private-certificate-data') &&
      error.message.includes('CSC_KEY_PASSWORD'),
  );
});
