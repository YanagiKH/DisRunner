export const DISCORD_HOST_SUFFIXES = [
  'discord.com',
  'discordapp.com',
  'discord.gg',
  'discordcdn.com',
  'discordapp.net',
] as const;

export class OfflineNetworkError extends Error {
  public readonly code = 'DISRUNNER_OFFLINE_NETWORK_BLOCKED';
  public constructor(target: string) {
    super(`Offline mode blocked outbound network target: ${target}`);
    this.name = 'OfflineNetworkError';
  }
}

export function assertOfflineUrl(target: string | URL): URL {
  let url: URL;
  try {
    url = target instanceof URL ? new URL(target.href) : new URL(target);
  } catch {
    throw new OfflineNetworkError(String(target));
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    DISCORD_HOST_SUFFIXES.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  ) {
    throw new OfflineNetworkError(url.href);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !isLoopbackHostname(hostname)) {
    throw new OfflineNetworkError(url.href);
  }
  if (url.username !== '' || url.password !== '') throw new OfflineNetworkError(url.href);
  return url;
}

export interface OfflineFetchOptions {
  readonly maxRedirects?: number;
}

const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
] as const;

export function createOfflineFetch(
  baseFetch: typeof fetch = globalThis.fetch,
  options: OfflineFetchOptions = {},
): typeof fetch {
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new RangeError('maxRedirects must be an integer between 0 and 20.');
  }
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);
    let current = assertOfflineUrl(request.url);
    for (let redirects = 0; ; redirects += 1) {
      const replayRequest =
        request.method === 'GET' || request.method === 'HEAD' ? undefined : request.clone();
      const response = await baseFetch(request, { redirect: 'manual' });
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      if (redirects >= maxRedirects) {
        await response.body?.cancel();
        throw new OfflineNetworkError(`redirect limit exceeded from ${current.href}`);
      }
      let resolved: URL;
      try {
        resolved = new URL(location, current);
      } catch {
        await response.body?.cancel();
        throw new OfflineNetworkError(location);
      }
      await response.body?.cancel();
      const next = assertOfflineUrl(resolved);
      const headers = new Headers(request.headers);
      if (next.origin !== current.origin) {
        for (const name of [...headers.keys()]) {
          if (
            SENSITIVE_REDIRECT_HEADERS.includes(
              name as (typeof SENSITIVE_REDIRECT_HEADERS)[number],
            ) ||
            /(?:token|secret|api[-_]?key)/i.test(name)
          )
            headers.delete(name);
        }
      }
      const rewriteToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === 'POST');
      if (rewriteToGet) {
        headers.delete('content-length');
        headers.delete('content-type');
      }
      const nextInit: RequestInit = {
        method: rewriteToGet ? 'GET' : request.method,
        headers,
        redirect: 'manual',
        ...(!rewriteToGet && replayRequest !== undefined
          ? { body: await replayRequest.arrayBuffer() }
          : {}),
      };
      request = new Request(next, nextInit);
      current = next;
    }
  };
}

export function assertOfflineGatewayUrl(target: string | URL): URL {
  const url = assertOfflineUrl(target);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new OfflineNetworkError(url.href);
  return url;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}
