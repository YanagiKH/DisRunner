import { createHash } from 'node:crypto';

import type { DiscordResourceType, ResourceRecord, StateDiff, StateSnapshot } from './contracts.js';
import type { VirtualClock } from './clock.js';
import type { SnowflakeGenerator } from './random.js';

interface HistoryEntry {
  readonly label: string;
  readonly atMs: number;
  readonly diff: StateDiff;
  readonly bytes: number;
}

export interface VirtualStateOptions {
  readonly maxResources?: number;
  readonly maxHistoryEntries?: number;
  readonly maxFixtureBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxStateBytes?: number;
  readonly maxHistoryBytes?: number;
}

export interface StateMutationSummary {
  readonly label: string;
  readonly atMs: number;
  readonly diff: StateDiff;
}

export class VirtualState {
  readonly #clock: VirtualClock;
  readonly #snowflakes: SnowflakeGenerator;
  readonly #maxResources: number;
  readonly #maxHistoryEntries: number;
  readonly #maxFixtureBytes: number;
  readonly #maxResourceBytes: number;
  readonly #maxStateBytes: number;
  readonly #maxHistoryBytes: number;
  readonly #resourceSizes = new Map<string, number>();
  #totalResourceBytes = 0;
  #historyBytes = 0;
  #resources = new Map<string, ResourceRecord>();
  #history: HistoryEntry[] = [];
  #historyPosition = 0;
  #transactionDepth = 0;

  public constructor(
    clock: VirtualClock,
    snowflakes: SnowflakeGenerator,
    initial: readonly ResourceRecord[] = [],
    options: VirtualStateOptions = {},
  ) {
    this.#clock = clock;
    this.#snowflakes = snowflakes;
    this.#maxResources = positiveSafeLimit(options.maxResources ?? 10_000, 'maxResources');
    this.#maxHistoryEntries = positiveSafeLimit(
      options.maxHistoryEntries ?? 1_000,
      'maxHistoryEntries',
    );
    this.#maxFixtureBytes = positiveSafeLimit(
      options.maxFixtureBytes ?? 16 * 1_048_576,
      'maxFixtureBytes',
    );
    this.#maxResourceBytes = positiveSafeLimit(
      options.maxResourceBytes ?? 1_048_576,
      'maxResourceBytes',
    );
    this.#maxStateBytes = positiveSafeLimit(
      options.maxStateBytes ?? 64 * 1_048_576,
      'maxStateBytes',
    );
    this.#maxHistoryBytes = positiveSafeLimit(
      options.maxHistoryBytes ?? 32 * 1_048_576,
      'maxHistoryBytes',
    );
    if (initial.length > this.#maxResources) {
      throw new StateCapacityError(`Initial state exceeds ${this.#maxResources} resources.`);
    }
    for (const resource of initial) this.#setResource(resource, false);
  }

  public create<T extends Readonly<Record<string, unknown>>>(
    resourceType: DiscordResourceType,
    data: T,
  ): T & ResourceRecord {
    const clonedData = cloneBoundedStateValue(data, this.#maxResourceBytes) as T;
    const rawId = clonedData['id'];
    if (rawId !== undefined && typeof rawId !== 'string') {
      throw new TypeError('Resource id must be a string.');
    }
    const id = rawId ?? this.#snowflakes.generate();
    const key = resourceKey(resourceType, id);
    if (this.#resources.has(key)) {
      throw new StateConflictError(`Resource ${resourceType}/${id} already exists.`);
    }
    this.#assertResourceCapacity(1);
    const resource = validateResource(
      { ...clonedData, id, resourceType },
      this.#maxResourceBytes,
    ) as T & ResourceRecord;
    const resourceBytes = resourceByteLength(resource);
    this.#assertStateByteCapacity(resourceBytes);
    this.#resources.set(key, resource);
    this.#resourceSizes.set(key, resourceBytes);
    this.#totalResourceBytes += resourceBytes;
    this.#recordDiff(`create:${resourceType}/${id}`, {
      added: [deepClone(resource)],
      updated: [],
      deleted: [],
    });
    return deepClone(resource);
  }

  public get<T extends ResourceRecord = ResourceRecord>(
    resourceType: DiscordResourceType,
    id: string,
  ): T | undefined {
    const resource = this.#resources.get(resourceKey(resourceType, id));
    return resource === undefined ? undefined : (deepClone(resource) as T);
  }

  public require<T extends ResourceRecord = ResourceRecord>(
    resourceType: DiscordResourceType,
    id: string,
  ): T {
    const resource = this.get<T>(resourceType, id);
    if (resource === undefined) throw new ResourceNotFoundError(resourceType, id);
    return resource;
  }

  public list<T extends ResourceRecord = ResourceRecord>(
    resourceType?: DiscordResourceType,
  ): readonly T[] {
    return [...this.#resources.values()]
      .filter((resource) => resourceType === undefined || resource.resourceType === resourceType)
      .sort(compareResources)
      .map((resource) => deepClone(resource) as T);
  }

  public now(): number {
    return this.#clock.now();
  }

  public update<T extends ResourceRecord = ResourceRecord>(
    resourceType: DiscordResourceType,
    id: string,
    changes: Readonly<Record<string, unknown>>,
  ): T {
    const key = resourceKey(resourceType, id);
    const current = this.#resources.get(key);
    if (current === undefined) throw new ResourceNotFoundError(resourceType, id);
    const clonedChanges = cloneBoundedStateValue(changes, this.#maxResourceBytes) as Readonly<
      Record<string, unknown>
    >;
    if (clonedChanges['id'] !== undefined && clonedChanges['id'] !== id) {
      throw new StateConflictError('A resource id cannot be changed.');
    }
    if (
      clonedChanges['resourceType'] !== undefined &&
      clonedChanges['resourceType'] !== resourceType
    ) {
      throw new StateConflictError('A resource type cannot be changed.');
    }
    const updated = validateResource(
      { ...current, ...clonedChanges, id, resourceType },
      this.#maxResourceBytes,
    ) as T;
    const currentBytes = this.#resourceSizes.get(key) ?? resourceByteLength(current);
    const updatedBytes = resourceByteLength(updated);
    this.#assertStateByteCapacity(updatedBytes - currentBytes);
    this.#resources.set(key, updated);
    this.#resourceSizes.set(key, updatedBytes);
    this.#totalResourceBytes += updatedBytes - currentBytes;
    this.#recordDiff(`update:${resourceType}/${id}`, {
      added: [],
      updated: [
        {
          before: deepClone(current),
          after: deepClone(updated),
          changedFields: changedFields(current, updated),
        },
      ],
      deleted: [],
    });
    return deepClone(updated);
  }

  public delete<T extends ResourceRecord = ResourceRecord>(
    resourceType: DiscordResourceType,
    id: string,
  ): T {
    const key = resourceKey(resourceType, id);
    const current = this.#resources.get(key);
    if (current === undefined) throw new ResourceNotFoundError(resourceType, id);
    this.#resources.delete(key);
    this.#totalResourceBytes -= this.#resourceSizes.get(key) ?? resourceByteLength(current);
    this.#resourceSizes.delete(key);
    this.#recordDiff(`delete:${resourceType}/${id}`, {
      added: [],
      updated: [],
      deleted: [deepClone(current)],
    });
    return deepClone(current) as T;
  }

  public transaction<T>(label: string, operation: () => T): T {
    const before = this.#copyResources();
    const beforeSizes = new Map(this.#resourceSizes);
    const beforeTotalBytes = this.#totalResourceBytes;
    const historyLength = this.#history.length;
    const historyPosition = this.#historyPosition;
    const historyBytes = this.#historyBytes;
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.#transactionDepth -= 1;
      if (this.#transactionDepth === 0 && !mapsEqual(before, this.#resources)) {
        this.#pushHistory(label, diffMaps(before, this.#resources));
      }
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      this.#resources = before;
      this.#resourceSizes.clear();
      for (const [key, bytes] of beforeSizes) this.#resourceSizes.set(key, bytes);
      this.#totalResourceBytes = beforeTotalBytes;
      this.#history = this.#history.slice(0, historyLength);
      this.#historyPosition = historyPosition;
      this.#historyBytes = historyBytes;
      throw error;
    }
  }

  public undo(): boolean {
    if (this.#historyPosition === 0) return false;
    const entry = this.#history[this.#historyPosition - 1];
    if (entry === undefined) return false;
    applyStateDiff(this.#resources, entry.diff, 'undo');
    this.#recalculateResourceUsage();
    this.#historyPosition -= 1;
    return true;
  }

  public redo(): boolean {
    const entry = this.#history[this.#historyPosition];
    if (entry === undefined) return false;
    applyStateDiff(this.#resources, entry.diff, 'redo');
    this.#recalculateResourceUsage();
    this.#historyPosition += 1;
    return true;
  }

  public mutationHistory(): readonly StateMutationSummary[] {
    return this.#history.map((entry) => ({
      label: entry.label,
      atMs: entry.atMs,
      diff: deepClone(entry.diff),
    }));
  }

  public snapshot(): StateSnapshot {
    const resources = this.list();
    return {
      version: 1,
      takenAtMs: this.#clock.now(),
      resources,
      hash: hashResources(resources),
    };
  }

  public restore(snapshot: StateSnapshot): void {
    if (snapshot.version !== 1)
      throw new RangeError(`Unsupported state snapshot version: ${String(snapshot.version)}`);
    if (!Array.isArray(snapshot.resources) || snapshot.resources.length > this.#maxResources) {
      throw new StateCapacityError(`Snapshot exceeds ${this.#maxResources} resources.`);
    }
    const replacement = new Map<string, ResourceRecord>();
    const replacementSizes = new Map<string, number>();
    let replacementBytes = 0;
    for (const resource of snapshot.resources) {
      const validated = validateResource(resource, this.#maxResourceBytes);
      const key = resourceKey(validated.resourceType, validated.id);
      if (replacement.has(key))
        throw new StateConflictError(`Duplicate resource ${key} in snapshot.`);
      const bytes = resourceByteLength(validated);
      replacementBytes += bytes;
      if (replacementBytes > this.#maxStateBytes) {
        throw new StateCapacityError(`Snapshot exceeds ${this.#maxStateBytes} state bytes.`);
      }
      replacement.set(key, validated);
      replacementSizes.set(key, bytes);
    }
    if (hashResources([...replacement.values()]) !== snapshot.hash) {
      throw new StateConflictError('State snapshot hash does not match its resources.');
    }
    const diff = diffMaps(this.#resources, replacement);
    this.#resources = replacement;
    this.#replaceResourceUsage(replacementSizes, replacementBytes);
    this.#recordDiff('restore-snapshot', diff);
  }

  public reset(): void {
    const diff = diffMaps(this.#resources, new Map());
    this.#resources.clear();
    this.#resourceSizes.clear();
    this.#totalResourceBytes = 0;
    this.#recordDiff('reset', diff);
  }

  public clone(): VirtualState {
    return new VirtualState(this.#clock, this.#snowflakes, this.list(), {
      maxResources: this.#maxResources,
      maxHistoryEntries: this.#maxHistoryEntries,
      maxFixtureBytes: this.#maxFixtureBytes,
      maxResourceBytes: this.#maxResourceBytes,
      maxStateBytes: this.#maxStateBytes,
      maxHistoryBytes: this.#maxHistoryBytes,
    });
  }

  public diff(other: VirtualState | StateSnapshot): StateDiff {
    const right = other instanceof VirtualState ? other.#resources : snapshotMap(other);
    return diffMaps(this.#resources, right);
  }

  public exportFixture(space = 2): string {
    return stableStringify({ version: 1, resources: this.list() }, space);
  }

  public importFixture(input: string | { readonly resources: readonly ResourceRecord[] }): void {
    if (typeof input === 'string' && Buffer.byteLength(input) > this.#maxFixtureBytes) {
      throw new StateCapacityError(`Fixture exceeds ${this.#maxFixtureBytes} bytes.`);
    }
    const fixture = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
    if (!isRecord(fixture) || !Array.isArray(fixture['resources'])) {
      throw new TypeError('Fixture must contain a resources array.');
    }
    if (fixture['resources'].length > this.#maxResources) {
      throw new StateCapacityError(`Fixture exceeds ${this.#maxResources} resources.`);
    }
    const replacement = new Map<string, ResourceRecord>();
    const replacementSizes = new Map<string, number>();
    let replacementBytes = 0;
    for (const value of fixture['resources']) {
      const resource = validateResource(value, this.#maxResourceBytes);
      const key = resourceKey(resource.resourceType, resource.id);
      if (replacement.has(key)) throw new StateConflictError(`Duplicate resource ${key}.`);
      const bytes = resourceByteLength(resource);
      replacementBytes += bytes;
      if (replacementBytes > this.#maxStateBytes) {
        throw new StateCapacityError(`Fixture exceeds ${this.#maxStateBytes} state bytes.`);
      }
      replacement.set(key, resource);
      replacementSizes.set(key, bytes);
    }
    const diff = diffMaps(this.#resources, replacement);
    this.#resources = replacement;
    this.#replaceResourceUsage(replacementSizes, replacementBytes);
    this.#recordDiff('import-fixture', diff);
  }

  #setResource(resource: ResourceRecord, rejectDuplicates: boolean): void {
    const validated = validateResource(resource, this.#maxResourceBytes);
    const key = resourceKey(validated.resourceType, validated.id);
    if (rejectDuplicates && this.#resources.has(key)) {
      throw new StateConflictError(`Duplicate resource ${validated.resourceType}/${validated.id}.`);
    }
    if (!this.#resources.has(key)) this.#assertResourceCapacity(1);
    const previousBytes = this.#resourceSizes.get(key) ?? 0;
    const bytes = resourceByteLength(validated);
    this.#assertStateByteCapacity(bytes - previousBytes);
    this.#resources.set(key, validated);
    this.#resourceSizes.set(key, bytes);
    this.#totalResourceBytes += bytes - previousBytes;
  }

  #recordDiff(label: string, diff: StateDiff): void {
    if (this.#transactionDepth > 0 || diffIsEmpty(diff)) return;
    this.#pushHistory(label, diff);
  }

  #pushHistory(label: string, diff: StateDiff): void {
    for (const removed of this.#history.slice(this.#historyPosition)) {
      this.#historyBytes -= removed.bytes;
    }
    this.#history = this.#history.slice(0, this.#historyPosition);
    const cloned = deepClone(diff);
    const bytes = Buffer.byteLength(stableStringify(cloned));
    if (bytes > this.#maxHistoryBytes) {
      // A mutation that cannot be retained is an undo barrier. Keeping older entries would
      // apply their inverse to an incompatible state and could overwrite the newer mutation.
      this.#history = [];
      this.#historyPosition = 0;
      this.#historyBytes = 0;
      return;
    }
    this.#history.push({ label, atMs: this.#clock.now(), diff: cloned, bytes });
    this.#historyBytes += bytes;
    while (
      this.#history.length > this.#maxHistoryEntries ||
      this.#historyBytes > this.#maxHistoryBytes
    ) {
      const removed = this.#history.shift();
      if (removed !== undefined) this.#historyBytes -= removed.bytes;
    }
    this.#historyPosition = this.#history.length;
  }

  #copyResources(): Map<string, ResourceRecord> {
    return cloneMap(this.#resources);
  }

  #assertResourceCapacity(additional: number): void {
    if (this.#resources.size + additional > this.#maxResources) {
      throw new StateCapacityError(`State cannot exceed ${this.#maxResources} resources.`);
    }
  }

  #assertStateByteCapacity(additional: number): void {
    if (this.#totalResourceBytes + additional > this.#maxStateBytes) {
      throw new StateCapacityError(`State cannot exceed ${this.#maxStateBytes} bytes.`);
    }
  }

  #replaceResourceUsage(sizes: Map<string, number>, total: number): void {
    this.#resourceSizes.clear();
    for (const [key, bytes] of sizes) this.#resourceSizes.set(key, bytes);
    this.#totalResourceBytes = total;
  }

  #recalculateResourceUsage(): void {
    const sizes = new Map<string, number>();
    let total = 0;
    for (const [key, resource] of this.#resources) {
      const bytes = resourceByteLength(resource);
      total += bytes;
      if (total > this.#maxStateBytes) {
        throw new StateCapacityError(`State cannot exceed ${this.#maxStateBytes} bytes.`);
      }
      sizes.set(key, bytes);
    }
    this.#replaceResourceUsage(sizes, total);
  }
}

export class ResourceNotFoundError extends Error {
  public readonly code = 10008;
  public constructor(resourceType: DiscordResourceType, id: string) {
    super(`Unknown ${resourceType}: ${id}`);
    this.name = 'ResourceNotFoundError';
  }
}

export class StateConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StateConflictError';
  }
}

export class StateCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StateCapacityError';
  }
}

export function hashResources(resources: readonly ResourceRecord[]): string {
  return createHash('sha256')
    .update(stableStringify([...resources].sort(compareResources)))
    .digest('hex');
}

export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(normalizeForJson(value), undefined, space) ?? 'null';
}

function normalizeForJson(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeForJson(value[key])]),
    );
  }
  return value;
}

function diffMaps(
  left: Map<string, ResourceRecord>,
  right: Map<string, ResourceRecord>,
): StateDiff {
  const added: ResourceRecord[] = [];
  const updated: StateDiff['updated'][number][] = [];
  const deleted: ResourceRecord[] = [];
  for (const [key, resource] of right) {
    const previous = left.get(key);
    if (previous === undefined) {
      added.push(deepClone(resource));
    } else if (stableStringify(previous) !== stableStringify(resource)) {
      updated.push({
        before: deepClone(previous),
        after: deepClone(resource),
        changedFields: changedFields(previous, resource),
      });
    }
  }
  for (const [key, resource] of left) {
    if (!right.has(key)) deleted.push(deepClone(resource));
  }
  return {
    added: added.sort(compareResources),
    updated: updated.sort((a, b) => compareResources(a.after, b.after)),
    deleted: deleted.sort(compareResources),
  };
}

function diffIsEmpty(diff: StateDiff): boolean {
  return diff.added.length === 0 && diff.updated.length === 0 && diff.deleted.length === 0;
}

function applyStateDiff(
  resources: Map<string, ResourceRecord>,
  diff: StateDiff,
  direction: 'undo' | 'redo',
): void {
  if (direction === 'undo') {
    for (const resource of diff.added) {
      resources.delete(resourceKey(resource.resourceType, resource.id));
    }
    for (const change of diff.updated) {
      resources.set(
        resourceKey(change.before.resourceType, change.before.id),
        deepClone(change.before),
      );
    }
    for (const resource of diff.deleted) {
      resources.set(resourceKey(resource.resourceType, resource.id), deepClone(resource));
    }
    return;
  }
  for (const resource of diff.added) {
    resources.set(resourceKey(resource.resourceType, resource.id), deepClone(resource));
  }
  for (const change of diff.updated) {
    resources.set(resourceKey(change.after.resourceType, change.after.id), deepClone(change.after));
  }
  for (const resource of diff.deleted) {
    resources.delete(resourceKey(resource.resourceType, resource.id));
  }
}

function changedFields(before: ResourceRecord, after: ResourceRecord): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableStringify(before[key]) !== stableStringify(after[key]))
    .sort();
}

function snapshotMap(snapshot: StateSnapshot): Map<string, ResourceRecord> {
  return new Map(
    snapshot.resources.map((resource) => [
      resourceKey(resource.resourceType, resource.id),
      resource,
    ]),
  );
}

function mapsEqual(left: Map<string, ResourceRecord>, right: Map<string, ResourceRecord>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || stableStringify(value) !== stableStringify(other)) return false;
  }
  return true;
}

function cloneMap(source: Map<string, ResourceRecord>): Map<string, ResourceRecord> {
  return new Map([...source].map(([key, value]) => [key, deepClone(value)]));
}

function resourceKey(resourceType: DiscordResourceType, id: string): string {
  return `${resourceType}\u0000${id}`;
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return (
    left.resourceType.localeCompare(right.resourceType) || compareSnowflakeLike(left.id, right.id)
  );
}

function compareSnowflakeLike(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return left.localeCompare(right);
}

function validateResource(value: unknown, maxBytes: number): ResourceRecord {
  const cloned = cloneBoundedStateValue(value, maxBytes);
  if (
    !isRecord(cloned) ||
    typeof cloned['id'] !== 'string' ||
    cloned['id'].length === 0 ||
    typeof cloned['resourceType'] !== 'string' ||
    cloned['resourceType'].length === 0
  ) {
    throw new TypeError('Every resource must have non-empty string id and resourceType fields.');
  }
  const resource = cloned as ResourceRecord;
  if (resourceByteLength(resource) > maxBytes) {
    throw new StateCapacityError(`Resource exceeds ${maxBytes} bytes.`);
  }
  return resource;
}

function cloneBoundedStateValue(value: unknown, maxBytes: number): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const charge = (additionalBytes: number): void => {
    bytes += additionalBytes;
    if (bytes > maxBytes) throw new StateCapacityError(`Resource exceeds ${maxBytes} bytes.`);
  };
  const cloneValue = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) {
      throw new StateCapacityError('Resource exceeds the nesting or node limit.');
    }
    if (candidate === null) return candidate;
    if (typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'string') {
      charge(Buffer.byteLength(candidate));
      return candidate;
    } else if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('Resource numbers must be finite.');
      charge(16);
      return candidate;
    } else if (typeof candidate === 'bigint') {
      charge(Buffer.byteLength(candidate.toString()));
      return candidate;
    } else if (typeof candidate === 'object') {
      if (seen.has(candidate)) {
        throw new TypeError('Resource objects must not contain cycles or shared references.');
      }
      seen.add(candidate);
      if (Array.isArray(candidate)) {
        assertDenseStateArray(candidate);
        const cloned: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          cloned.push(cloneValue(candidate[index], depth + 1));
        }
        return cloned;
      } else {
        const prototype = Object.getPrototypeOf(candidate) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('Resource values must contain only plain objects and arrays.');
        }
        if (Object.getOwnPropertySymbols(candidate).length > 0) {
          throw new TypeError('Resource objects must not contain symbol properties.');
        }
        const names = Object.getOwnPropertyNames(candidate);
        if (names.length > 10_000) {
          throw new StateCapacityError('Resource exceeds the nesting or node limit.');
        }
        const cloned: Record<string, unknown> = {};
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
            throw new TypeError('Resource objects must contain only enumerable data properties.');
          }
          charge(Buffer.byteLength(name));
          Object.defineProperty(cloned, name, {
            value: cloneValue(descriptor.value as unknown, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return cloned;
      }
    } else if (candidate !== undefined) {
      throw new TypeError('Resource contains a non-serializable value.');
    } else {
      throw new TypeError('Resource contains an undefined value.');
    }
  };
  return cloneValue(value, 0);
}

function assertDenseStateArray(value: readonly unknown[]): void {
  if (value.length > 10_000) {
    throw new StateCapacityError('Resource exceeds the nesting or node limit.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Resource arrays must not contain symbol properties.');
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[value.length] !== 'length') {
    throw new TypeError('Resource arrays must be dense and must not contain custom properties.');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (names[index] !== String(index)) {
      throw new TypeError('Resource arrays must be dense and must not contain custom properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Resource arrays must contain only data properties.');
    }
  }
}

function resourceByteLength(resource: ResourceRecord): number {
  return Buffer.byteLength(stableStringify(resource));
}

function positiveSafeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
