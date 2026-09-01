import { describe, expect, it } from 'vitest';
import type { ScenarioRunResult } from '@disrunner/core';
import { renderReport } from '../src/reporters.js';

const secret = 'Bot abcdefghijklmnopqrstuvwxyz.1234567890';

const fixture = {
  report: {
    runId: 'run-1',
    seed: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    passed: false,
    spans: [],
    risks: [
      {
        ruleId: 'INTERACTION_ACK_LATE',
        severity: 'high',
        confidence: 1,
        title: 'Late acknowledgement',
        evidence: `3420ms ${secret}`,
        impact: 'The interaction fails.',
        recommendation: 'Acknowledge or defer before 3000ms.',
      },
    ],
    stateHash: 'abc123',
  },
  assertions: [
    {
      type: 'deadline',
      passed: false,
      message: `Expected < 3000ms; received ${secret}`,
      description: '3 second deadline',
    },
  ],
  finalState: { version: 1, resources: {} },
  events: [],
} as unknown as ScenarioRunResult;

describe('report formats', () => {
  it('renders JSON without losing the risk', () => {
    expect(renderReport('json', fixture)).toContain('INTERACTION_ACK_LATE');
  });

  it('renders valid report envelopes', () => {
    expect(renderReport('junit', fixture)).toContain('<failure');
    expect(renderReport('sarif', fixture)).toContain('2.1.0');
    expect(renderReport('html', fixture)).toContain('<!doctype html>');
  });

  it('runs every report format through the Core export sanitizer', () => {
    for (const format of ['json', 'junit', 'sarif', 'html'] as const) {
      const rendered = renderReport(format, fixture);
      expect(rendered).not.toContain(secret);
      expect(rendered).toContain('[REDACTED]');
    }
  });
});
