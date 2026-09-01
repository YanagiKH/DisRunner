import type { RiskFinding, TraceSpan } from './contracts.js';
import type { VirtualClock } from './clock.js';
import type { SeededRandom } from './random.js';
import { redact, redactString, type RedactionOptions } from './redaction.js';

export interface SpanHandle {
  readonly id: string;
  readonly traceId: string;
  readonly startedAtMs: number;
}

interface OpenSpan extends SpanHandle {
  readonly kind: TraceSpan['kind'];
  readonly name: string;
  readonly parentId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface StoredOpenSpan {
  readonly span: OpenSpan;
  readonly sizeBytes: number;
}

interface StoredCompletedSpan {
  readonly span: TraceSpan;
  readonly sizeBytes: number;
}

export interface TraceCollectorOptions {
  readonly clock: VirtualClock;
  readonly random: SeededRandom;
  readonly payloadSizeLimitBytes?: number;
  /** Maximum concurrently open spans. Reaching it rejects new spans. */
  readonly maxOpenSpans?: number;
  /** Maximum completed spans retained; the oldest record is evicted first. */
  readonly maxCompletedSpans?: number;
  /** Serialized byte budget shared by open and completed spans. */
  readonly maxRetainedBytes?: number;
}

export interface RiskCollectorOptions {
  /** Maximum distinct findings retained. Reaching it rejects a new finding key. */
  readonly maxFindings?: number;
  /** Serialized byte budget for retained findings. */
  readonly maxRetainedBytes?: number;
}

export class TraceCapacityError extends Error {
  public constructor(resource: 'open spans' | 'retained bytes') {
    super(`Trace ${resource} capacity was reached.`);
    this.name = 'TraceCapacityError';
  }
}

export class RiskCapacityError extends Error {
  public constructor(resource: 'findings' | 'retained bytes') {
    super(`Risk ${resource} capacity was reached.`);
    this.name = 'RiskCapacityError';
  }
}

const DEFAULT_MAX_OPEN_SPANS = 512;
const DEFAULT_MAX_COMPLETED_SPANS = 4_096;
const DEFAULT_MAX_TRACE_RETAINED_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_MAX_FINDINGS = 1_024;
const DEFAULT_MAX_RISK_RETAINED_BYTES = 8 * 1_024 * 1_024;
const MAX_COLLECTOR_ENTRIES = 1_000_000;
const MAX_COLLECTOR_RETAINED_BYTES = 1_024 * 1_024 * 1_024;
const TRACE_REDACTION_OPTIONS: RedactionOptions = {
  maxDepth: 16,
  maxStringLength: 16_384,
  maxNodes: 2_048,
  maxEntriesPerContainer: 512,
  maxTotalStringBytes: 1_048_576,
};
const RISK_REDACTION_OPTIONS: RedactionOptions = {
  maxDepth: 16,
  maxStringLength: 32_768,
  maxNodes: 4_096,
  maxEntriesPerContainer: 1_024,
  maxTotalStringBytes: 2_097_152,
};
const TRACE_NAME_REDACTION_OPTIONS: RedactionOptions = {
  maxStringLength: 4_096,
  maxTotalStringBytes: 8_192,
};

export class TraceCollector {
  readonly #clock: VirtualClock;
  readonly #random: SeededRandom;
  readonly #payloadSizeLimitBytes: number;
  readonly #maxOpenSpans: number;
  readonly #maxCompletedSpans: number;
  readonly #maxRetainedBytes: number;
  readonly #open = new Map<string, StoredOpenSpan>();
  readonly #completed: Array<StoredCompletedSpan | undefined>;
  #openBytes = 0;
  #completedBytes = 0;
  #completedHead = 0;
  #completedCount = 0;

  public constructor(options: TraceCollectorOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#payloadSizeLimitBytes = boundedPayloadLimit(options.payloadSizeLimitBytes ?? 256 * 1_024);
    this.#maxOpenSpans = boundedPositiveCapacity(
      options.maxOpenSpans ?? DEFAULT_MAX_OPEN_SPANS,
      'maxOpenSpans',
      MAX_COLLECTOR_ENTRIES,
    );
    this.#maxCompletedSpans = boundedPositiveCapacity(
      options.maxCompletedSpans ?? DEFAULT_MAX_COMPLETED_SPANS,
      'maxCompletedSpans',
      MAX_COLLECTOR_ENTRIES,
    );
    this.#maxRetainedBytes = boundedPositiveCapacity(
      options.maxRetainedBytes ?? DEFAULT_MAX_TRACE_RETAINED_BYTES,
      'maxRetainedBytes',
      MAX_COLLECTOR_RETAINED_BYTES,
    );
    this.#completed = new Array<StoredCompletedSpan | undefined>(this.#maxCompletedSpans);
  }

  public start(
    kind: TraceSpan['kind'],
    name: string,
    metadata: Readonly<Record<string, unknown>> = {},
    parent?: SpanHandle,
  ): SpanHandle {
    if (this.#open.size >= this.#maxOpenSpans) {
      throw new TraceCapacityError('open spans');
    }
    const id = `span_${this.#random.token(12)}`;
    const handle: OpenSpan = {
      id,
      traceId: parent?.traceId ?? `trace_${this.#random.token(16)}`,
      startedAtMs: this.#clock.now(),
      kind,
      name: redactString(name, TRACE_NAME_REDACTION_OPTIONS),
      ...(parent === undefined ? {} : { parentId: parent.id }),
      metadata: limitMetadata(
        redact(metadata, TRACE_REDACTION_OPTIONS),
        this.#payloadSizeLimitBytes,
      ),
    };
    const sizeBytes = serializedByteLength(handle);
    if (this.#openBytes + sizeBytes > this.#maxRetainedBytes) {
      throw new TraceCapacityError('retained bytes');
    }
    this.#evictCompletedForBytes(sizeBytes);
    this.#open.set(id, { span: handle, sizeBytes });
    this.#openBytes += sizeBytes;
    return { id: handle.id, traceId: handle.traceId, startedAtMs: handle.startedAtMs };
  }

  public end(
    handle: SpanHandle,
    status: TraceSpan['status'] = 'ok',
    metadata: Readonly<Record<string, unknown>> = {},
  ): TraceSpan {
    const storedOpen = this.#open.get(handle.id);
    if (storedOpen === undefined)
      throw new Error(`Unknown or already completed trace span: ${handle.id}`);
    this.#open.delete(handle.id);
    this.#openBytes -= storedOpen.sizeBytes;
    const open = storedOpen.span;
    const sanitizedEndMetadata = redact(metadata, TRACE_REDACTION_OPTIONS);
    const span: TraceSpan = {
      id: open.id,
      traceId: open.traceId,
      ...(open.parentId === undefined ? {} : { parentId: open.parentId }),
      kind: open.kind,
      name: open.name,
      startedAtMs: open.startedAtMs,
      durationMs: Math.max(0, this.#clock.now() - open.startedAtMs),
      status,
      metadata: limitMetadata(
        { ...open.metadata, ...sanitizedEndMetadata },
        this.#payloadSizeLimitBytes,
      ),
    };
    this.#retainCompleted(span);
    return structuredClone(span);
  }

  public async withSpan<T>(
    kind: TraceSpan['kind'],
    name: string,
    operation: (handle: SpanHandle) => T | Promise<T>,
    metadata: Readonly<Record<string, unknown>> = {},
    parent?: SpanHandle,
  ): Promise<T> {
    const span = this.start(kind, name, metadata, parent);
    try {
      const result = await operation(span);
      this.end(span, 'ok');
      return result;
    } catch (error) {
      this.end(span, 'error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Returns detached completed spans in chronological order. When `limit` is
   * provided, only the newest records are cloned.
   */
  public spans(limit?: number): readonly TraceSpan[] {
    const requested =
      limit === undefined ? this.#completedCount : boundedSnapshotLimit(limit, 'span limit');
    const count = Math.min(requested, this.#completedCount);
    const spans: TraceSpan[] = [];
    const firstOffset = this.#completedCount - count;
    for (let offset = firstOffset; offset < this.#completedCount; offset += 1) {
      const stored = this.#completed[(this.#completedHead + offset) % this.#maxCompletedSpans];
      if (stored !== undefined) spans.push(structuredClone(stored.span));
    }
    return spans;
  }

  public openSpanCount(): number {
    return this.#open.size;
  }

  /** Serialized bytes retained by open and completed span records. */
  public retainedByteCount(): number {
    return this.#openBytes + this.#completedBytes;
  }

  public clear(): void {
    this.#open.clear();
    this.#completed.fill(undefined);
    this.#openBytes = 0;
    this.#completedBytes = 0;
    this.#completedHead = 0;
    this.#completedCount = 0;
  }

  #retainCompleted(span: TraceSpan): void {
    const sizeBytes = serializedByteLength(span);
    // An end operation always releases its open span. If this completed record cannot fit
    // alongside other live spans, return it to the caller without retaining it.
    if (this.#openBytes + sizeBytes > this.#maxRetainedBytes) return;
    while (this.#completedCount >= this.#maxCompletedSpans) {
      this.#evictOldestCompleted();
    }
    this.#evictCompletedForBytes(sizeBytes);
    const index = (this.#completedHead + this.#completedCount) % this.#maxCompletedSpans;
    this.#completed[index] = { span, sizeBytes };
    this.#completedCount += 1;
    this.#completedBytes += sizeBytes;
  }

  #evictCompletedForBytes(additionalBytes: number): void {
    while (
      this.retainedByteCount() + additionalBytes > this.#maxRetainedBytes &&
      this.#completedCount > 0
    ) {
      this.#evictOldestCompleted();
    }
  }

  #evictOldestCompleted(): void {
    const stored = this.#completed[this.#completedHead];
    if (stored === undefined) throw new Error('Trace completion ring is inconsistent.');
    this.#completed[this.#completedHead] = undefined;
    this.#completedHead = (this.#completedHead + 1) % this.#maxCompletedSpans;
    this.#completedCount -= 1;
    this.#completedBytes -= stored.sizeBytes;
  }
}

export class RiskCollector {
  readonly #clock: VirtualClock;
  readonly #findings = new Map<
    string,
    { readonly finding: RiskFinding; readonly sizeBytes: number }
  >();
  readonly #maxFindings: number;
  readonly #maxRetainedBytes: number;
  #retainedBytes = 0;

  public constructor(clock: VirtualClock, options: RiskCollectorOptions = {}) {
    this.#clock = clock;
    this.#maxFindings = boundedPositiveCapacity(
      options.maxFindings ?? DEFAULT_MAX_FINDINGS,
      'maxFindings',
      MAX_COLLECTOR_ENTRIES,
    );
    this.#maxRetainedBytes = boundedPositiveCapacity(
      options.maxRetainedBytes ?? DEFAULT_MAX_RISK_RETAINED_BYTES,
      'maxRetainedBytes',
      MAX_COLLECTOR_RETAINED_BYTES,
    );
  }

  public add(finding: RiskFinding): RiskFinding {
    if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      throw new RangeError('Risk confidence must be between 0 and 1.');
    }
    const sanitized = redact(finding, RISK_REDACTION_OPTIONS);
    const key = `${sanitized.ruleId}:${sanitized.traceId ?? ''}:${sanitized.eventId ?? ''}`;
    const previous = this.#findings.get(key);
    const merged: RiskFinding = {
      ...sanitized,
      firstSeenAtMs:
        previous?.finding.firstSeenAtMs ?? sanitized.firstSeenAtMs ?? this.#clock.now(),
      lastSeenAtMs: sanitized.lastSeenAtMs ?? this.#clock.now(),
    };
    if (previous === undefined && this.#findings.size >= this.#maxFindings) {
      throw new RiskCapacityError('findings');
    }
    const sizeBytes = serializedByteLength(merged);
    const nextRetainedBytes = this.#retainedBytes - (previous?.sizeBytes ?? 0) + sizeBytes;
    if (nextRetainedBytes > this.#maxRetainedBytes) {
      throw new RiskCapacityError('retained bytes');
    }
    this.#findings.set(key, { finding: merged, sizeBytes });
    this.#retainedBytes = nextRetainedBytes;
    return structuredClone(merged);
  }

  public analyzeSpans(spans: readonly TraceSpan[]): readonly RiskFinding[] {
    const added: RiskFinding[] = [];
    for (const span of spans) {
      if (span.kind === 'interaction' && span.durationMs >= 3_000) {
        added.push(
          this.add({
            ruleId: 'INTERACTION_ACK_LATE',
            severity: 'high',
            confidence: 0.98,
            title: 'Interaction acknowledgement is late',
            evidence: `${span.name} took ${span.durationMs} ms.`,
            impact:
              'Discord can invalidate an interaction that is not initially acknowledged within 3 seconds.',
            recommendation: 'Defer or reply before starting slow work.',
            traceId: span.traceId,
          }),
        );
      }
      if (span.kind === 'bot-handler' && span.durationMs >= 1_000) {
        added.push(
          this.add({
            ruleId: 'BLOCKING_HANDLER',
            severity: span.durationMs >= 3_000 ? 'high' : 'medium',
            confidence: 0.85,
            title: 'Slow bot handler',
            evidence: `${span.name} occupied ${span.durationMs} ms.`,
            impact: 'Slow handlers increase acknowledgement and queue latency.',
            recommendation:
              'Move slow work after an acknowledgement and avoid blocking the event loop.',
            traceId: span.traceId,
          }),
        );
      }
    }
    return added;
  }

  /**
   * Returns detached findings ordered by severity and rule ID. When `limit` is
   * provided, only that many highest-priority findings are cloned.
   */
  public all(limit?: number): readonly RiskFinding[] {
    const requested =
      limit === undefined ? undefined : boundedSnapshotLimit(limit, 'finding limit');
    if (requested === 0) return [];
    const findings = [...this.#findings.values()].map(({ finding }) => finding);
    findings.sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        left.ruleId.localeCompare(right.ruleId),
    );
    if (requested !== undefined && findings.length > requested) findings.length = requested;
    return findings.map((finding) => structuredClone(finding));
  }

  public has(ruleId: string): boolean {
    return [...this.#findings.values()].some(({ finding }) => finding.ruleId === ruleId);
  }

  /** Serialized bytes retained by finding records. */
  public retainedByteCount(): number {
    return this.#retainedBytes;
  }

  public clear(): void {
    this.#findings.clear();
    this.#retainedBytes = 0;
  }
}

function limitMetadata(
  metadata: Readonly<Record<string, unknown>>,
  limitBytes: number,
): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(metadata, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (Buffer.byteLength(serialized) <= limitBytes) return metadata;
  const originalSizeBytes = Buffer.byteLength(serialized);
  let low = 0;
  let high = originalSizeBytes;
  let result: Readonly<Record<string, unknown>> = { truncated: true, originalSizeBytes };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      truncated: true,
      originalSizeBytes,
      preview: truncateUtf8(serialized, middle),
    };
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (candidateBytes <= limitBytes) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function boundedPayloadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 128 || value > 67_108_864) {
    throw new RangeError(
      'payloadSizeLimitBytes must be a safe integer from 128 bytes through 64 MiB.',
    );
  }
  return value;
}

function boundedPositiveCapacity(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function boundedSnapshotLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COLLECTOR_ENTRIES) {
    throw new RangeError(
      `${label} must be a non-negative safe integer no greater than ${MAX_COLLECTOR_ENTRIES}.`,
    );
  }
  return value;
}

function serializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
  return Buffer.byteLength(serialized ?? 'null');
}

function severityRank(severity: RiskFinding['severity']): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}
