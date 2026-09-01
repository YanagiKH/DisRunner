import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket, type RawData } from 'ws';
import { describe, expect, it } from 'vitest';

import {
  BotRunner,
  DISCORD_EPOCH_MS,
  GatewayEmulator,
  GatewayOpcodes,
  InteractionEngine,
  LocalGatewayServer,
  LocalRestEmulator,
  OfflineNetworkError,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  TraceCollector,
  type TraceCollectorOptions,
  VirtualClock,
  VirtualState,
  assertOfflineGatewayUrl,
  assertSyntheticToken,
  createOfflineFetch,
  createOfflineSessionToken,
  createSimulationProfile,
  parseScenario,
  runScenario,
  sanitizeForExport,
  sanitizeFixtureForExport,
  sanitizeScenarioRunResult,
} from '../../src/index.js';

describe('security hardening', () => {
  it('validates every redirect hop and strips credentials across origins', async () => {
    const seen: Request[] = [];
    const baseFetch = (input: RequestInfo | URL): Promise<Response> => {
      const request = new Request(input);
      seen.push(request);
      if (seen.length === 1)
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'http://localhost:4444/next' } }),
        );
      return Promise.resolve(new Response('ok'));
    };
    const offline = createOfflineFetch(baseFetch);
    await expect(
      offline('http://127.0.0.1:3333/start', { headers: { Authorization: 'Bot secret-value' } }),
    ).resolves.toHaveProperty('status', 200);
    expect(seen[1]?.headers.get('authorization')).toBeNull();

    const escape = createOfflineFetch(() =>
      Promise.resolve(
        new Response(null, { status: 307, headers: { location: 'https://discord.com/api/v10' } }),
      ),
    );
    await expect(escape('http://127.0.0.1:3333/start')).rejects.toThrow(OfflineNetworkError);
    let redirects = 0;
    const bounded = createOfflineFetch(
      () => {
        redirects += 1;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: '/again' } }),
        );
      },
      { maxRedirects: 1 },
    );
    await expect(bounded('http://127.0.0.1:3333/start')).rejects.toThrow(/redirect limit/);
    expect(redirects).toBe(2);
  });

  it('uses unique synthetic tokens, rejects Discord-shaped tokens, and compares REST auth safely', async () => {
    expect(createOfflineSessionToken()).not.toBe(createOfflineSessionToken());
    expect(() => assertSyntheticToken('offline')).toThrow();
    expect(() =>
      assertSyntheticToken('MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.ABCDEF.abcdefghijklmnopqrstuvwxyz'),
    ).toThrow();
    const first = createRestServer();
    const second = createRestServer();
    expect(first.server.sessionToken).not.toBe(second.server.sessionToken);
    const address = await first.server.start();
    try {
      const denied = await fetch(`${address.apiBaseUrl}/users/@me`, {
        headers: { Authorization: 'Bot wrong' },
      });
      const allowed = await fetch(`${address.apiBaseUrl}/users/@me`, {
        headers: { Authorization: `Bot ${first.server.sessionToken}` },
      });
      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
    } finally {
      await first.server.stop();
    }
  });

  it('requires loopback gateway and resume URLs', () => {
    expect(() => assertOfflineGatewayUrl('https://127.0.0.1/gateway')).toThrow();
    expect(() => assertOfflineGatewayUrl('wss://gateway.discord.gg')).toThrow();
    const stack = createGateway();
    expect(() => new GatewayEmulator({ ...stack, resumeGatewayUrl: 'ws://example.com' })).toThrow();
  });

  it('serves HELLO, IDENTIFY, dispatch, heartbeat, and bounded shutdown over loopback WebSocket', async () => {
    const token = createOfflineSessionToken();
    const gateway = new GatewayEmulator({ ...createGateway(), fakeToken: token });
    const server = new LocalGatewayServer({ gateway, maxConnections: 2, maxPayloadBytes: 4_096 });
    const address = await server.start();
    const socket = new WebSocket(address.url);
    let resumeSocket: WebSocket | undefined;
    try {
      const hello = await nextPacket(socket);
      expect(hello.op).toBe(GatewayOpcodes.HELLO);
      socket.send(JSON.stringify({ op: GatewayOpcodes.IDENTIFY, d: { token, intents: 1 } }));
      const ready = await nextPacket(socket);
      expect(ready.t).toBe('READY');
      const sessionId = (ready.d as { session_id: string }).session_id;
      expect(server.dispatch(sessionId, 'GUILD_CREATE', { id: '1' })).toBe(true);
      expect((await nextPacket(socket)).t).toBe('GUILD_CREATE');
      socket.send(JSON.stringify({ op: GatewayOpcodes.HEARTBEAT, d: 2 }));
      expect((await nextPacket(socket)).op).toBe(GatewayOpcodes.HEARTBEAT_ACK);
      await closeSocket(socket);
      resumeSocket = new WebSocket(address.url);
      expect((await nextPacket(resumeSocket)).op).toBe(GatewayOpcodes.HELLO);
      resumeSocket.send(
        JSON.stringify({
          op: GatewayOpcodes.RESUME,
          d: { token, session_id: sessionId, seq: 2 },
        }),
      );
      expect((await nextPacket(resumeSocket)).t).toBe('RESUMED');
    } finally {
      socket.close();
      resumeSocket?.close();
      await server.stop();
    }
  });

  it('binds one authenticated Gateway session to one socket', async () => {
    const token = createOfflineSessionToken();
    const gateway = new GatewayEmulator({ ...createGateway(), fakeToken: token });
    const server = new LocalGatewayServer({ gateway });
    const address = await server.start();
    const first = new WebSocket(address.url);
    let contender: WebSocket | undefined;
    try {
      await nextPacket(first);
      first.send(JSON.stringify({ op: GatewayOpcodes.IDENTIFY, d: { token, intents: 0 } }));
      const ready = await nextPacket(first);
      const sessionId = (ready.d as { session_id: string }).session_id;

      const repeatedClose = nextClose(first);
      first.send(JSON.stringify({ op: GatewayOpcodes.IDENTIFY, d: { token, intents: 0 } }));
      await expect(repeatedClose).resolves.toBe(4005);
      expect(gateway.sessions()).toHaveLength(1);

      contender = new WebSocket(address.url);
      await nextPacket(contender);
      contender.send(
        JSON.stringify({
          op: GatewayOpcodes.RESUME,
          d: { token, session_id: sessionId, seq: ready.s },
        }),
      );
      await expect(nextPacket(contender)).resolves.toMatchObject({ t: 'RESUMED' });
      expect(gateway.session(sessionId)?.state).toBe('ready');
    } finally {
      first.close();
      contender?.close();
      await server.stop();
    }
  });

  it('recovers a gateway server instance after a listen failure', async () => {
    const firstGateway = new GatewayEmulator(createGateway());
    const first = new LocalGatewayServer({ gateway: firstGateway });
    const occupied = await first.start();
    const second = new LocalGatewayServer({ gateway: new GatewayEmulator(createGateway()) });
    try {
      await expect(second.start(occupied.port)).rejects.toBeInstanceOf(Error);
      await first.stop();
      await expect(second.start()).resolves.toMatchObject({ host: '127.0.0.1' });
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('recovers a REST server instance after a listen failure and validates body limits', async () => {
    const first = createRestServer().server;
    const occupied = await first.start();
    const second = createRestServer().server;
    try {
      await expect(second.start(occupied.port)).rejects.toBeInstanceOf(Error);
      await first.stop();
      await expect(second.start()).resolves.toMatchObject({ host: '127.0.0.1' });
    } finally {
      await first.stop();
      await second.stop();
    }

    const stack = createGateway();
    const gateway = new GatewayEmulator(stack);
    const base = {
      state: new VirtualState(stack.clock, stack.snowflakes),
      interactions: new InteractionEngine({
        ...stack,
        profile: createSimulationProfile(),
      }),
      gateway,
      rateLimits: new RateLimitEngine(stack.clock),
    };
    expect(() => new LocalRestEmulator({ ...base, maxBodyBytes: Infinity })).toThrow(RangeError);
    expect(() => new LocalRestEmulator({ ...base, maxBodyBytes: 0 })).toThrow(RangeError);
  });

  it('enforces gateway connection and payload limits', async () => {
    const server = new LocalGatewayServer({
      gateway: new GatewayEmulator(createGateway()),
      maxConnections: 1,
      maxPayloadBytes: 64,
    });
    const address = await server.start();
    const first = new WebSocket(address.url);
    let second: WebSocket | undefined;
    try {
      await nextPacket(first);
      second = new WebSocket(address.url);
      await expect(nextClose(second)).resolves.toBe(4008);
      const payloadClose = nextClose(first);
      first.send(
        JSON.stringify({ op: GatewayOpcodes.IDENTIFY, d: { token: 'x'.repeat(256), intents: 0 } }),
      );
      await expect(payloadClose).resolves.toBe(1009);
    } finally {
      first.close();
      second?.close();
      await server.stop();
    }
  });

  it('closes unauthenticated gateway connections after a bounded idle period', async () => {
    const server = new LocalGatewayServer({
      gateway: new GatewayEmulator(createGateway()),
      identifyTimeoutMs: 25,
      maxConnections: 1,
    });
    const address = await server.start();
    const idle = new WebSocket(address.url);
    let replacement: WebSocket | undefined;
    try {
      expect((await nextPacket(idle)).op).toBe(GatewayOpcodes.HELLO);
      await expect(nextClose(idle)).resolves.toBe(4003);
      replacement = new WebSocket(address.url);
      expect((await nextPacket(replacement)).op).toBe(GatewayOpcodes.HELLO);
    } finally {
      idle.close();
      replacement?.close();
      await server.stop();
    }
  });

  it('keeps route tokens out of trace names and sanitizes complete exports', async () => {
    const fixtureToken = 'fixture-super-secret-value';
    const stack = createRestServer(true);
    const address = await stack.server.start();
    try {
      await fetch(`${address.baseUrl}/api/v10/interactions/123/${fixtureToken}/callback`, {
        method: 'POST',
        headers: { Authorization: 'Bot authorization-super-secret' },
        body: '{}',
      });
      const serializedTrace = JSON.stringify(stack.trace?.spans());
      expect(serializedTrace).not.toContain(fixtureToken);
      expect(serializedTrace).not.toContain('authorization-super-secret');
    } finally {
      await stack.server.stop();
    }
    const exported = sanitizeForExport({
      fixture: { token: fixtureToken },
      log: `Bearer ${fixtureToken}`,
    });
    expect(JSON.stringify(exported)).not.toContain(fixtureToken);
  });

  it('bounds retained traces during sustained REST 401 and 404 error traffic', async () => {
    const stack = createRestServer(true, {
      maxOpenSpans: 8,
      maxCompletedSpans: 16,
      maxRetainedBytes: 16_384,
    });
    const address = await stack.server.start();
    try {
      for (let index = 0; index < 128; index += 1) {
        const response = await fetch(`${address.apiBaseUrl}/unauthorized-${index}`);
        expect(response.status).toBe(401);
      }
      expect(stack.trace?.spans()).toHaveLength(16);
      expect(stack.trace?.spans().every((span) => span.metadata['status'] === 401)).toBe(true);

      for (let index = 0; index < 128; index += 1) {
        const response = await fetch(`${address.apiBaseUrl}/missing-${index}`, {
          headers: { Authorization: `Bot ${stack.server.sessionToken}` },
        });
        expect(response.status).toBe(404);
      }
      expect(stack.trace?.spans()).toHaveLength(16);
      expect(stack.trace?.spans().every((span) => span.metadata['status'] === 404)).toBe(true);
      expect(stack.trace?.openSpanCount()).toBe(0);
      expect(stack.trace?.retainedByteCount()).toBeLessThanOrEqual(16_384);
    } finally {
      await stack.server.stop();
    }
  });

  it('caps scenario input, expansion and resources, and scans the full result for secrets', async () => {
    expect(() => parseScenario('name: x\nsteps: []', { limits: { maxInputBytes: 4 } })).toThrow();
    expect(() =>
      parseScenario(
        {
          version: 1,
          name: 'repeat',
          steps: [{ type: 'timeline-rest-request', at: 0, method: 'GET', path: '/x', repeat: 3 }],
        },
        { limits: { maxRepeat: 2 } },
      ),
    ).toThrow();
    const result = await runScenario({
      version: 1,
      name: 'secret-state',
      initialState: [{ resourceType: 'user', id: '1', token: 'hidden' }],
      steps: [],
      assertions: [{ type: 'no-secret-leak' }],
    });
    expect(result.assertions[0]?.passed).toBe(false);
    expect(JSON.stringify(sanitizeScenarioRunResult(result))).not.toContain('hidden');
    expect(JSON.stringify(sanitizeFixtureForExport({ token: 'fixture-value' }))).not.toContain(
      'fixture-value',
    );
    expect(sanitizeFixtureForExport('{"resources":[{"token":"fixture-value"}]}')).not.toContain(
      'fixture-value',
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(
      runScenario(
        {
          version: 1,
          name: 'cancel-repeat',
          steps: [
            { type: 'timeline-rest-request', at: 0, method: 'GET', path: '/x', repeat: 1_000 },
          ],
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('enforces workspace containment and line-level split-token redaction with byte limits', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'disrunner-security-'));
    const workspace = join(temporary, 'workspace');
    const outside = join(temporary, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const escapedLink = join(workspace, 'escaped-link');
    await symlink(outside, escapedLink, process.platform === 'win32' ? 'junction' : 'dir');
    const runner = new BotRunner({ maxOutputBytes: 256, maxOutputLineBytes: 128 });
    await expect(
      runner.start({
        executable: process.execPath,
        args: ['-e', ''],
        cwd: temporary,
        workspaceRoot: workspace,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
      }),
    ).rejects.toThrow(/workspaceRoot/);
    await expect(
      runner.start({
        executable: process.execPath,
        args: ['-e', ''],
        cwd: escapedLink,
        workspaceRoot: workspace,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
      }),
    ).rejects.toThrow(/workspaceRoot/);
    await expect(
      runner.start({
        executable: join(workspace, 'does-not-exist'),
        cwd: workspace,
        workspaceRoot: workspace,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
      }),
    ).rejects.toBeInstanceOf(Error);
    const token = createOfflineSessionToken();
    try {
      await runner.start({
        executable: process.execPath,
        args: [
          '-e',
          `process.stdout.write('Authorization: Bot ${token.slice(0, 12)}');process.stdout.write('${token.slice(12)}\\n')`,
        ],
        cwd: workspace,
        workspaceRoot: workspace,
        restBaseUrl: 'http://127.0.0.1:1',
        gatewayUrl: 'ws://127.0.0.1:2',
        fakeToken: token,
      });
      await waitUntilStopped(runner);
      const output = JSON.stringify(runner.snapshot().output);
      expect(output).not.toContain(token);
      expect(Buffer.byteLength(output)).toBeLessThan(1_024);
    } finally {
      await runner.stop(100);
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('does not wedge BotRunner when environment validation fails before spawn', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'disrunner-bot-retry-'));
    const runner = new BotRunner();
    const config = {
      executable: process.execPath,
      args: ['-e', ''],
      cwd: temporary,
      workspaceRoot: temporary,
      restBaseUrl: 'http://127.0.0.1:1',
      gatewayUrl: 'ws://127.0.0.1:2',
    };
    try {
      await expect(
        runner.start({
          ...config,
          env: {
            SAFE_NAME: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.ABCDEF.abcdefghijklmnopqrstuvwxyz',
          },
        }),
      ).rejects.toThrow(/Discord credential/);
      expect(runner.snapshot().status).toBe('stopped');
      const started = await runner.start(config);
      expect(started.status).toMatch(/starting|running/);
      await waitUntilStopped(runner);
    } finally {
      await runner.stop(100);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function createGateway() {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
  const random = new SeededRandom(1);
  const snowflakes = new SnowflakeGenerator(clock);
  return { clock, random, snowflakes };
}

function createRestServer(
  withTrace = false,
  traceOptions: Omit<TraceCollectorOptions, 'clock' | 'random'> = {},
): { server: LocalRestEmulator; trace?: TraceCollector } {
  const { clock, random, snowflakes } = createGateway();
  const trace = withTrace ? new TraceCollector({ clock, random, ...traceOptions }) : undefined;
  const gateway = new GatewayEmulator({ clock, random, snowflakes });
  return {
    server: new LocalRestEmulator({
      state: new VirtualState(clock, snowflakes),
      interactions: new InteractionEngine({
        clock,
        random,
        snowflakes,
        profile: createSimulationProfile(),
      }),
      gateway,
      rateLimits: new RateLimitEngine(clock),
      ...(trace === undefined ? {} : { trace }),
    }),
    ...(trace === undefined ? {} : { trace }),
  };
}

async function nextPacket(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    socket.once('message', (data) =>
      resolvePromise(JSON.parse(rawDataToText(data)) as Record<string, unknown>),
    );
    socket.once('error', reject);
  });
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolvePromise) => {
    socket.once('close', resolvePromise);
    socket.close();
  });
}

async function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolvePromise) => {
    socket.once('error', () => undefined);
    socket.once('close', (code) => resolvePromise(code));
  });
}

async function waitUntilStopped(runner: BotRunner): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (runner.snapshot().status !== 'running' && runner.snapshot().status !== 'starting') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Bot did not exit.');
}
