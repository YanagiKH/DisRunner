import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBotCase, evaluateBotStep } from '../dist/bot-case.js';

const canonical = () => ({
  version: 1,
  execution: 'bot',
  name: 'raw ping',
  context: { actorId: '3000', guildId: '1000', channelId: '2000' },
  steps: [
    {
      requestId: 'ping-1',
      input: '/ping',
      expect: { responseType: 'message', content: 'Pong! Offline and deterministic.' },
    },
  ],
});
function freezeCheck(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) freezeCheck(child);
}
const change = (edit) => {
  const value = canonical();
  edit(value);
  return value;
};
test('C01 parser-valid: copied and deeply frozen canonical case without aliases', () => {
  const source = canonical();
  const parsed = parseBotCase(source);
  assert.deepEqual(parsed, source);
  freezeCheck(parsed);
  assert.notEqual(parsed, source);
  assert.notEqual(parsed.context, source.context);
  assert.notEqual(parsed.steps, source.steps);
  assert.notEqual(parsed.steps[0], source.steps[0]);
  assert.notEqual(parsed.steps[0].expect, source.steps[0].expect);
  source.steps[0].expect.content = 'mutated';
  source.context.channelId = '2100';
  assert.equal(parsed.steps[0].expect.content, 'Pong! Offline and deterministic.');
  assert.equal(parsed.context.channelId, '2000');
});
test('C01 parser-valid: exact inclusive byte, step and command bounds', () => {
  const source = canonical();
  source.name = 'é'.repeat(50);
  source.context.actorId = 'é'.repeat(64);
  source.steps = Array.from({ length: 100 }, (_, i) => ({
    requestId: i === 0 ? 'A'.repeat(64) : `p-${i}`,
    input: '/ping ' + 'é'.repeat(997),
    expect: { responseType: 'message', content: 'é'.repeat(1000) },
  }));
  const parsed = parseBotCase(source);
  assert.equal(Buffer.byteLength(parsed.steps[0].input), 2000);
  assert.equal(parsed.steps.length, 100);
  for (const input of ['ping', '/ping', '  /ping hello  ', '_', '/a-b_9', '/' + 'a'.repeat(32)])
    assert.equal(
      parseBotCase(
        change((v) => {
          v.steps[0].input = input;
        }),
      ).steps[0].input,
      input,
    );
  assert.equal(
    parseBotCase(
      change((v) => {
        v.steps[0].expect.content = '';
      }),
    ).steps[0].expect.content,
    '',
  );
});
const invalid = [
  ['null', () => null],
  ['array root', () => []],
  ['string', () => '{}'],
  ['class', () => new Date()],
  [
    'version',
    () =>
      change((v) => {
        v.version = 2;
      }),
  ],
  [
    'execution model',
    () =>
      change((v) => {
        v.execution = 'model';
      }),
  ],
  [
    'missing name',
    () =>
      change((v) => {
        delete v.name;
      }),
  ],
  [
    'name wrong type',
    () =>
      change((v) => {
        v.name = 1;
      }),
  ],
  [
    'name empty',
    () =>
      change((v) => {
        v.name = '';
      }),
  ],
  [
    'name bytes',
    () =>
      change((v) => {
        v.name = 'é'.repeat(51);
      }),
  ],
  [
    'schema',
    () =>
      change((v) => {
        v.$schema = 'x';
      }),
  ],
  [
    'model operation',
    () =>
      change((v) => {
        v.operations = [];
      }),
  ],
  [
    'root unknown',
    () =>
      change((v) => {
        v.timeoutMs = 1;
      }),
  ],
  [
    'context null',
    () =>
      change((v) => {
        v.context = null;
      }),
  ],
  [
    'context array',
    () =>
      change((v) => {
        v.context = [];
      }),
  ],
  [
    'context unknown',
    () =>
      change((v) => {
        v.context.roleId = '1';
      }),
  ],
  [
    'empty steps',
    () =>
      change((v) => {
        v.steps = [];
      }),
  ],
  [
    'steps nonarray',
    () =>
      change((v) => {
        v.steps = {};
      }),
  ],
  [
    'step primitive',
    () =>
      change((v) => {
        v.steps[0] = 'ping';
      }),
  ],
  [
    'missing assertions',
    () =>
      change((v) => {
        delete v.steps[0].expect;
      }),
  ],
  [
    'expect null',
    () =>
      change((v) => {
        v.steps[0].expect = null;
      }),
  ],
  [
    'expect unknown',
    () =>
      change((v) => {
        v.steps[0].expect.regex = '.*';
      }),
  ],
  [
    'expect wrong response',
    () =>
      change((v) => {
        v.steps[0].expect.responseType = 'pong';
      }),
  ],
  [
    'content nonstring',
    () =>
      change((v) => {
        v.steps[0].expect.content = 123;
      }),
  ],
  [
    'content over bytes',
    () =>
      change((v) => {
        v.steps[0].expect.content = 'é'.repeat(1001);
      }),
  ],
  [
    'duplicate id',
    () =>
      change((v) => {
        v.steps.push(structuredClone(v.steps[0]));
      }),
  ],
  [
    'over steps',
    () =>
      change((v) => {
        v.steps = Array.from({ length: 101 }, (_, i) => ({ ...v.steps[0], requestId: `p-${i}` }));
      }),
  ],
  [
    'sparse',
    () =>
      change((v) => {
        v.steps = new Array(2);
        v.steps[1] = canonical().steps[0];
      }),
  ],
  [
    'custom array key',
    () =>
      change((v) => {
        v.steps.extra = 1;
      }),
  ],
  [
    'array symbol',
    () =>
      change((v) => {
        v.steps[Symbol('s')] = 1;
      }),
  ],
  [
    'root symbol',
    () =>
      change((v) => {
        v[Symbol('s')] = 1;
      }),
  ],
  [
    'nonenumerable',
    () =>
      change((v) => {
        Object.defineProperty(v, 'name', { value: 'x', enumerable: false });
      }),
  ],
  [
    'nonplain',
    () =>
      change((v) => {
        Object.setPrototypeOf(v.context, { inherited: true });
      }),
  ],
  [
    'array subclass',
    () =>
      change((v) => {
        v.steps = new (class extends Array {})(v.steps[0]);
      }),
  ],
  [
    'step unknown',
    () =>
      change((v) => {
        v.steps[0].timeoutMs = 5;
      }),
  ],
];
for (const field of ['actorId', 'guildId', 'channelId']) {
  for (const value of ['', null, 1, 'x\0y', 'é'.repeat(65)])
    invalid.push([
      `${field} ${String(value).slice(0, 10)}`,
      () =>
        change((v) => {
          v.context[field] = value;
        }),
    ]);
}
for (const value of ['', 1, 'x'.repeat(65), 'contains space', 'é', 'a.b'])
  invalid.push([
    `requestId ${String(value).slice(0, 10)}`,
    () =>
      change((v) => {
        v.steps[0].requestId = value;
      }),
  ]);
for (const value of [
  '',
  ' ',
  1,
  '//ping',
  '/UPPER',
  '/' + 'a'.repeat(33),
  '/ping!',
  '/ping ' + 'é'.repeat(998),
])
  invalid.push([
    `input ${String(value).slice(0, 12)}`,
    () =>
      change((v) => {
        v.steps[0].input = value;
      }),
  ]);
for (const [name, make] of invalid)
  test(`C02 parser-fail-closed: ${name}`, () =>
    assert.throws(() => parseBotCase(make()), TypeError));
test('C02 parser-fail-closed: accessors never execute at any nested level', () => {
  for (const target of ['root', 'context', 'step', 'expect', 'array']) {
    const value = canonical();
    let calls = 0;
    const [object, key] =
      target === 'root'
        ? [value, 'name']
        : target === 'context'
          ? [value.context, 'actorId']
          : target === 'step'
            ? [value.steps[0], 'input']
            : target === 'expect'
              ? [value.steps[0].expect, 'content']
              : [value.steps, '0'];
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        calls++;
        throw Error('getter executed');
      },
    });
    assert.throws(() => parseBotCase(value), TypeError);
    assert.equal(calls, 0);
  }
});
function result(
  response = { type: 'message', data: { content: 'Pong! Offline and deterministic.' } },
) {
  return {
    ok: true,
    error: null,
    command: 'ping',
    interactionId: 'independent-callback',
    durationMs: 1,
    runId: 'run-1',
    requestId: 'ping-1',
    context: canonical().context,
    response,
  };
}
test('C01 evaluator-valid: independently fixed whole-message oracle and detached actual', () => {
  const observed = result();
  const assertion = evaluateBotStep(parseBotCase(canonical()).steps[0], observed);
  assert.equal(assertion.passed, true);
  observed.response.data.content = 'changed';
  assert.equal(assertion.actual.data.content, 'Pong! Offline and deterministic.');
});
for (const response of [
  null,
  { type: 'pong', data: {} },
  { type: 'defer', data: {} },
  { type: 'message', data: { content: 'WRONG BOT RESPONSE' } },
  { type: 'message', data: { content: 'Pong! Offline and deterministic. ' } },
  { type: 'message', data: {} },
  { type: 'message', data: { content: 123 } },
])
  test(`C13 no-model-shortcut: ${JSON.stringify(response)}`, () =>
    assert.equal(
      evaluateBotStep(parseBotCase(canonical()).steps[0], result(response)).passed,
      false,
    ));
test('C13 no-model-shortcut: model-only success and errors are not observed success', () => {
  const step = parseBotCase(canonical()).steps[0];
  assert.equal(evaluateBotStep(step, { ...result(null), passed: true }).passed, false);
  assert.equal(evaluateBotStep(step, { ...result(), ok: false }).passed, false);
  assert.equal(evaluateBotStep(step, { ...result(), error: 'transport failed' }).passed, false);
});
test('C13 no-model-shortcut: mismatched callback requestId throws TypeError', () => {
  assert.throws(
    () => evaluateBotStep(parseBotCase(canonical()).steps[0], { ...result(), requestId: 'other' }),
    TypeError,
  );
});
