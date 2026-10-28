import { setTimeout as delay } from 'node:timers/promises';

import { LOCAL_COMMANDS } from './commands.mjs';

export function loadLocalApiConfiguration(environment) {
  if (environment.DISCORD_API_BASE_URL === undefined) return null;
  let url;
  try {
    url = new URL(environment.DISCORD_API_BASE_URL);
  } catch {
    throw new Error('DISCORD_API_BASE_URL must identify the local simulator.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.pathname.replace(/\/$/u, '') !== '/api/v10' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error(
      'DISCORD_API_BASE_URL must use http://127.0.0.1 with a bound port and /api/v10.',
    );
  if (
    typeof environment.DISCORD_TOKEN !== 'string' ||
    !/^disrunner\.offline\.[A-Za-z0-9_-]{16,256}$/u.test(environment.DISCORD_TOKEN)
  )
    throw new Error('DISCORD_TOKEN must be a synthetic DisRunner token.');
  return { baseUrl: url.href.replace(/\/$/u, ''), token: environment.DISCORD_TOKEN };
}

export function createLocalApiClient(configuration, signal) {
  if (configuration === null) return null;
  const checked = loadLocalApiConfiguration({
    DISCORD_API_BASE_URL: configuration.baseUrl,
    DISCORD_TOKEN: configuration.token,
  });
  return {
    async downloadAttachment(value, deadline) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error('Local attachment URL is invalid.');
      }
      if (
        url.origin !== new URL(checked.baseUrl).origin ||
        !/^\/attachments\/[1-9][0-9]{0,19}$/u.test(url.pathname) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      )
        throw new Error('Attachment downloads must use the local simulator.');
      const response = await fetch(url, {
        redirect: 'error',
        headers: { Authorization: `Bot ${checked.token}` },
        signal: AbortSignal.any([
          AbortSignal.timeout(2_000),
          ...(signal ? [signal] : []),
          ...(deadline ? [deadline] : []),
        ]),
      });
      if (response.status !== 200 || response.body === null)
        throw new Error('Local attachment download failed.');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2 * 1_048_576)
          throw new Error('Local attachment download exceeded its byte limit.');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    },
    async request(route, { method = 'GET', body, deadline } = {}) {
      if (
        typeof route !== 'string' ||
        !route.startsWith('/') ||
        route.startsWith('//') ||
        route.includes('..') ||
        /[?#\r\n]/u.test(route)
      )
        throw new Error('Local API route is invalid.');
      const multipart = body instanceof FormData;
      const response = await fetch(`${checked.baseUrl}${route}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bot ${checked.token}`,
          ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(2_000),
          ...(signal ? [signal] : []),
          ...(deadline ? [deadline] : []),
        ]),
      });
      const chunks = [];
      let bytes = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 1_048_576) throw new Error('Local API response exceeded its byte limit.');
          chunks.push(Buffer.from(chunk));
        }
      }
      let data = null;
      if (bytes > 0) {
        try {
          data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        } catch {
          throw new Error('Local API response was not JSON.');
        }
      }
      return { status: response.status, data };
    },
  };
}

export async function registerLocalCommands(client) {
  const deadline = AbortSignal.timeout(5_000);
  const application = await requestWithRetry(client, '/oauth2/applications/@me', { deadline });
  if (application.status !== 200 || !canonicalId(application.data?.id))
    throw new Error('Local application discovery failed.');
  const registered = await requestWithRetry(
    client,
    `/applications/${application.data.id}/commands`,
    {
      method: 'PUT',
      body: LOCAL_COMMANDS,
      deadline,
    },
  );
  if (
    registered.status !== 200 ||
    !Array.isArray(registered.data) ||
    registered.data.length !== LOCAL_COMMANDS.length
  )
    throw new Error('Local command registration failed.');
}

export async function completeAfterAcknowledgement(client, interaction, action, signal) {
  if (
    !canonicalId(interaction.application_id) ||
    typeof interaction.token !== 'string' ||
    !/^disrunner\.offline\.[A-Za-z0-9_-]{16,256}$/u.test(interaction.token)
  )
    throw new Error('Local interaction identity is invalid.');
  const deadline = AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
  const webhook = `/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}`;
  const original = `${webhook}/messages/@original`;
  let acknowledged = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const observed = await requestWithRetry(client, original, { deadline });
    if (observed.status === 200) {
      acknowledged = true;
      break;
    }
    if (observed.status !== 404 && observed.status !== 429)
      throw new Error('Local response acknowledgement failed.');
    await delay(25, undefined, { signal: deadline });
  }
  if (!acknowledged) throw new Error('Local response acknowledgement timed out.');
  let route = original;
  let method = 'PATCH';
  let body = { content: 'Deferred reply complete.' };
  if (action === 'followup') {
    route = webhook;
    method = 'POST';
    body = { content: 'Followup reply.' };
  } else if (action === 'attachment') {
    body = new FormData();
    body.set(
      'payload_json',
      JSON.stringify({
        content: 'Local attachment.',
        attachments: [{ id: '0', filename: 'note.txt' }],
      }),
    );
    body.set('files[0]', new Blob(['Offline attachment ✓\n'], { type: 'text/plain' }), 'note.txt');
  }
  const result = await requestWithRetry(client, route, { method, body, deadline });
  if (result.status !== 200) throw new Error('Local response could not be completed.');
  if (action === 'attachment') {
    const data = await client.downloadAttachment(result.data?.attachments?.[0]?.url, deadline);
    if (!data.equals(Buffer.from('Offline attachment ✓\n')))
      throw new Error('Local attachment content did not match.');
    process.stdout.write(`Local attachment verified (${data.byteLength} bytes).\n`);
  }
}

function canonicalId(value) {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

async function requestWithRetry(client, route, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.request(route, options);
    if (attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) return response;
    const retry =
      response.status === 429 && typeof response.data?.retry_after === 'number'
        ? response.data.retry_after * 1000
        : 50;
    await delay(Math.min(1_000, Math.max(25, retry)), undefined, { signal: options.deadline });
  }
  throw new Error('Local API retry limit was exceeded.');
}
