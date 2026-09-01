import { sign } from 'node:crypto';
import { request } from 'node:http';

import {
  requireWebhookPeerSecret,
  verifyWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './peer-auth.mjs';

export const SIGNED_CLIENT_TIMEOUT_MS = 3_000;
export const SIGNED_CLIENT_MAX_RESPONSE_BYTES = 1_048_576;

export function signDiscordRequest(privateKey, body, timestamp = currentUnixSeconds()) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const normalizedTimestamp = String(timestamp);
  if (!/^\d{1,16}$/.test(normalizedTimestamp)) {
    throw new TypeError('The signature timestamp must be Unix seconds.');
  }
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(normalizedTimestamp, 'utf8'), rawBody]),
    privateKey,
  ).toString('hex');
  return { rawBody, signature, timestamp: normalizedTimestamp };
}

export async function sendSignedInteraction({
  url,
  privateKey,
  peerSecretHex,
  interaction,
  timestamp = currentUnixSeconds(),
  timeoutMs = SIGNED_CLIENT_TIMEOUT_MS,
  maxResponseBytes = SIGNED_CLIENT_MAX_RESPONSE_BYTES,
}) {
  const rawBody = Buffer.from(JSON.stringify(interaction), 'utf8');
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
  const normalizedPeerSecret = requireWebhookPeerSecret(peerSecretHex);
  const target = new URL('/interactions', url);
  const normalizedTimeoutMs = requirePositiveInteger(timeoutMs, 'timeoutMs');
  const normalizedMaxResponseBytes = requirePositiveInteger(maxResponseBytes, 'maxResponseBytes');

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const outbound = request(
      target,
      {
        method: 'POST',
        headers: {
          'content-length': String(signed.rawBody.length),
          'content-type': 'application/json',
          'x-signature-ed25519': signed.signature,
          'x-signature-timestamp': signed.timestamp,
        },
      },
      (response) => {
        const chunks = [];
        let responseBytes = 0;
        response.once('error', rejectOnce);
        response.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          responseBytes += bytes.byteLength;
          if (responseBytes > normalizedMaxResponseBytes) {
            const error = new RangeError(
              `Webhook response exceeds the ${normalizedMaxResponseBytes}-byte limit.`,
            );
            response.destroy(error);
            rejectOnce(error);
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          if (settled) return;
          const rawResponse = Buffer.concat(chunks);
          const responseAuthentication = response.headers[WEBHOOK_RESPONSE_AUTH_HEADER];
          if (
            !verifyWebhookResponseAuthentication(
              typeof responseAuthentication === 'string' ? responseAuthentication : undefined,
              {
                peerSecretHex: normalizedPeerSecret,
                timestamp: signed.timestamp,
                status: response.statusCode ?? 0,
                requestBody: signed.rawBody,
                responseBody: rawResponse,
              },
            )
          ) {
            rejectOnce(new Error('Webhook response authentication failed.'));
            return;
          }
          const text = rawResponse.toString('utf8');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolveOnce({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    timer = setTimeout(() => {
      const error = new Error(`Webhook response timed out after ${normalizedTimeoutMs} ms.`);
      outbound.destroy(error);
      rejectOnce(error);
    }, normalizedTimeoutMs);
    outbound.once('error', rejectOnce);
    outbound.end(signed.rawBody);
  });
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}
