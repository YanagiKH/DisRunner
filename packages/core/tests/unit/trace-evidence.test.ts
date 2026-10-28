import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/clock.js';
import type { RiskFinding } from '../../src/contracts.js';
import { SeededRandom } from '../../src/random.js';
import {
  RiskCapacityError,
  RiskCollector,
  TraceCapacityError,
  TraceCollector,
} from '../../src/trace.js';

function traces(
  options: {
    maxCompletedSpans?: number;
    maxOpenSpans?: number;
    maxRetainedBytes?: number;
    payloadSizeLimitBytes?: number;
  } = {},
) {
  return new TraceCollector({
    clock: new VirtualClock(),
    random: new SeededRandom(42042),
    ...options,
  });
}

function finding(
  ruleId: string,
  severity: RiskFinding['severity'] = 'high',
  evidence = 'Observed failure',
): RiskFinding {
  return {
    ruleId,
    severity,
    evidence,
    confidence: 1,
    title: ruleId,
    impact: 'Failed operation',
    recommendation: 'Fix the operation',
  };
}

describe('trace evidence completeness', () => {
  it('reports exact count eviction and does not mistake a requested projection for lost history', () => {
    const collector = traces({ maxCompletedSpans: 2 });
    for (let index = 0; index < 5; index += 1)
      collector.end(collector.start('rest', `request-${index}`));
    expect(collector.evidence()).toMatchObject({
      startedSpans: 5,
      completedSpans: 5,
      retainedSpans: 2,
      openSpans: 0,
      evictedSpans: 3,
      evictedByCount: 3,
      evictedByBytes: 0,
      discardedSpans: 0,
      rejectedSpans: 0,
      droppedSpans: 3,
      complete: false,
    });
    const beforeProjection = collector.evidence();
    expect(collector.spans(1)).toHaveLength(1);
    expect(collector.spans(0)).toEqual([]);
    expect(collector.evidence()).toEqual(beforeProjection);

    const complete = traces();
    for (let index = 0; index < 5; index += 1) complete.end(complete.start('rest', 'kept'));
    expect(complete.spans(1)).toHaveLength(1);
    expect(complete.evidence()).toMatchObject({
      retainedSpans: 5,
      droppedSpans: 0,
      complete: true,
    });
  });

  it('accounts for every byte-budget eviction while retaining a bounded recent history', () => {
    const collector = traces({ maxCompletedSpans: 100, maxRetainedBytes: 1_024 });
    for (let index = 0; index < 20; index += 1)
      collector.end(collector.start('rest', `request-${index}`));
    const evidence = collector.evidence();
    expect(evidence.retainedSpans).toBeGreaterThan(0);
    expect(evidence.retainedSpans).toBeLessThan(20);
    expect(evidence.evictedByBytes).toBe(20 - evidence.retainedSpans);
    expect(evidence.evictedByCount).toBe(0);
    expect(evidence.droppedSpans).toBe(evidence.evictedByBytes);
    expect(evidence.retainedBytes).toBeLessThanOrEqual(1_024);
    expect(evidence.complete).toBe(false);
  });

  it('marks unretained completions, failed metadata collection and rejected starts as missing evidence', () => {
    const oversized = traces({ maxRetainedBytes: 300 });
    oversized.end(oversized.start('rest', 'request'), 'error', { content: 'x'.repeat(150) });
    expect(oversized.spans()).toEqual([]);
    expect(oversized.evidence()).toMatchObject({
      startedSpans: 1,
      completedSpans: 1,
      discardedSpans: 1,
      droppedSpans: 1,
      complete: false,
    });

    const broken = traces();
    const handle = broken.start('rest', 'request');
    const hostile = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys() {
          throw new Error('Cannot collect metadata');
        },
      },
    );
    expect(() => broken.end(handle, 'error', hostile)).toThrow('Cannot collect metadata');
    expect(broken.evidence()).toMatchObject({
      openSpans: 0,
      completedSpans: 0,
      discardedSpans: 1,
      droppedSpans: 1,
      complete: false,
    });

    const capped = traces({ maxOpenSpans: 1 });
    capped.start('rest', 'first');
    expect(() => capped.start('rest', 'missing')).toThrow(TraceCapacityError);
    expect(capped.evidence()).toMatchObject({
      startedSpans: 1,
      rejectedSpans: 1,
      droppedSpans: 1,
      complete: false,
    });
  });

  it('reports payload truncation and resets history for a new collection', () => {
    const collector = traces({ payloadSizeLimitBytes: 128 });
    collector.end(collector.start('rest', 'bounded', { content: '界'.repeat(500) }));
    expect(collector.evidence()).toMatchObject({
      droppedSpans: 0,
      truncatedPayloads: 1,
      complete: false,
    });
    collector.clear();
    expect(collector.evidence()).toMatchObject({
      startedSpans: 0,
      completedSpans: 0,
      retainedSpans: 0,
      droppedSpans: 0,
      truncatedPayloads: 0,
      retainedBytes: 0,
      complete: true,
    });
    collector.end(collector.start('rest', 'fresh'));
    expect(collector.evidence()).toMatchObject({
      startedSpans: 1,
      completedSpans: 1,
      droppedSpans: 0,
      complete: true,
    });
  });
});

describe('risk evidence completeness', () => {
  it('keeps the highest severity when aggregating the same finding key', () => {
    const clock = new VirtualClock();
    const collector = new RiskCollector(clock);
    collector.add(finding('FAILED', 'high', 'Original high severity evidence'));
    clock.advanceBy(10);
    collector.add(finding('FAILED', 'medium', 'Later less severe occurrence'));
    expect(collector.all()).toHaveLength(1);
    expect(collector.all()[0]).toMatchObject({
      severity: 'high',
      evidence: 'Original high severity evidence',
      lastSeenAtMs: clock.now(),
    });
    expect(collector.evidence()).toMatchObject({
      totalFindings: 2,
      retainedFindings: 1,
      aggregatedFindings: 1,
      rejectedFindings: 0,
      droppedFindings: 0,
      truncatedFindings: 0,
      complete: true,
    });
    collector.add(finding('FAILED', 'critical', 'New critical evidence'));
    expect(collector.all()[0]).toMatchObject({
      severity: 'critical',
      evidence: 'New critical evidence',
    });
    expect(collector.evidence()).toMatchObject({
      totalFindings: 3,
      aggregatedFindings: 2,
      complete: true,
    });
  });

  it('records capacity rejection without hiding it behind the limited finding projection', () => {
    const collector = new RiskCollector(new VirtualClock(), { maxFindings: 2 });
    collector.add(finding('FIRST'));
    collector.add(finding('SECOND'));
    expect(() => collector.add(finding('MISSING', 'critical'))).toThrow(RiskCapacityError);
    expect(collector.all(1)).toHaveLength(1);
    expect(collector.evidence()).toMatchObject({
      totalFindings: 3,
      retainedFindings: 2,
      aggregatedFindings: 0,
      rejectedFindings: 1,
      droppedFindings: 1,
      complete: false,
    });
    collector.clear();
    expect(collector.evidence()).toEqual({
      totalFindings: 0,
      retainedFindings: 0,
      aggregatedFindings: 0,
      rejectedFindings: 0,
      droppedFindings: 0,
      truncatedFindings: 0,
      retainedBytes: 0,
      complete: true,
    });
  });

  it('marks bounded redaction representations as incomplete rather than losing reproduction evidence silently', () => {
    const collector = traces();
    collector.end(collector.start('rest', 'bounded', { content: 'x'.repeat(20_000) }));
    expect(collector.evidence().truncatedPayloads).toBeGreaterThan(0);
    expect(collector.evidence().complete).toBe(false);
    const named = traces();
    named.end(named.start('rest', 'x'.repeat(5_000)));
    expect(named.evidence()).toMatchObject({ truncatedPayloads: 1, complete: false });
    const risks = new RiskCollector(new VirtualClock());
    risks.add({
      ...finding('WIDE'),
      reproductionSteps: Array.from({ length: 2_000 }, () => 'reproduction step'),
    });
    expect(risks.evidence()).toMatchObject({
      retainedFindings: 1,
      droppedFindings: 0,
      truncatedFindings: 1,
      complete: false,
    });
  });
});
