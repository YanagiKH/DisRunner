import { sign } from 'node:crypto';
import { request } from 'node:http';

import {
  requireWebhookPeerSecret,
  verifyWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './peer-auth.mjs';

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
}) {
  const rawBody = Buffer.from(JSON.stringify(interaction), 'utf8');
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
  const normalizedPeerSecret = requireWebhookPeerSecret(peerSecretHex);
  const target = new URL('/interactions', url);

  return new Promise((resolve, reject) => {
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
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
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
            reject(new Error('Webhook response authentication failed.'));
            return;
          }
          const text = rawResponse.toString('utf8');
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    outbound.once('error', reject);
    outbound.end(signed.rawBody);
  });
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1_000);
}
