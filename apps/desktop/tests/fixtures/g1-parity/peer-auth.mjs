import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_RESPONSE_AUTH_HEADER = 'x-disrunner-webhook-response-auth';

const RESPONSE_AUTH_DOMAIN = Buffer.from('disrunner.webhook-response.v1\0', 'utf8');

export function requireWebhookPeerSecret(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/iu.test(value)) {
    throw new TypeError('DISRUNNER_WEBHOOK_PEER_SECRET must be a 32-byte hexadecimal value.');
  }
  return value.toLowerCase();
}

export function signWebhookResponseAuthentication({
  peerSecretHex,
  timestamp,
  status,
  requestBody,
  responseBody,
}) {
  const secret = Buffer.from(requireWebhookPeerSecret(peerSecretHex), 'hex');
  return createHmac('sha256', secret)
    .update(authenticationMessage(timestamp, status, requestBody, responseBody))
    .digest('hex');
}

export function verifyWebhookResponseAuthentication(signature, input) {
  if (typeof signature !== 'string' || !/^[a-f\d]{64}$/iu.test(signature)) return false;
  const expected = Buffer.from(signWebhookResponseAuthentication(input), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function authenticationMessage(timestamp, status, requestBody, responseBody) {
  const normalizedTimestamp = String(timestamp);
  if (!/^\d{1,16}$/u.test(normalizedTimestamp)) {
    throw new TypeError('Webhook response timestamp must be Unix seconds.');
  }
  const requestDigest = createHash('sha256').update(requestBody).digest();
  const responseDigest = createHash('sha256').update(responseBody).digest();
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError('Webhook response status must be an HTTP status from 100 through 599.');
  }
  const encodedStatus = Buffer.allocUnsafe(2);
  encodedStatus.writeUInt16BE(status);
  return Buffer.concat([
    RESPONSE_AUTH_DOMAIN,
    Buffer.from(normalizedTimestamp, 'ascii'),
    Buffer.from([0]),
    encodedStatus,
    requestDigest,
    responseDigest,
  ]);
}
