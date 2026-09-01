import type { ScenarioRunResult } from './contracts.js';
import { redact, type RedactionOptions } from './redaction.js';

export interface FixtureExportOptions extends RedactionOptions {
  /** Maximum UTF-8 bytes accepted from a string fixture before JSON parsing. */
  readonly maxInputBytes?: number;
}

const DEFAULT_MAX_FIXTURE_INPUT_BYTES = 1_048_576;
const MAX_FIXTURE_INPUT_BYTES = 67_108_864;

/** Returns a detached, recursively redacted value suitable for JSON/file export. */
export function sanitizeForExport<T>(value: T, options: RedactionOptions = {}): T {
  return redact(value, options);
}

export function sanitizeScenarioRunResult(
  result: ScenarioRunResult,
  options: RedactionOptions = {},
): ScenarioRunResult {
  return sanitizeForExport(result, options);
}

export function sanitizeFixtureForExport(fixture: string, options?: FixtureExportOptions): string;
export function sanitizeFixtureForExport<T>(fixture: T, options?: FixtureExportOptions): T;
export function sanitizeFixtureForExport<T>(
  fixture: T | string,
  options: FixtureExportOptions = {},
): T | string {
  const { maxInputBytes: configuredMaxInputBytes, ...redactionOptions } = options;
  if (typeof fixture !== 'string') return sanitizeForExport(fixture, redactionOptions);
  const maxInputBytes = boundedFixtureInputBytes(
    configuredMaxInputBytes ?? DEFAULT_MAX_FIXTURE_INPUT_BYTES,
  );
  if (Buffer.byteLength(fixture) > maxInputBytes) {
    throw new RangeError('Fixture input exceeds maxInputBytes.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fixture) as unknown;
  } catch {
    return sanitizeForExport(fixture, redactionOptions);
  }
  return JSON.stringify(sanitizeForExport(parsed, redactionOptions), null, 2);
}

function boundedFixtureInputBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_FIXTURE_INPUT_BYTES) {
    throw new RangeError(
      `maxInputBytes must be a positive safe integer no greater than ${MAX_FIXTURE_INPUT_BYTES}.`,
    );
  }
  return value;
}
