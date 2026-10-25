'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- This bootstrap must load CommonJS SDK modules. */

const { createRequire, runMain } = require('node:module');
const { errorMonitor } = require('node:events');
const { writeSync } = require('node:fs');
const path = require('node:path');
const { createHandlerTracker, trackEventListeners } = require('./handler-tracking.cjs');

const SDK_VERSION = '14.27.0';
const clients = new Set();
const reportedErrors = new WeakSet();
let botEntryStarted = false;
const diagnosticSecrets = sensitiveEnvironmentValues();

function sensitiveEnvironmentValues() {
  const values = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /(?:^|_)(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|CREDENTIAL)$/iu.test(
          key,
        ) && value,
    )
    .map(([, value]) => value);
  if (
    values.length > 512 ||
    values.some((value) => Buffer.byteLength(value) > 65_536) ||
    values.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 2_097_152
  )
    return null;
  return [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))];
}

function redactDiagnostic(source) {
  const value = String(source);
  if (diagnosticSecrets === null || Buffer.byteLength(value) > 1_048_576)
    return '[Diagnostic content omitted: redaction limit exceeded.]';
  const matches = [];
  for (const secret of diagnosticSecrets) {
    let offset = 0;
    for (;;) {
      const start = value.indexOf(secret, offset);
      if (start === -1) break;
      if (matches.length >= 8_192) return '[Diagnostic content omitted: redaction limit exceeded.]';
      matches.push([start, start + secret.length]);
      offset = start + 1;
    }
  }
  matches.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cursor = 0;
  const parts = [];
  for (const [start, end] of matches) {
    if (start >= cursor) parts.push(value.slice(cursor, start), '[REDACTED]');
    cursor = Math.max(cursor, end);
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function boundedMessage(source) {
  const selected = [];
  let size = 0;
  for (const line of redactDiagnostic(source).split(/\r?\n/u)) {
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > 1_000) {
      selected.push('[Long diagnostic line omitted.]');
      break;
    }
    if (size + bytes > 1_000) {
      selected.push('[Additional diagnostic lines omitted.]');
      break;
    }
    selected.push(line);
    size += bytes;
  }
  return selected.join('\n') || 'The Bot reported an error.';
}

function emitDiagnostic(error) {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    const source = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const message = boundedMessage(source);
    const line = `DISRUNNER_DIAGNOSTIC ${JSON.stringify({ code: 'bot-error', message })}\n`;
    writeSync(1, line);
  } catch {
    // Diagnostic delivery must not alter the process's native exception behavior.
  }
}

function endpoint(value, protocol, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a loopback URL.`);
  }
  if (
    url.protocol !== protocol ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    !url.port ||
    url.hash
  ) {
    throw new Error(`${label} must be a loopback URL with an explicit port.`);
  }
  return url;
}

async function main() {
  const entry = process.argv[2];
  if (!entry || !path.isAbsolute(entry)) {
    throw new Error('The discord.js adapter requires an absolute Bot entry point.');
  }
  if (process.env.DISRUNNER_OFFLINE !== '1') {
    throw new Error('The discord.js adapter must be started by an offline DisRunner session.');
  }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 23 || (minor === 23 && patch < 2)) {
    throw new Error('This discord.js adapter requires Node.js 22.23.2 or newer in Node.js 22.');
  }
  const token = process.env.DISRUNNER_FAKE_TOKEN;
  if (!/^disrunner\.offline\.[A-Za-z0-9_-]{16,256}$/.test(token ?? '')) {
    throw new Error('A synthetic DisRunner session credential is required.');
  }
  const api = endpoint(process.env.DISCORD_API_BASE_URL, 'http:', 'REST endpoint');
  if (!api.pathname.endsWith('/api/v10') || api.search) {
    throw new Error('The REST endpoint must use API v10.');
  }
  const gateway = endpoint(process.env.DISCORD_GATEWAY_URL, 'ws:', 'Gateway endpoint');
  const fromEntry = createRequire(entry);
  let sdkPath;
  try {
    sdkPath = fromEntry.resolve('discord.js');
  } catch {
    throw new Error(
      `Install discord.js ${SDK_VERSION} in the Bot project before running it offline.`,
    );
  }
  const fromSdk = createRequire(sdkPath);
  const installed = fromSdk('../package.json').version;
  if (installed !== SDK_VERSION) {
    throw new Error(
      `Unsupported discord.js version ${installed}; this adapter requires ${SDK_VERSION}.`,
    );
  }

  // Install the guard before loading the SDK, so its WebSocket constructor is contained.
  const fromWs = createRequire(fromSdk.resolve('@discordjs/ws'));
  const socketPath = fromWs.resolve('ws');
  const OriginalWebSocket = fromWs('ws');
  const guardedSocket = new Proxy(OriginalWebSocket, {
    construct(target, args, newTarget) {
      const url = endpoint(args[0], 'ws:', 'SDK Gateway connection');
      if (
        url.origin !== gateway.origin ||
        url.pathname.replace(/\/$/, '') !== gateway.pathname.replace(/\/$/, '')
      ) {
        throw new Error('The offline adapter rejected a Gateway connection outside this session.');
      }
      url.searchParams.delete('compress');
      return Reflect.construct(target, [url.href, ...args.slice(1)], newTarget);
    },
    get(target, property, receiver) {
      if (property === 'WebSocket') return guardedSocket;
      return Reflect.get(target, property, receiver);
    },
  });
  require.cache[socketPath].exports = guardedSocket;

  const http = fromSdk('undici');
  const originalFetch = http.fetch;
  http.fetch = (resource, options) => {
    const target = endpoint(
      typeof resource === 'object' && resource !== null && 'url' in resource
        ? resource.url
        : resource,
      'http:',
      'SDK file request',
    );
    if (target.origin !== api.origin) {
      throw new Error('The offline adapter rejected a remote SDK attachment or image request.');
    }
    if (/^\/attachments\/[1-9][0-9]{0,19}$/.test(target.pathname)) {
      const headers = new Headers(options?.headers);
      headers.set('Authorization', `Bot ${token}`);
      return originalFetch(resource, { ...options, headers, redirect: 'error' });
    }
    return originalFetch(resource, { ...options, redirect: 'error' });
  };

  const { REST } = fromSdk('@discordjs/rest');
  const originalResolve = REST.prototype.resolveRequest;
  const baseRequest = fromSdk('@discordjs/rest').DefaultRestOptions.makeRequest;
  REST.prototype.resolveRequest = async function resolveOfflineRequest(request) {
    this.options.api = api.href.replace(/\/v10\/?$/, '');
    this.options.version = '10';
    this.agent = null;
    this.options.makeRequest = async (url, options) => {
      const target = endpoint(url, 'http:', 'SDK REST request');
      if (target.origin !== api.origin || !target.pathname.startsWith(`${api.pathname}/`)) {
        throw new Error('The offline adapter rejected a REST request outside this session.');
      }
      return baseRequest(url, options);
    };
    return originalResolve.call(this, request);
  };
  const sdk = fromEntry('discord.js');
  process.on('uncaughtExceptionMonitor', emitDiagnostic);
  const tracker = createHandlerTracker(
    (record) => writeSync(1, `DISRUNNER_HANDLER ${JSON.stringify(record)}\n`),
    emitDiagnostic,
  );
  trackEventListeners(
    sdk.Client.prototype,
    new Set([
      'interactionCreate',
      'messageCreate',
      'messageUpdate',
      'messageDelete',
      'clientReady',
      'ready',
      'guildCreate',
      'guildDelete',
      'channelCreate',
      'channelUpdate',
      'channelDelete',
      'roleCreate',
      'roleUpdate',
      'roleDelete',
      'guildMemberUpdate',
    ]),
    tracker,
  );
  trackEventListeners(
    sdk.Collector.prototype,
    new Set(['collect', 'dispose', 'end', 'ignore', 'create']),
    tracker,
  );
  const originalLogin = sdk.Client.prototype.login;
  sdk.Client.prototype.login = function loginOffline() {
    clients.add(this);
    this.on(errorMonitor, emitDiagnostic);
    this.options.shards = [0];
    this.options.shardCount = 1;
    this.once('clientReady', () =>
      queueMicrotask(() => process.stdout.write('DISRUNNER_ADAPTER_READY\n')),
    );
    return originalLogin.call(this, token);
  };
  const shutdown = async () => {
    await Promise.allSettled([...clients].map((client) => client.destroy()));
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.argv.splice(1, 2, entry);
  botEntryStarted = true;
  runMain(entry);
}

main().catch((error) => {
  if (!botEntryStarted) {
    try {
      writeSync(
        1,
        `DISRUNNER_ADAPTER_ERROR ${JSON.stringify({ code: 'unsupported', message: boundedMessage(error.message) })}\n`,
      );
    } catch {
      /* Preserve the startup failure. */
    }
  } else emitDiagnostic(error);
  process.stderr.write(`DisRunner discord.js adapter: ${error.message}\n`);
  process.exitCode = 1;
});
