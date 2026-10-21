import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_PEER_SECRET_ENV = 'DISRUNNER_WEBHOOK_PEER_SECRET';
export const WEBHOOK_RESPONSE_AUTH_HEADER = 'x-disrunner-webhook-response-auth';

const RESPONSE_AUTH_DOMAIN = Buffer.from('disrunner.webhook-response.v1\0', 'utf8');

interface WebhookResponseAuthenticationInput {
  readonly peerSecretHex: string;
  readonly timestamp: string;
  readonly status: number;
  readonly requestBody: Uint8Array;
  readonly responseBody: Uint8Array;
}

export function createWebhookPeerSecret(): string {
  return randomBytes(32).toString('hex');
}

export function requireWebhookPeerSecret(value: string): string {
  if (!/^[a-f\d]{64}$/iu.test(value)) {
    throw new TypeError('Webhook peer secret must be a 32-byte hexadecimal value.');
  }
  return value.toLowerCase();
}

export function signWebhookResponseAuthentication(
  input: WebhookResponseAuthenticationInput,
): string {
  const secret = Buffer.from(requireWebhookPeerSecret(input.peerSecretHex), 'hex');
  return createHmac('sha256', secret).update(authenticationMessage(input)).digest('hex');
}

export function verifyWebhookResponseAuthentication(
  signature: string | null | undefined,
  input: WebhookResponseAuthenticationInput,
): boolean {
  if (signature === null || signature === undefined || !/^[a-f\d]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = Buffer.from(signWebhookResponseAuthentication(input), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function authenticationMessage(input: WebhookResponseAuthenticationInput): Buffer {
  if (!/^\d{1,16}$/u.test(input.timestamp)) {
    throw new TypeError('Webhook response timestamp must be Unix seconds.');
  }
  const requestDigest = createHash('sha256').update(input.requestBody).digest();
  const responseDigest = createHash('sha256').update(input.responseBody).digest();
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new RangeError('Webhook response status must be an HTTP status from 100 through 599.');
  }
  const status = Buffer.allocUnsafe(2);
  status.writeUInt16BE(input.status);
  return Buffer.concat([
    RESPONSE_AUTH_DOMAIN,
    Buffer.from(input.timestamp, 'ascii'),
    Buffer.from([0]),
    status,
    requestDigest,
    responseDigest,
  ]);
}
