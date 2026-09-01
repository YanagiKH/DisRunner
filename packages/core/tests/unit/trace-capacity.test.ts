import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  RiskCapacityError,
  RiskCollector,
  SeededRandom,
  TraceCapacityError,
  TraceCollector,
  VirtualClock,
} from '../../src/index.js';

describe('collector capacity boundaries', () => {
  it('fails closed at the open-span limit and releases capacity on every end path', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(41),
      maxOpenSpans: 2,
      maxCompletedSpans: 8,
      maxRetainedBytes: 16_384,
    });
    const first = traces.start('rest', 'first');
    const second = traces.start('rest', 'second');

    expect(() => traces.start('rest', 'rejected')).toThrow(TraceCapacityError);
    expect(traces.openSpanCount()).toBe(2);

    traces.end(first, 'error', { status: 401 });
    const replacement = traces.start('rest', 'replacement');
    expect(traces.openSpanCount()).toBe(2);

    const hostileMetadata = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('metadata enumeration failed');
        },
      },
    );
    expect(() => traces.end(second, 'error', hostileMetadata)).toThrow(
      'metadata enumeration failed',
    );
    expect(traces.openSpanCount()).toBe(1);

    traces.end(replacement);
    expect(traces.openSpanCount()).toBe(0);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(16_384);
  });

  it('retains only the newest completed spans in a deterministic count ring', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(42),
      payloadSizeLimitBytes: 256,
      maxOpenSpans: 32,
      maxCompletedSpans: 7,
      maxRetainedBytes: 1_048_576,
    });

    for (let sequence = 0; sequence < 1_000; sequence += 1) {
      const span = traces.start('rest', `request-${sequence}`, { sequence });
      traces.end(span, 'error', { status: sequence % 2 === 0 ? 401 : 404 });
    }

    const retained = traces.spans();
    expect(retained.map((span) => Number(span.name.slice('request-'.length)))).toEqual([
      993, 994, 995, 996, 997, 998, 999,
    ]);
    expect(traces.spans(3).map((span) => Number(span.name.slice('request-'.length)))).toEqual([
      997, 998, 999,
    ]);
    expect(traces.spans(0)).toEqual([]);
    expect(() => traces.spans(-1)).toThrow(RangeError);
    expect(() => traces.spans(Infinity)).toThrow(RangeError);
    expect(traces.openSpanCount()).toBe(0);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(1_048_576);
  });

  it('evicts completed spans to enforce the shared serialized-byte budget', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(45),
      payloadSizeLimitBytes: 256,
      maxOpenSpans: 32,
      maxCompletedSpans: 1_000,
      maxRetainedBytes: 2_048,
    });

    for (let sequence = 0; sequence < 100; sequence += 1) {
      const span = traces.start('rest', `byte-${sequence}`, { payload: 'x'.repeat(512) });
      traces.end(span, 'error', { status: 404 });
    }

    const retained = traces.spans();
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(100);
    expect(retained.at(-1)?.name).toBe('byte-99');
    expect(traces.openSpanCount()).toBe(0);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(2_048);
  });

  it('bounds live-span bytes in addition to the open count', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(43),
      payloadSizeLimitBytes: 256,
      maxOpenSpans: 1_000,
      maxCompletedSpans: 4,
      maxRetainedBytes: 2_048,
    });
    const handles: ReturnType<TraceCollector['start']>[] = [];

    expect(() => {
      for (let index = 0; index < 1_000; index += 1) {
        handles.push(traces.start('rest', `open-${index}`, { payload: 'x'.repeat(512) }));
      }
    }).toThrow(TraceCapacityError);
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.length).toBeLessThan(1_000);
    expect(traces.openSpanCount()).toBe(handles.length);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(2_048);

    for (const handle of handles) traces.end(handle, 'error');
    expect(traces.openSpanCount()).toBe(0);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(2_048);
  });

  it('validates every configured collector capacity as a bounded positive integer', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const random = new SeededRandom(44);
    const invalidTraceOptions = [
      { maxOpenSpans: 0 },
      { maxOpenSpans: Infinity },
      { maxCompletedSpans: -1 },
      { maxCompletedSpans: 1.5 },
      { maxRetainedBytes: 0 },
      { maxRetainedBytes: Number.MAX_SAFE_INTEGER },
    ] as const;
    for (const options of invalidTraceOptions) {
      expect(() => new TraceCollector({ clock, random, ...options })).toThrow(RangeError);
    }

    const invalidRiskOptions = [
      { maxFindings: 0 },
      { maxFindings: Infinity },
      { maxRetainedBytes: -1 },
      { maxRetainedBytes: 1.5 },
      { maxRetainedBytes: Number.MAX_SAFE_INTEGER },
    ] as const;
    for (const options of invalidRiskOptions) {
      expect(() => new RiskCollector(clock, options)).toThrow(RangeError);
    }
  });

  it('fails closed without mutating retained risks when count or byte capacity is exhausted', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const risks = new RiskCollector(clock, { maxFindings: 2, maxRetainedBytes: 2_048 });
    risks.add(finding('FIRST', 'first'));
    risks.add(finding('SECOND', 'second'));

    expect(() => risks.add(finding('THIRD', 'third'))).toThrow(RiskCapacityError);
    expect(risks.all().map((entry) => entry.ruleId)).toEqual(['FIRST', 'SECOND']);

    clock.advanceBy(1);
    const updated = risks.add(finding('FIRST', 'updated'));
    expect(updated.firstSeenAtMs).toBe(DISCORD_EPOCH_MS);
    expect(updated.lastSeenAtMs).toBe(DISCORD_EPOCH_MS + 1);
    expect(risks.all()).toHaveLength(2);

    const byteBounded = new RiskCollector(clock, {
      maxFindings: 10,
      maxRetainedBytes: 1_024,
    });
    expect(() => byteBounded.add(finding('OVERSIZED', 'x'.repeat(4_096)))).toThrow(
      RiskCapacityError,
    );
    expect(byteBounded.all()).toEqual([]);
    expect(byteBounded.retainedByteCount()).toBe(0);

    risks.clear();
    expect(risks.all()).toEqual([]);
    expect(risks.retainedByteCount()).toBe(0);
    expect(() => risks.add(finding('AFTER_CLEAR', 'available'))).not.toThrow();
  });

  it('clones only the requested highest-priority risk snapshot', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const risks = new RiskCollector(clock, { maxFindings: 8, maxRetainedBytes: 8_192 });
    risks.add({ ...finding('LOW', 'low'), severity: 'low' });
    risks.add({ ...finding('CRITICAL_B', 'critical-b'), severity: 'critical' });
    risks.add({ ...finding('HIGH', 'high'), severity: 'high' });
    risks.add({ ...finding('CRITICAL_A', 'critical-a'), severity: 'critical' });

    expect(risks.all(2).map((entry) => entry.ruleId)).toEqual(['CRITICAL_A', 'CRITICAL_B']);
    expect(risks.all(0)).toEqual([]);
    expect(() => risks.all(-1)).toThrow(RangeError);
    expect(() => risks.all(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(risks.all().map((entry) => entry.ruleId)).toEqual([
      'CRITICAL_A',
      'CRITICAL_B',
      'HIGH',
      'LOW',
    ]);
  });

  it('bounds hostile wide trace metadata and risk reproduction arrays before retention checks', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const metadata: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index += 1) {
      metadata[`field-${index}`] = `value-${index}`;
    }
    const traces = new TraceCollector({
      clock,
      random: new SeededRandom(46),
      payloadSizeLimitBytes: 4_096,
      maxOpenSpans: 2,
      maxCompletedSpans: 2,
      maxRetainedBytes: 16_384,
    });
    const span = traces.start('rest', 'wide-metadata', metadata);
    traces.end(span, 'error', metadata);
    expect(traces.openSpanCount()).toBe(0);
    expect(traces.spans()).toHaveLength(1);
    expect(traces.retainedByteCount()).toBeLessThanOrEqual(16_384);

    const risks = new RiskCollector(clock, {
      maxFindings: 2,
      maxRetainedBytes: 4_194_304,
    });
    const added = risks.add({
      ...finding('WIDE', 'wide'),
      reproductionSteps: Array.from({ length: 20_000 }, (_, index) => `step-${index}`),
    });
    expect(added.reproductionSteps?.length).toBe(1_025);
    expect(added.reproductionSteps?.at(-1)).toBe('[REDACTION_MAX_ENTRIES]');
    expect(risks.retainedByteCount()).toBeLessThanOrEqual(4_194_304);
  });
});

function finding(ruleId: string, evidence: string) {
  return {
    ruleId,
    severity: 'medium' as const,
    confidence: 0.9,
    title: ruleId,
    evidence,
    impact: 'Retained test impact.',
    recommendation: 'Retained test recommendation.',
  };
}
