import { createHash } from 'node:crypto';
import { types } from 'node:util';

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
  readonly maxCommitSubscribers?: number;
}

export interface StateMutationSummary {
  readonly label: string;
  readonly atMs: number;
  readonly diff: StateDiff;
}

export interface StateCommit {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly previousRevision: number;
  readonly operation:
    | 'create'
    | 'update'
    | 'delete'
    | 'transaction'
    | 'undo'
    | 'redo'
    | 'restore'
    | 'reset'
    | 'import';
  readonly label: string;
  readonly atMs: number;
  readonly diff: StateDiff;
}

export interface RevisionedStateSnapshot {
  readonly revision: number;
  readonly snapshot: StateSnapshot;
}

type StateCommitListener = (commit: StateCommit) => void;

interface CommitSubscription {
  readonly listener: StateCommitListener;
  active: boolean;
}

interface HistoryPlan {
  readonly history: HistoryEntry[];
  readonly position: number;
  readonly bytes: number;
}

interface PendingCommit {
  readonly history: HistoryPlan | undefined;
  readonly commit: StateCommit | undefined;
}

/** Maximum objects visited while resolving then; shadowed prototype nodes are not visited. */
const MAX_THENABLE_PROTO_DEPTH = 64;

export class VirtualState {
  readonly #clock: VirtualClock;
  readonly #snowflakes: SnowflakeGenerator;
  readonly #maxResources: number;
  readonly #maxHistoryEntries: number;
  readonly #maxFixtureBytes: number;
  readonly #maxResourceBytes: number;
  readonly #maxStateBytes: number;
  readonly #maxHistoryBytes: number;
  readonly #maxCommitSubscribers: number;
  readonly #resourceSizes = new Map<string, number>();
  #totalResourceBytes = 0;
  #historyBytes = 0;
  #resources = new Map<string, ResourceRecord>();
  #history: HistoryEntry[] = [];
  #historyPosition = 0;
  #transactionDepth = 0;
  #revision = 0;
  #subscriptions: CommitSubscription[] = [];
  #notifying = false;

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
    this.#maxCommitSubscribers = positiveSafeLimit(
      options.maxCommitSubscribers ?? 100,
      'maxCommitSubscribers',
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
    this.#assertMutationAllowed();
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
    const diff: StateDiff = { added: [deepClone(resource)], updated: [], deleted: [] };
    const pending = this.#prepareCommit('create', `create:${resourceType}/${id}`, diff, diff);
    const created = deepClone(resource);
    this.#resources.set(key, resource);
    this.#resourceSizes.set(key, resourceBytes);
    this.#totalResourceBytes += resourceBytes;
    this.#completeCommit(pending);
    return created;
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
    this.#assertMutationAllowed();
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
    const diff: StateDiff = {
      added: [],
      updated: [
        {
          before: deepClone(current),
          after: deepClone(updated),
          changedFields: changedFields(current, updated),
        },
      ],
      deleted: [],
    };
    const pending = this.#prepareCommit('update', `update:${resourceType}/${id}`, diff, diff);
    const result = deepClone(updated);
    this.#resources.set(key, updated);
    this.#resourceSizes.set(key, updatedBytes);
    this.#totalResourceBytes += updatedBytes - currentBytes;
    this.#completeCommit(pending);
    return result;
  }

  public delete<T extends ResourceRecord = ResourceRecord>(
    resourceType: DiscordResourceType,
    id: string,
  ): T {
    this.#assertMutationAllowed();
    const key = resourceKey(resourceType, id);
    const current = this.#resources.get(key);
    if (current === undefined) throw new ResourceNotFoundError(resourceType, id);
    const currentBytes = this.#resourceSizes.get(key) ?? resourceByteLength(current);
    const diff: StateDiff = { added: [], updated: [], deleted: [deepClone(current)] };
    const pending = this.#prepareCommit('delete', `delete:${resourceType}/${id}`, diff, diff);
    const deleted = deepClone(current) as T;
    this.#resources.delete(key);
    this.#totalResourceBytes -= currentBytes;
    this.#resourceSizes.delete(key);
    this.#completeCommit(pending);
    return deleted;
  }

  /** True while a transaction callback on this instance is running, including nested ones. */
  public get transactionActive(): boolean {
    return this.#transactionDepth > 0;
  }

  public transaction<T>(label: string, operation: () => T): T {
    this.#assertMutationAllowed();
    const before = this.#copyResources();
    const beforeSizes = new Map(this.#resourceSizes);
    const beforeTotalBytes = this.#totalResourceBytes;
    // History arrays are replaced, never edited in place, so keeping the reference keeps the
    // complete entry list, including entries a later trim or redo-branch overwrite would drop.
    const history = this.#history;
    const historyPosition = this.#historyPosition;
    const historyBytes = this.#historyBytes;
    const rollback = (): void => {
      this.#resources = before;
      this.#replaceResourceUsage(beforeSizes, beforeTotalBytes);
      this.#history = history;
      this.#historyPosition = historyPosition;
      this.#historyBytes = historyBytes;
    };
    this.#transactionDepth += 1;
    let result: T;
    try {
      result = operation();
      if (isUnsafeTransactionResult(result)) {
        throw new TypeError(
          'Transaction operations must be synchronous and cannot return a thenable or Proxy.',
        );
      }
    } catch (error) {
      this.#transactionDepth -= 1;
      rollback();
      throw error;
    }
    this.#transactionDepth -= 1;
    if (this.#transactionDepth > 0 || mapsEqual(before, this.#resources)) return result;
    let pending: PendingCommit | undefined;
    try {
      const diff = diffMaps(before, this.#resources);
      pending = this.#prepareCommit('transaction', label, diff, diff);
    } catch (error) {
      rollback();
      throw error;
    }
    this.#completeCommit(pending);
    return result;
  }

  public undo(): boolean {
    this.#assertMutationAllowed();
    if (this.#historyPosition === 0) return false;
    const entry = this.#history[this.#historyPosition - 1];
    if (entry === undefined) return false;
    this.#applyHistoryEntry(entry, 'undo', this.#historyPosition - 1);
    return true;
  }

  public redo(): boolean {
    this.#assertMutationAllowed();
    const entry = this.#history[this.#historyPosition];
    if (entry === undefined) return false;
    this.#applyHistoryEntry(entry, 'redo', this.#historyPosition + 1);
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

  /** Monotonic count of committed net data changes on this instance; starts at 0. */
  public get revision(): number {
    return this.#revision;
  }

  public revisionedSnapshot(): RevisionedStateSnapshot {
    return { revision: this.#revision, snapshot: this.snapshot() };
  }

  public subscribeCommits(listener: (commit: StateCommit) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('A commit listener must be a function.');
    }
    if (this.#subscriptions.length >= this.#maxCommitSubscribers) {
      throw new StateCapacityError(
        `State cannot exceed ${this.#maxCommitSubscribers} commit subscribers.`,
      );
    }
    const subscription: CommitSubscription = { listener, active: true };
    this.#subscriptions = [...this.#subscriptions, subscription];
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.#subscriptions = this.#subscriptions.filter((entry) => entry !== subscription);
    };
  }

  public restore(snapshot: StateSnapshot): void {
    this.#assertMutationAllowed();
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
    const pending = this.#prepareCommit('restore', 'restore-snapshot', diff, diff);
    this.#resources = replacement;
    this.#replaceResourceUsage(replacementSizes, replacementBytes);
    this.#completeCommit(pending);
  }

  public reset(): void {
    this.#assertMutationAllowed();
    const diff = diffMaps(this.#resources, new Map());
    const pending = this.#prepareCommit('reset', 'reset', diff, diff);
    this.#resources = new Map();
    this.#replaceResourceUsage(new Map(), 0);
    this.#completeCommit(pending);
  }

  public clone(): VirtualState {
    return new VirtualState(this.#clock, this.#snowflakes, this.list(), {
      maxResources: this.#maxResources,
      maxHistoryEntries: this.#maxHistoryEntries,
      maxFixtureBytes: this.#maxFixtureBytes,
      maxResourceBytes: this.#maxResourceBytes,
      maxStateBytes: this.#maxStateBytes,
      maxHistoryBytes: this.#maxHistoryBytes,
      maxCommitSubscribers: this.#maxCommitSubscribers,
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
    this.#assertMutationAllowed();
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
    const pending = this.#prepareCommit('import', 'import-fixture', diff, diff);
    this.#resources = replacement;
    this.#replaceResourceUsage(replacementSizes, replacementBytes);
    this.#completeCommit(pending);
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

  #assertMutationAllowed(): void {
    if (this.#notifying) {
      throw new StateConflictError('State cannot be mutated while commit listeners are running.');
    }
    if (this.#revision >= Number.MAX_SAFE_INTEGER) {
      throw new StateCapacityError('State revision cannot exceed Number.MAX_SAFE_INTEGER.');
    }
  }

  /**
   * Computes the history change and commit for one mutation without changing any field. Inside a
   * transaction nothing is recorded; the outermost transaction records its net change instead.
   */
  #prepareCommit(
    operation: StateCommit['operation'],
    label: string,
    historyDiff: StateDiff | undefined,
    commitDiff: StateDiff,
  ): PendingCommit | undefined {
    if (this.#transactionDepth > 0) return undefined;
    let history: HistoryPlan | undefined;
    if (historyDiff !== undefined && !diffIsEmpty(historyDiff)) {
      history = this.#planHistory(label, historyDiff);
    }
    if (!diffHasNetChange(commitDiff)) return { history, commit: undefined };
    const commit: StateCommit = {
      schemaVersion: 1,
      revision: this.#revision + 1,
      previousRevision: this.#revision,
      operation,
      label,
      atMs: this.#clock.now(),
      diff: deepClone(commitDiff),
    };
    return { history, commit };
  }

  /** Applies a prepared commit with plain assignments, then notifies listeners. */
  #completeCommit(pending: PendingCommit | undefined): void {
    if (pending === undefined) return;
    if (pending.history !== undefined) {
      this.#history = pending.history.history;
      this.#historyPosition = pending.history.position;
      this.#historyBytes = pending.history.bytes;
    }
    if (pending.commit === undefined) return;
    this.#revision = pending.commit.revision;
    this.#notify(pending.commit);
  }

  #notify(commit: StateCommit): void {
    const subscriptions = this.#subscriptions;
    this.#notifying = true;
    try {
      for (const subscription of subscriptions) {
        if (!subscription.active) continue;
        try {
          subscription.listener(deepClone(commit));
        } catch {
          // Listener failures are isolated: they cannot undo the commit or block other listeners.
        }
      }
    } finally {
      this.#notifying = false;
    }
  }

  #applyHistoryEntry(entry: HistoryEntry, direction: 'undo' | 'redo', position: number): void {
    const next = new Map(this.#resources);
    applyStateDiff(next, entry.diff, direction);
    if (next.size > this.#maxResources) {
      throw new StateCapacityError(`State cannot exceed ${this.#maxResources} resources.`);
    }
    const usage = this.#measureResources(next);
    // The stored entry can differ from the live state, for example after an undo inside a
    // transaction, so the commit describes the resources actually present before and after.
    const diff = diffMaps(this.#resources, next);
    const pending = this.#prepareCommit(direction, entry.label, undefined, diff);
    this.#resources = next;
    this.#replaceResourceUsage(usage.sizes, usage.total);
    this.#historyPosition = position;
    this.#completeCommit(pending);
  }

  /** Returns the history after recording one entry, without changing the current history. */
  #planHistory(label: string, diff: StateDiff): HistoryPlan {
    let bytes = this.#historyBytes;
    for (const removed of this.#history.slice(this.#historyPosition)) bytes -= removed.bytes;
    const retained = this.#history.slice(0, this.#historyPosition);
    const cloned = deepClone(diff);
    const entryBytes = Buffer.byteLength(stableStringify(cloned));
    if (entryBytes > this.#maxHistoryBytes) {
      // A mutation that cannot be retained is an undo barrier. Keeping older entries would
      // apply their inverse to an incompatible state and could overwrite the newer mutation.
      return { history: [], position: 0, bytes: 0 };
    }
    retained.push({ label, atMs: this.#clock.now(), diff: cloned, bytes: entryBytes });
    bytes += entryBytes;
    let start = 0;
    while (retained.length - start > this.#maxHistoryEntries || bytes > this.#maxHistoryBytes) {
      const removed = retained[start];
      if (removed === undefined) break;
      bytes -= removed.bytes;
      start += 1;
    }
    const history = start === 0 ? retained : retained.slice(start);
    return { history, position: history.length, bytes };
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

  #measureResources(resources: Map<string, ResourceRecord>): {
    readonly sizes: Map<string, number>;
    readonly total: number;
  } {
    const sizes = new Map<string, number>();
    let total = 0;
    for (const [key, resource] of resources) {
      const bytes = resourceByteLength(resource);
      total += bytes;
      if (total > this.#maxStateBytes) {
        throw new StateCapacityError(`State cannot exceed ${this.#maxStateBytes} bytes.`);
      }
      sizes.set(key, bytes);
    }
    return { sizes, total };
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

/** An update whose before and after are identical is kept in history but is not a change. */
function diffHasNetChange(diff: StateDiff): boolean {
  return (
    diff.added.length > 0 ||
    diff.deleted.length > 0 ||
    diff.updated.some((change) => change.changedFields.length > 0)
  );
}

/**
 * Classifies a transaction result without running caller code: no getter, setter, `then`, or
 * Proxy trap is invoked. A Proxy on any object the `then` lookup visits, from the result up to and
 * including the object where the lookup stops, a native Promise result, an accessor or function
 * `then` property, an overly deep prototype chain, and any unexpected failure while inspecting
 * are all treated as unsafe. The lookup stops at the first object that owns a `then` data
 * property whose value is not a function.
 */
function isUnsafeTransactionResult(result: unknown): boolean {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
    return false;
  }
  try {
    let current: object | null = result;
    let depth = 0;
    while (current !== null) {
      depth += 1;
      if (depth > MAX_THENABLE_PROTO_DEPTH) return true;
      if (types.isProxy(current)) return true;
      if (depth === 1 && types.isPromise(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value')) return true;
        return typeof descriptor.value === 'function';
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return true;
  }
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
