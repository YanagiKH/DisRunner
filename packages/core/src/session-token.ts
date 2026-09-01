import { randomBytes, timingSafeEqual } from 'node:crypto';

const DISCORD_TOKEN =
  /^(?:Bot\s+)?(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})$/;
const SYNTHETIC_PREFIX = 'disrunner.offline.';
const SYNTHETIC_TOKEN = /^disrunner\.offline\.[A-Za-z0-9_-]{16,256}$/;

export interface OfflineSessionCredentials {
  readonly token: string;
}

/** Creates a high-entropy token that is intentionally not shaped like a Discord credential. */
export function createOfflineSessionToken(): string {
  return `${SYNTHETIC_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function createOfflineSessionCredentials(): OfflineSessionCredentials {
  return { token: createOfflineSessionToken() };
}

export const createOfflineRuntimeCredentials = createOfflineSessionCredentials;

export function assertSyntheticToken(token: string): string {
  const normalized = normalizeBotToken(token);
  if (!SYNTHETIC_TOKEN.test(normalized) || isDiscordTokenShaped(token)) {
    throw new TypeError(
      'Offline credentials must use the reserved high-entropy disrunner.offline. namespace.',
    );
  }
  return normalized;
}

export function isDiscordTokenShaped(value: string): boolean {
  return DISCORD_TOKEN.test(value.trim());
}

export function timingSafeTokenEqual(received: string, expected: string): boolean {
  const left = Buffer.from(normalizeBotToken(received), 'utf8');
  const right = Buffer.from(normalizeBotToken(expected), 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

export function normalizeBotToken(value: string): string {
  return value.startsWith('Bot ') ? value.slice(4) : value;
}
