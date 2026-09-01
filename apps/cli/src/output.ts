import { sanitizeForExport } from '@disrunner/core';

export function sanitizeOutput<T>(value: T): T {
  return sanitizeForExport(value);
}

export function sanitizeOutputText(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return sanitizeForExport(value);
  }
  const serialized = JSON.stringify(
    sanitizeForExport(parsed),
    (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2,
  );
  if (serialized === undefined) return sanitizeForExport(value);
  return `${serialized}${value.endsWith('\n') ? '\n' : ''}`;
}

export function stringifyForExport(value: unknown): string {
  const sanitized = sanitizeForExport(value);
  return `${JSON.stringify(
    sanitized,
    (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2,
  )}\n`;
}
