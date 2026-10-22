// Pure fixture contract tests. Importing the child must not start it or use credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandOperation,
  safeRestEvidence,
  validateRestBase,
} from '../fixtures/g1-parity/live-feed-bot.mjs';

test('three literal commands map to ordinary channel REST operations', () => {
  assert.deepEqual(commandOperation('feed-create'), {
    operation: 'create',
    method: 'POST',
    path: '/channels/2001/messages',
    body: { content: 'G1 public message created.' },
  });
  assert.deepEqual(commandOperation('feed-edit', '7001'), {
    operation: 'edit',
    method: 'PATCH',
    path: '/channels/2001/messages/7001',
    body: { content: 'G1 public message edited.' },
  });
  assert.deepEqual(commandOperation('feed-delete', '7001'), {
    operation: 'delete',
    method: 'DELETE',
    path: '/channels/2001/messages/7001',
  });
});

test('unsupported commands and absent or unsafe message identities fail closed', () => {
  for (const command of ['ping', '/feed-create', 'constructor', '', undefined])
    assert.throws(() => commandOperation(command));
  assert.throws(() => commandOperation('feed-create', '7001'));
  for (const id of [null, undefined, '../@me', '7001?secret=sentinel', {}, 7001]) {
    assert.throws(() => commandOperation('feed-edit', id));
    assert.throws(() => commandOperation('feed-delete', id));
  }
});

const expected = {
  operation: 'create',
  status: 200,
  messageId: '7001',
  authorId: '9001',
  applicationId: '9002',
  stateRevision: 8,
  eventId: '00000000-0000-4000-8000-000000000001',
};

test('safe evidence projects only independently enumerated fields', () => {
  const projected = safeRestEvidence({
    ...expected,
    token: 'MALICIOUS_SENTINEL',
    env: { secret: 'MALICIOUS_SENTINEL' },
    headers: { authorization: 'MALICIOUS_SENTINEL' },
    payload: { content: 'MALICIOUS_SENTINEL' },
    content: 'MALICIOUS_SENTINEL',
    author: { name: 'MALICIOUS_SENTINEL' },
    extra: 'MALICIOUS_SENTINEL',
  });
  assert.deepEqual(projected, expected);
  assert.equal(JSON.stringify(projected).includes('MALICIOUS_SENTINEL'), false);
  assert.deepEqual(safeRestEvidence({ ...expected, operation: 'edit' }), {
    ...expected,
    operation: 'edit',
  });
  assert.deepEqual(safeRestEvidence({ ...expected, operation: 'delete', status: 204 }), {
    ...expected,
    operation: 'delete',
    status: 204,
  });
});

test('safe evidence rejects tainted allowed fields and missing revision evidence', () => {
  for (const field of [
    'operation',
    'status',
    'messageId',
    'authorId',
    'applicationId',
    'stateRevision',
    'eventId',
  ])
    assert.throws(() => safeRestEvidence({ ...expected, [field]: 'MALICIOUS_SENTINEL' }));
  for (const revision of [null, undefined, -1, 1.5, Number.NaN, Infinity])
    assert.throws(() => safeRestEvidence({ ...expected, stateRevision: revision }));
  assert.throws(() => safeRestEvidence({ ...expected, operation: 'delete', status: 200 }));
});

test('REST credentials can only target the exact injected loopback base', () => {
  assert.equal(
    validateRestBase('http://127.0.0.1:4567/api/v10', 4567),
    'http://127.0.0.1:4567/api/v10',
  );
  for (const base of [
    'https://discord.com/api/v10',
    'http://localhost:4567/api/v10',
    'http://127.0.0.1:4568/api/v10',
    'http://127.0.0.1:4567/api/v10/',
    'http://user:secret@127.0.0.1:4567/api/v10',
    'http://127.0.0.1:4567/api/v10?secret=x',
  ])
    assert.throws(() => validateRestBase(base, 4567));
});

test('import is inert without starting a server or fetching bootstrap', async () => {
  const originalFetch = globalThis.fetch;
  const resources = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap');
  const termListeners = process.listenerCount('SIGTERM');
  const intListeners = process.listenerCount('SIGINT');
  globalThis.fetch = () => {
    throw Error('Import attempted an HTTP request.');
  };
  try {
    const module = await import('../fixtures/g1-parity/live-feed-bot.mjs?import-safety');
    assert.equal(typeof module.commandOperation, 'function');
    assert.deepEqual(
      process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap'),
      resources,
    );
    assert.equal(process.listenerCount('SIGTERM'), termListeners);
    assert.equal(process.listenerCount('SIGINT'), intListeners);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
