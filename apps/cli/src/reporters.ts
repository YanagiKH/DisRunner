import {
  sanitizeForExport,
  sanitizeScenarioRunResult,
  type ScenarioRunResult,
  type SimulationReport,
} from '@disrunner/core';
import { stringifyForExport } from './output.js';

export type ReportFormat = 'json' | 'html' | 'junit' | 'sarif';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}

export function toJson(result: ScenarioRunResult): string {
  return stringifyForExport(sanitizeScenarioRunResult(result));
}

export function toJunit(result: ScenarioRunResult): string {
  const safeResult = sanitizeScenarioRunResult(result);
  const failures = safeResult.assertions.filter((assertion) => !assertion.passed);
  const cases = safeResult.assertions
    .map((assertion) => {
      const name = escapeXml(assertion.description ?? assertion.type);
      if (assertion.passed) return `    <testcase name="${name}" />`;
      const message = escapeXml(assertion.message ?? 'Assertion failed');
      return `    <testcase name="${name}"><failure message="${message}">${message}</failure></testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="DisRunner" tests="${safeResult.assertions.length}" failures="${failures.length}">
${cases}
</testsuite>
`;
}

export function toSarif(report: SimulationReport): string {
  const safeReport = sanitizeForExport(report);
  const rules = [...new Map(safeReport.risks.map((risk) => [risk.ruleId, risk])).values()].map(
    (risk) => ({
      id: risk.ruleId,
      shortDescription: { text: risk.title },
      fullDescription: { text: risk.impact },
      help: { text: risk.recommendation },
    }),
  );
  const results = safeReport.risks.map((risk) => ({
    ruleId: risk.ruleId,
    level:
      risk.severity === 'critical' || risk.severity === 'high'
        ? 'error'
        : risk.severity === 'medium'
          ? 'warning'
          : 'note',
    message: { text: `${risk.title}: ${risk.evidence}` },
    properties: { confidence: risk.confidence, traceId: risk.traceId },
  }));
  return stringifyForExport({
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'DisRunner',
            informationUri: 'https://github.com/YanagiKH/DisRunner',
            rules,
          },
        },
        results,
      },
    ],
  });
}

export function toHtml(result: ScenarioRunResult): string {
  const safeResult = sanitizeScenarioRunResult(result);
  const riskRows = safeResult.report.risks
    .map(
      (risk) =>
        `<tr><td>${escapeHtml(risk.ruleId)}</td><td>${escapeHtml(risk.severity)}</td><td>${escapeHtml(risk.title)}</td><td>${escapeHtml(risk.evidence)}</td></tr>`,
    )
    .join('');
  const assertionRows = safeResult.assertions
    .map(
      (assertion) =>
        `<tr><td>${assertion.passed ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(assertion.description ?? assertion.type)}</td><td>${escapeHtml(assertion.message ?? '')}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DisRunner report ${escapeHtml(safeResult.report.runId)}</title>
<style>body{font:15px system-ui;background:#14161b;color:#f3f5fa;margin:0;padding:32px}main{max-width:1120px;margin:auto}h1{font-size:36px}table{width:100%;border-collapse:collapse;margin:20px 0}th,td{padding:10px;border-bottom:1px solid #343a48;text-align:left}.ok{color:#42d392}.bad{color:#f06470}code{color:#9aa8ff}</style></head>
<body><main><h1>DisRunner scenario report</h1><p class="${safeResult.report.passed ? 'ok' : 'bad'}">${safeResult.report.passed ? 'PASSED' : 'FAILED'} · seed ${safeResult.report.seed} · state <code>${escapeHtml(safeResult.report.stateHash)}</code></p>
<h2>Assertions</h2><table><thead><tr><th>Status</th><th>Assertion</th><th>Evidence</th></tr></thead><tbody>${assertionRows}</tbody></table>
<h2>Risks</h2><table><thead><tr><th>Rule</th><th>Severity</th><th>Title</th><th>Evidence</th></tr></thead><tbody>${riskRows}</tbody></table>
<p>${safeResult.report.spans.length} trace spans · ${safeResult.events.length} gateway events</p></main></body></html>\n`;
}

export function renderReport(format: ReportFormat, result: ScenarioRunResult): string {
  switch (format) {
    case 'json':
      return toJson(result);
    case 'html':
      return toHtml(result);
    case 'junit':
      return toJunit(result);
    case 'sarif':
      return toSarif(result.report);
  }
}
