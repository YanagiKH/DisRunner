import { sign, type KeyObject } from 'node:crypto';

import {
  verifyWebhookResponseAuthentication,
  WEBHOOK_RESPONSE_AUTH_HEADER,
} from './interaction-peer-auth.js';

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
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    /** Internal readiness observer; called synchronously before dispatch, without credentials. */
    readonly onSignedTimestamp?: (timestamp: string) => void;
  } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? INTERACTION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError(
      'Interaction timeout must be an integer from 0 to 2147483647 milliseconds.',
    );
  }
  options.signal?.throwIfAborted();
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
  // Observer failures propagate before any request or timer is created.
  options.onSignedTimestamp?.(timestamp);
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted === true) abortFromCaller();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Bot interaction timed out.', 'TimeoutError'));
  }, timeoutMs);
  try {
    const response = (await abortable(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-length': String(rawBody.byteLength),
            'content-type': 'application/json',
            'x-signature-ed25519': signature,
            'x-signature-timestamp': timestamp,
          },
          body: rawBody,
          redirect: 'error',
          signal: controller.signal,
        }),
      controller.signal,
    )) as unknown as FetchResponseLike;
    const responseBytes = await readBoundedResponse(
      response,
      MAX_INTERACTION_RESPONSE_BYTES,
      controller.signal,
    );
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
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function readBoundedResponse(
  response: FetchResponseLike,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
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
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error('Bot interaction response exceeds the configured byte limit.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    // A cancelled or malicious peer must not keep the caller waiting for cleanup.
    void reader.cancel().catch(() => {});
    throw error;
  }
}

/** Also bounds custom transports whose fetch or reader ignores the supplied signal. */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    // AbortSignal permits any reason; preserve the caller's exact cancellation value.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
