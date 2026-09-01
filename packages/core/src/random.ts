import type { VirtualClock } from './clock.js';

const UINT32_RANGE = 0x1_0000_0000;
export const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** Mulberry32-derived deterministic random source with explicit seed state. */
export class SeededRandom {
  #state: number;

  public constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError('Seed must be a safe integer.');
    this.#state = seed >>> 0;
  }

  public next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  public integer(minInclusive: number, maxExclusive: number): number {
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxExclusive) ||
      maxExclusive <= minInclusive
    ) {
      throw new RangeError(
        'Random integer bounds must be safe integers with max greater than min.',
      );
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  public bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new RangeError('Byte length must be non-negative.');
    return Uint8Array.from({ length }, () => this.integer(0, 256));
  }

  public token(byteLength = 24): string {
    return Buffer.from(this.bytes(byteLength)).toString('base64url');
  }

  public pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError('Cannot select from an empty collection.');
    return values[this.integer(0, values.length)] as T;
  }
}

export interface SnowflakeParts {
  readonly timestampMs: number;
  readonly workerId: number;
  readonly processId: number;
  readonly increment: number;
}

export class SnowflakeGenerator {
  readonly #clock: VirtualClock;
  readonly #workerId: number;
  readonly #processId: number;
  #lastTimestampMs = -1;
  #increment = -1;

  public constructor(
    clock: VirtualClock,
    options: { readonly workerId?: number; readonly processId?: number } = {},
  ) {
    this.#clock = clock;
    this.#workerId = validateFiveBit(options.workerId ?? 0, 'workerId');
    this.#processId = validateFiveBit(options.processId ?? 0, 'processId');
  }

  public generate(): string {
    const timestampMs = Math.floor(this.#clock.now());
    if (timestampMs < DISCORD_EPOCH_MS) {
      throw new RangeError(`Snowflake time must be at or after Discord epoch ${DISCORD_EPOCH_MS}.`);
    }
    if (timestampMs === this.#lastTimestampMs) {
      this.#increment += 1;
      if (this.#increment > 0xfff) {
        throw new RangeError('Snowflake increment exhausted for the current millisecond.');
      }
    } else {
      this.#lastTimestampMs = timestampMs;
      this.#increment = 0;
    }
    const value =
      (BigInt(timestampMs - DISCORD_EPOCH_MS) << 22n) |
      (BigInt(this.#workerId) << 17n) |
      (BigInt(this.#processId) << 12n) |
      BigInt(this.#increment);
    return value.toString();
  }

  public static decompose(value: string | bigint): SnowflakeParts {
    const snowflake = typeof value === 'bigint' ? value : BigInt(value);
    if (snowflake < 0n) throw new RangeError('Snowflake must be non-negative.');
    return {
      timestampMs: Number((snowflake >> 22n) + BigInt(DISCORD_EPOCH_MS)),
      workerId: Number((snowflake >> 17n) & 0x1fn),
      processId: Number((snowflake >> 12n) & 0x1fn),
      increment: Number(snowflake & 0xfffn),
    };
  }
}

function validateFiveBit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 31) {
    throw new RangeError(`${name} must be an integer from 0 through 31.`);
  }
  return value;
}
