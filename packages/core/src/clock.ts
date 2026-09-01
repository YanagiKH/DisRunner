export type VirtualClockMode = 'paused' | 'realtime' | 'accelerated';

export interface VirtualClockOptions {
  readonly nowMs?: number;
  readonly mode?: VirtualClockMode;
  readonly speed?: number;
  readonly maxScheduledTasks?: number;
  readonly maxCallbacksPerAdvance?: number;
}

interface ScheduledTask {
  readonly id: number;
  readonly dueAtMs: number;
  readonly callback: () => void;
}

/** A manually controllable clock. No wall-clock timer is created in paused mode. */
export class VirtualClock {
  readonly #wallStartedAtMs: number;
  readonly #virtualStartedAtMs: number;
  readonly #tasks: ScheduledTask[] = [];
  readonly #taskIndexes = new Map<number, number>();
  readonly #maxScheduledTasks: number;
  readonly #maxCallbacksPerAdvance: number;
  #mode: VirtualClockMode;
  #speed: number;
  #pausedNowMs: number;
  #nextTaskId = 1;
  #runningTasks = false;

  public constructor(options: VirtualClockOptions = {}) {
    const nowMs = options.nowMs ?? Date.now();
    assertFiniteTime(nowMs);
    this.#mode = options.mode ?? 'paused';
    if (!['paused', 'realtime', 'accelerated'].includes(this.#mode)) {
      throw new RangeError('Virtual clock mode is invalid.');
    }
    this.#speed = options.speed ?? 1;
    if (!Number.isFinite(this.#speed) || this.#speed <= 0) {
      throw new RangeError('Virtual clock speed must be a positive finite number.');
    }
    this.#pausedNowMs = nowMs;
    this.#wallStartedAtMs = Date.now();
    this.#virtualStartedAtMs = nowMs;
    this.#maxScheduledTasks = boundedClockLimit(
      options.maxScheduledTasks ?? 100_000,
      'maxScheduledTasks',
    );
    this.#maxCallbacksPerAdvance = boundedClockLimit(
      options.maxCallbacksPerAdvance ?? 100_000,
      'maxCallbacksPerAdvance',
    );
  }

  public get mode(): VirtualClockMode {
    return this.#mode;
  }

  public now(): number {
    if (this.#mode === 'paused') return this.#pausedNowMs;
    return this.#virtualStartedAtMs + (Date.now() - this.#wallStartedAtMs) * this.#speed;
  }

  public pause(): void {
    this.#pausedNowMs = this.now();
    this.#mode = 'paused';
  }

  public set(timeMs: number): void {
    assertFiniteTime(timeMs);
    if (timeMs < this.now()) {
      throw new RangeError('Virtual time cannot move backwards.');
    }
    this.#mode = 'paused';
    this.#runUntil(timeMs);
  }

  public advanceBy(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('Advance duration must be a non-negative finite number.');
    }
    this.pause();
    this.#runUntil(this.#pausedNowMs + durationMs);
    return this.#pausedNowMs;
  }

  public schedule(delayMs: number, callback: () => void): number {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('Schedule delay must be a non-negative finite number.');
    }
    if (this.#tasks.length >= this.#maxScheduledTasks) {
      throw new ClockCapacityError(
        `Virtual clock cannot retain more than ${this.#maxScheduledTasks} scheduled tasks.`,
      );
    }
    if (!Number.isSafeInteger(this.#nextTaskId)) {
      throw new ClockCapacityError('Virtual clock task identifiers are exhausted.');
    }
    const dueAtMs = this.now() + delayMs;
    assertFiniteTime(dueAtMs);
    const id = this.#nextTaskId++;
    this.#insertTask({ id, dueAtMs, callback });
    if (delayMs === 0 && this.#mode === 'paused' && !this.#runningTasks) {
      this.#runUntil(this.#pausedNowMs);
    }
    return id;
  }

  public cancel(taskId: number): boolean {
    const index = this.#taskIndexes.get(taskId);
    if (index === undefined) return false;
    this.#removeTask(index);
    return true;
  }

  public pendingTasks(): number {
    return this.#tasks.length;
  }

  #runUntil(targetTimeMs: number): void {
    if (this.#runningTasks) {
      throw new ClockCapacityError(
        'Virtual time cannot advance recursively from a scheduled task.',
      );
    }
    this.#runningTasks = true;
    let callbacks = 0;
    try {
      for (;;) {
        const next = this.#tasks[0];
        if (next === undefined || next.dueAtMs > targetTimeMs) {
          this.#pausedNowMs = targetTimeMs;
          return;
        }
        if (callbacks >= this.#maxCallbacksPerAdvance) {
          throw new ClockCapacityError(
            `Virtual clock exceeded ${this.#maxCallbacksPerAdvance} callbacks in one advance.`,
          );
        }
        this.#removeTask(0);
        this.#pausedNowMs = next.dueAtMs;
        callbacks += 1;
        next.callback();
      }
    } finally {
      this.#runningTasks = false;
    }
  }

  #insertTask(task: ScheduledTask): void {
    let index = this.#tasks.length;
    this.#tasks.push(task);
    this.#taskIndexes.set(task.id, index);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentTask = this.#tasks[parent] as ScheduledTask;
      if (compareTasks(parentTask, task) <= 0) break;
      this.#tasks[index] = parentTask;
      this.#taskIndexes.set(parentTask.id, index);
      index = parent;
    }
    this.#tasks[index] = task;
    this.#taskIndexes.set(task.id, index);
  }

  #removeTask(index: number): ScheduledTask {
    const removed = this.#tasks[index] as ScheduledTask;
    const replacement = this.#tasks.pop();
    this.#taskIndexes.delete(removed.id);
    if (replacement === undefined || index === this.#tasks.length) return removed;
    this.#tasks[index] = replacement;
    this.#taskIndexes.set(replacement.id, index);
    const parent = Math.floor((index - 1) / 2);
    if (index > 0 && compareTasks(replacement, this.#tasks[parent] as ScheduledTask) < 0) {
      this.#bubbleUp(index);
    } else {
      this.#bubbleDown(index);
    }
    return removed;
  }

  #bubbleUp(startIndex: number): void {
    let index = startIndex;
    const task = this.#tasks[index] as ScheduledTask;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentTask = this.#tasks[parent] as ScheduledTask;
      if (compareTasks(parentTask, task) <= 0) break;
      this.#tasks[index] = parentTask;
      this.#taskIndexes.set(parentTask.id, index);
      index = parent;
    }
    this.#tasks[index] = task;
    this.#taskIndexes.set(task.id, index);
  }

  #bubbleDown(startIndex: number): void {
    let index = startIndex;
    const task = this.#tasks[index] as ScheduledTask;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.#tasks.length) break;
      const right = left + 1;
      let next = left;
      if (
        right < this.#tasks.length &&
        compareTasks(this.#tasks[right] as ScheduledTask, this.#tasks[left] as ScheduledTask) < 0
      ) {
        next = right;
      }
      const nextTask = this.#tasks[next] as ScheduledTask;
      if (compareTasks(task, nextTask) <= 0) break;
      this.#tasks[index] = nextTask;
      this.#taskIndexes.set(nextTask.id, index);
      index = next;
    }
    this.#tasks[index] = task;
    this.#taskIndexes.set(task.id, index);
  }
}

export class ClockCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClockCapacityError';
  }
}

function compareTasks(left: ScheduledTask, right: ScheduledTask): number {
  return left.dueAtMs - right.dueAtMs || left.id - right.id;
}

function boundedClockLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new RangeError(`${name} must be a safe integer from 1 through 1,000,000.`);
  }
  return value;
}

function assertFiniteTime(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Virtual time must be a non-negative finite number.');
  }
}
