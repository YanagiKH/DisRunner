import { describe, expect, it, vi } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  RiskCollector,
  SeededRandom,
  TraceCollector,
  VirtualClock,
  containsLikelySecret,
  redact,
  redactString,
  sanitizeFixtureForExport,
  sanitizeForExport,
} from '../../src/index.js';

describe('secret and PII redaction', () => {
  it('redacts nested key-based values without mutating the input', () => {
    const input = {
      authorization: 'Bot abcdefghijklmnop',
      nested: { apiKey: 'key-value', safe: 'visible' },
      list: [{ client_secret: 'secret-value' }],
    };
    const output = redact(input);
    expect(output).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'visible' },
      list: [{ client_secret: '[REDACTED]' }],
    });
    expect(input.nested.apiKey).toBe('key-value');
  });

  it('redacts auth headers, Discord webhooks, environment assignments, email, and public IPs', () => {
    const output = redactString(
      'Authorization Bot abcdefghijklmnop https://discord.com/api/webhooks/123/tokenvalue DISCORD_TOKEN=raw user@example.com 8.8.8.8 127.0.0.1',
    );
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('/webhooks/123/tokenvalue');
    expect(output).not.toContain('DISCORD_TOKEN=raw');
    expect(output).not.toContain('user@example.com');
    expect(output).not.toContain('8.8.8.8');
    expect(output).toContain('127.0.0.1');
  });

  it('redacts trace metadata and risk evidence before export', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const traces = new TraceCollector({ clock, random: new SeededRandom(2) });
    const span = traces.start('rest', 'request Bot leaked-name-token-12345678', {
      authorization: 'Bot leaked-token-12345678',
    });
    traces.end(span, 'error', { userEmail: 'person@example.com' });
    const risks = new RiskCollector(clock);
    risks.add({
      ruleId: 'SECRET_IN_REPORT',
      severity: 'critical',
      confidence: 1,
      title: 'Secret',
      evidence: 'Authorization: Bot abcdefghijklmnop',
      impact: 'Leak',
      recommendation: 'Redact',
    });
    const exported = JSON.stringify({ spans: traces.spans(), risks: risks.all() });
    expect(exported).not.toContain('leaked-name-token-12345678');
    expect(exported).not.toContain('leaked-token');
    expect(exported).not.toContain('abcdefghijklmnop');
    expect(exported).not.toContain('person@example.com');
    expect(containsLikelySecret({ authorization: 'Bot abcdefghijklmnop' })).toBe(true);
  });

  it('redacts reserved runtime credentials from values and property names', () => {
    const token = 'disrunner.offline.test-only-token-x';
    const output = redact({ safe: token, [token]: 'hidden-key' });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(token);
    expect(containsLikelySecret({ safe: token })).toBe(true);
    expect(containsLikelySecret({ [token]: 'hidden-key' })).toBe(true);

    const random = new SeededRandom(11);
    const interactionToken = `disrunner.offline.interaction_${random.token(24)}`;
    expect(containsLikelySecret({ safe: interactionToken })).toBe(true);
  });

  it('caps multibyte trace metadata by encoded byte size and validates limits', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const token = 'disrunner.offline.test-only-token-x';
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(3),
      payloadSizeLimitBytes: 256,
    });
    const span = traces.start('rest', token, { safe: token, payload: '🧪'.repeat(1_000) });
    const exported = traces.end(span);
    expect(JSON.stringify(exported)).not.toContain(token);
    expect(Buffer.byteLength(JSON.stringify(exported.metadata))).toBeLessThanOrEqual(256);
    expect(
      () =>
        new TraceCollector({ clock, random: new SeededRandom(4), payloadSizeLimitBytes: Infinity }),
    ).toThrow(RangeError);
    expect(
      () => new TraceCollector({ clock, random: new SeededRandom(5), payloadSizeLimitBytes: 0 }),
    ).toThrow(RangeError);
  });

  it('bounds breadth, nodes, and total strings without invoking accessor properties', () => {
    let getterCalls = 0;
    const wide: Record<string, unknown> = {};
    Object.defineProperty(wide, 'accessor', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    for (let index = 0; index < 20_000; index += 1) {
      wide[`field-${index}`] = 'x'.repeat(256);
    }

    const output = redact(wide, {
      maxDepth: 4,
      maxStringLength: 64,
      maxNodes: 64,
      maxEntriesPerContainer: 32,
      maxTotalStringBytes: 512,
    });
    const serialized = JSON.stringify(output);
    expect(getterCalls).toBe(0);
    expect(Object.keys(output).length).toBeLessThanOrEqual(33);
    expect(Buffer.byteLength(serialized)).toBeLessThan(2_048);
    expect(serialized).toContain('[REDACTION_');

    const afterBreadthLimit: unknown[] = Array.from({ length: 10_001 }, () => 'safe');
    afterBreadthLimit.push({ authorization: 'Bot abcdefghijklmnop' });
    expect(containsLikelySecret(afterBreadthLimit)).toBe(true);

    const secretAfterStringLimit = `${'safe'.repeat(25_001)} Bot abcdefghijklmnop`;
    expect(containsLikelySecret({ safe: secretAfterStringLimit })).toBe(true);

    const oversizedKey = 'x'.repeat(129);
    expect(
      JSON.stringify(redact({ [oversizedKey]: 'opaque-value' }, { maxStringLength: 128 })),
    ).not.toContain('opaque-value');
  });

  it('bounds direct string redaction and validates traversal budgets', () => {
    const bounded = redactString('🧪'.repeat(10_000), {
      maxStringLength: 128,
      maxTotalStringBytes: 256,
    });
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(256);
    expect(bounded).toContain('TRUNCATED');

    expect(() => redact({}, { maxNodes: 0 })).toThrow(RangeError);
    expect(() => redact({}, { maxEntriesPerContainer: Infinity })).toThrow(RangeError);
    expect(() => redact({}, { maxTotalStringBytes: 1 })).toThrow(RangeError);
    expect(() => redactString('safe', { maxStringLength: -1 })).toThrow(RangeError);

    const bigintOutput = redact({ supported: 64n, oversized: 1n << 4_096n });
    expect(bigintOutput.supported).toBe(64n);
    expect(bigintOutput.oversized).toBe('[REDACTION_UNSUPPORTED]');
  });

  it('bounds sparse huge arrays and fails closed for custom properties and cycles', () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    sparse[999_999_999] = 'outside-retained-window';
    const bounded = sanitizeForExport(sparse, {
      maxNodes: 32,
      maxEntriesPerContainer: 16,
      maxStringLength: 64,
      maxTotalStringBytes: 512,
    });
    expect(bounded.length).toBeLessThanOrEqual(18);
    expect(JSON.stringify(bounded)).toContain('[REDACTION_MAX_ENTRIES]');

    const custom = ['safe'];
    Object.defineProperty(custom, 'authorization', {
      enumerable: true,
      value: 'Bot abcdefghijklmnop',
    });
    expect(containsLikelySecret(custom)).toBe(true);
    expect(JSON.stringify(redact(custom))).toContain('[REDACTION_UNSUPPORTED]');

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(JSON.stringify(redact(cyclic))).toContain('[REDACTION_CIRCULAR]');
    expect(containsLikelySecret(cyclic)).toBe(true);
  });

  it('copies repeated references without misclassifying them as cycles', () => {
    const shared = { status: 'safe' };
    const sanitized = redact({ first: shared, second: shared });

    expect(sanitized).toEqual({ first: { status: 'safe' }, second: { status: 'safe' } });
    expect(sanitized.first).not.toBe(sanitized.second);
    expect(JSON.stringify(sanitized)).not.toContain('[REDACTION_CIRCULAR]');
  });

  it('rejects oversized fixture strings before invoking JSON.parse', () => {
    const fixture = JSON.stringify({ safe: 'x'.repeat(256) });
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      expect(() => sanitizeFixtureForExport(fixture, { maxInputBytes: 128 })).toThrow(
        'Fixture input exceeds maxInputBytes.',
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }

    expect(() => sanitizeFixtureForExport('{}', { maxInputBytes: 0 })).toThrow(RangeError);
    expect(() => sanitizeFixtureForExport('{}', { maxInputBytes: 67_108_865 })).toThrow(RangeError);
    expect(() => sanitizeFixtureForExport(JSON.stringify({ safe: 'x'.repeat(1_048_576) }))).toThrow(
      'Fixture input exceeds maxInputBytes.',
    );
    expect(sanitizeFixtureForExport('{"token":"fixture-secret"}', { maxInputBytes: 128 })).toBe(
      '{\n  "token": "[REDACTED]"\n}',
    );
  });
});
