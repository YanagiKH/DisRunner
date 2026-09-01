import { sign } from 'node:crypto';
import { request } from 'node:http';

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
  interaction,
  timestamp = currentUnixSeconds(),
}) {
  const rawBody = Buffer.from(JSON.stringify(interaction), 'utf8');
  const signed = signDiscordRequest(privateKey, rawBody, timestamp);
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
          const text = Buffer.concat(chunks).toString('utf8');
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
