import { sign, type KeyObject } from 'node:crypto';

import {
  verifyWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './interaction-peer-auth.cjs';

const MAX_INTERACTION_REQUEST_BYTES = 256 * 1_024;
const MAX_INTERACTION_RESPONSE_BYTES = 1_048_576;
export const INTERACTION_TIMEOUT_MS = 3_000;

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): {
      read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
      cancel(): Promise<unknown>;
    };
  } | null;
}

export class WebhookPeerAuthenticationError extends Error {
  public constructor() {
    super('Bot interaction response authentication failed.');
    this.name = 'WebhookPeerAuthenticationError';
  }
}

export async function sendSignedInteraction(
  endpoint: string,
  privateKey: KeyObject,
  peerSecretHex: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  if (rawBody.byteLength > MAX_INTERACTION_REQUEST_BYTES) {
    throw new Error('Interaction request exceeds the configured byte limit.');
  }
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
    privateKey,
  ).toString('hex');
  const response = (await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-length': String(rawBody.byteLength),
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: rawBody,
    redirect: 'error',
    signal: AbortSignal.timeout(INTERACTION_TIMEOUT_MS),
  })) as unknown as FetchResponseLike;
  const responseBytes = await readBoundedResponse(response, MAX_INTERACTION_RESPONSE_BYTES);
  if (
    !verifyWebhookResponseAuthentication(response.headers.get(WEBHOOK_RESPONSE_AUTH_HEADER), {
      peerSecretHex,
      timestamp,
      status: response.status,
      requestBody: rawBody,
      responseBody: responseBytes,
    })
  ) {
    throw new WebhookPeerAuthenticationError();
  }
  if (!response.ok) throw new Error(`Bot interaction endpoint returned HTTP ${response.status}.`);
  try {
    return JSON.parse(responseBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Bot interaction endpoint returned invalid JSON.');
  }
}

async function readBoundedResponse(response: FetchResponseLike, maxBytes: number): Promise<Buffer> {
  const advertised = response.headers.get('content-length');
  if (
    advertised !== null &&
    (/^\d+$/u.test(advertised) === false || Number(advertised) > maxBytes)
  ) {
    throw new Error('Bot interaction response exceeds the configured byte limit.');
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Bot interaction response exceeds the configured byte limit.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
