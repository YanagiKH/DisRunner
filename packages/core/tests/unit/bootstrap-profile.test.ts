import { AsyncResource, createHook } from 'node:async_hooks';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../src/clock.js';
import { GatewayEmulator } from '../../src/gateway.js';
import { InteractionEngine } from '../../src/interactions.js';
import { SeededRandom, SnowflakeGenerator } from '../../src/random.js';
import { RateLimitEngine, type RateLimitRule } from '../../src/rate-limits.js';
import {
  LocalRestEmulator,
  type RestBootstrapProfile,
  type RestEmulatorOptions,
} from '../../src/rest-emulator.js';
import { createSimulationProfile } from '../../src/scenario.js';
import { VirtualState } from '../../src/state.js';

// Every expected value below is a handwritten literal. Expectations are never derived from the
// object passed to the constructor or from the implementation under test.

const TOKEN_A = 'disrunner.offline.bootstrap-unit-token-a';
const TOKEN_B = 'disrunner.offline.bootstrap-unit-token-b';
const TOKEN_C = 'disrunner.offline.bootstrap-unit-token-c';
const VERIFY_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PROFILE_IDS = ['100000000000000001', '100000000000000002', '100000000000000003'];

const EXPECTED_USER = {
  id: '100000000000000001',
  username: 'DisRunner Test Bot',
  discriminator: '0',
  avatar: null,
  bot: true,
};

const EXPECTED_APPLICATION = {
  id: '100000000000000002',
  name: 'DisRunner Test Application',
  description: 'Synthetic application profile for local tests.',
  icon: null,
  bot_public: false,
  bot_require_code_grant: false,
  owner: {
    id: '100000000000000003',
    username: 'test-owner',
    discriminator: '0',
    avatar: null,
    bot: false,
  },
  verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  flags: 0,
  team: null,
};

const EXPECTED_P2_USER = {
  id: '100000000000000001',
  username: 'DisRunner Test Bot',
  discriminator: '1234',
  avatar: null,
  bot: true,
};

const EXPECTED_P2_APPLICATION = {
  id: '100000000000000001',
  name: 'DisRunner Test Application',
  description: '',
  icon: null,
  bot_public: true,
  bot_require_code_grant: true,
  owner: {
    id: '100000000000000003',
    username: 'test-owner',
    discriminator: '0',
    avatar: null,
    bot: false,
  },
  verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  flags: 9007199254740991,
  team: null,
};

const NOT_FOUND = { code: 0, message: '404: Not Found' };
const UNAUTHORIZED_TEXT = '{"code":0,"message":"401: Unauthorized"}';

type Layer = Record<string, unknown>;
interface MutableProfile {
  user: Layer;
  application: Layer & { owner: Layer };
}

/** A fresh, independently handwritten caller-side input object. */
function inputProfile(): MutableProfile {
  return {
    user: {
      id: '100000000000000001',
      username: 'DisRunner Test Bot',
      discriminator: '0',
      avatar: null,
      bot: true,
    },
    application: {
      id: '100000000000000002',
      name: 'DisRunner Test Application',
      description: 'Synthetic application profile for local tests.',
      icon: null,
      bot_public: false,
      bot_require_code_grant: false,
      owner: {
        id: '100000000000000003',
        username: 'test-owner',
        discriminator: '0',
        avatar: null,
        bot: false,
      },
      verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      flags: 0,
      team: null,
    },
  };
}

function inputP2(): MutableProfile {
  return {
    user: {
      id: '100000000000000001',
      username: 'DisRunner Test Bot',
      discriminator: '1234',
      avatar: null,
      bot: true,
    },
    application: {
      id: '100000000000000001',
      name: 'DisRunner Test Application',
      description: '',
      icon: null,
      bot_public: true,
      bot_require_code_grant: true,
      owner: {
        id: '100000000000000003',
        username: 'test-owner',
        discriminator: '0',
        avatar: null,
        bot: false,
      },
      verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      flags: Number.MAX_SAFE_INTEGER,
      team: null,
    },
  };
}

function variant(change: (profile: MutableProfile) => void): MutableProfile {
  const profile = inputProfile();
  change(profile);
  return profile;
}

interface Harness {
  readonly state: VirtualState;
  readonly rateLimits: RateLimitEngine;
  readonly options: RestEmulatorOptions;
}

function harness(token = TOKEN_A, rules: readonly RateLimitRule[] = []): Harness {
  const clock = new VirtualClock({ nowMs: 1_420_070_400_000 + 100_000 });
  const random = new SeededRandom(31);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes);
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile({ seed: 31 }),
  });
  const gateway = new GatewayEmulator({ clock, random, snowflakes, fakeToken: token });
  const rateLimits = new RateLimitEngine(clock, rules);
  return {
    state,
    rateLimits,
    options: { state, interactions, gateway, rateLimits, fakeToken: token },
  };
}

function construct(bootstrap: unknown, base: Harness = harness()): LocalRestEmulator {
  return new LocalRestEmulator({
    ...base.options,
    bootstrap: bootstrap as RestBootstrapProfile,
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; authorization?: string; host?: string } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization;
  if (options.host !== undefined) headers['Host'] = options.host;
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolvePromise({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        incoming.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function withServer<T>(
  server: LocalRestEmulator,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const address = await server.start(0);
  try {
    return await run(address.port);
  } finally {
    await server.stop();
  }
}

function tcpHandles(): { servers: number; sockets: number } {
  const resources = process.getActiveResourcesInfo();
  return {
    servers: resources.filter((name) => name === 'TCPServerWrap').length,
    sockets: resources.filter((name) => name === 'TCPSocketWrap').length,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createNetServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}

type TcpHandleCounts = ReturnType<typeof tcpHandles>;

/** Resolves once two consecutive readings match; throws after the deadline so the test fails. */
async function waitForStableTcpHandles(limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  let previous = tcpHandles();
  for (;;) {
    await delay(20);
    const current = tcpHandles();
    if (current.servers === previous.servers && current.sockets === previous.sockets) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `TCP handles did not settle within ${limitMs} ms: ${JSON.stringify({ previous, current })}`,
      );
    }
    previous = current;
  }
}

function expectRejected(bootstrap: unknown, field?: string): void {
  const before = tcpHandles().servers;
  let caught: unknown;
  try {
    construct(bootstrap);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).constructor).toBe(TypeError);
  const message = (caught as Error).message;
  if (field !== undefined) expect(message).toContain(field);
  expect(message).not.toContain(VERIFY_KEY);
  expect(tcpHandles().servers).toBe(before);
}

function expectAccepted(bootstrap: unknown): LocalRestEmulator {
  return construct(bootstrap);
}

async function getJson(port: number, path: string, token = TOKEN_A): Promise<unknown> {
  const response = await send(port, path, { authorization: token });
  expect(response.status).toBe(200);
  return JSON.parse(response.text) as unknown;
}

async function expectRoundTrip(
  bootstrap: unknown,
  user: unknown,
  application: unknown,
): Promise<void> {
  await withServer(expectAccepted(bootstrap), async (port) => {
    expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual(user);
    expect(await getJson(port, '/api/v10/oauth2/applications/@me')).toStrictEqual(application);
  });
}

function toNullPrototype(source: Layer): Layer {
  const target = Object.create(null) as Layer;
  for (const [key, value] of Object.entries(source)) {
    target[key] =
      typeof value === 'object' && value !== null ? toNullPrototype(value as Layer) : value;
  }
  return target;
}

class Box {
  public constructor(source: Layer) {
    Object.assign(this, source);
  }
}

const LAYERS = ['user', 'application', 'owner'] as const;
function layerOf(profile: MutableProfile, layer: (typeof LAYERS)[number]): Layer {
  if (layer === 'user') return profile.user;
  if (layer === 'application') return profile.application;
  return profile.application.owner;
}

const USER_FIELDS = ['id', 'username', 'discriminator', 'avatar', 'bot'];
const APPLICATION_FIELDS = [
  'id',
  'name',
  'description',
  'icon',
  'bot_public',
  'bot_require_code_grant',
  'owner',
  'verify_key',
  'flags',
  'team',
];

describe('positive profiles', () => {
  it('serves the handwritten user and application exactly with no extra keys', async () => {
    await expectRoundTrip(inputProfile(), EXPECTED_USER, EXPECTED_APPLICATION);
  });

  it('application id may equal user id and boundary values round-trip', async () => {
    await expectRoundTrip(inputP2(), EXPECTED_P2_USER, EXPECTED_P2_APPLICATION);
  });
});

describe('constructor validation', () => {
  it('rejects non-object bootstrap values', () => {
    for (const value of [null, [], 'profile', 1, true]) expectRejected(value);
  });

  it('rejects a missing top-level section or an unknown top-level key', () => {
    expectRejected({ application: inputProfile().application }, 'user');
    expectRejected({ user: inputProfile().user }, 'application');
    expectRejected({ ...inputProfile(), guilds: [] }, 'guilds');
  });

  it('rejects each missing required field on every layer', () => {
    for (const field of USER_FIELDS) {
      expectRejected(
        variant((profile) => delete profile.user[field]),
        field,
      );
      expectRejected(
        variant((profile) => delete profile.application.owner[field]),
        field,
      );
    }
    for (const field of APPLICATION_FIELDS) {
      expectRejected(
        variant((profile) => delete (profile.application as Layer)[field]),
        field,
      );
    }
  });

  it('rejects an unknown key on every layer', () => {
    expectRejected(
      variant((profile) => (profile.user['email'] = 'bot@example.invalid')),
      'email',
    );
    expectRejected(
      variant((profile) => (profile.application['rpc_origins'] = [])),
      'rpc_origins',
    );
    expectRejected(
      variant((profile) => (profile.application.owner['global_name'] = 'Owner')),
      'global_name',
    );
  });

  it('own symbol keys and non-enumerable own data properties are rejected as unknown fields', () => {
    const symbol = Symbol('extra');
    const top = inputProfile() as unknown as Record<PropertyKey, unknown>;
    top[symbol] = 1;
    expectRejected(top);
    for (const layer of LAYERS) {
      expectRejected(
        variant((profile) => {
          (layerOf(profile, layer) as Record<PropertyKey, unknown>)[symbol] = 1;
        }),
      );
      expectRejected(
        variant((profile) => {
          Object.defineProperty(layerOf(profile, layer), 'hidden', {
            value: 'x',
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }),
      );
      expectRejected(
        variant((profile) => {
          const target = layerOf(profile, layer);
          Object.defineProperty(target, 'id', {
            value: target['id'],
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }),
      );
    }
    const hiddenTop = inputProfile();
    Object.defineProperty(hiddenTop, 'extra', { value: 1, enumerable: false });
    expectRejected(hiddenTop);
  });

  it('rejects accessors on every layer without invoking the getter', () => {
    let calls = 0;
    const getter = (value: unknown) => ({
      enumerable: true,
      configurable: true,
      get(): unknown {
        calls += 1;
        return value;
      },
    });

    const source = inputProfile();
    const top = { application: source.application } as Layer;
    Object.defineProperty(top, 'user', getter(source.user));
    expectRejected(top);

    expectRejected(
      variant((profile) => Object.defineProperty(profile.user, 'username', getter('Bot'))),
    );
    expectRejected(
      variant((profile) =>
        Object.defineProperty(profile.application, 'owner', getter(profile.application.owner)),
      ),
    );
    expectRejected(
      variant((profile) =>
        Object.defineProperty(profile.application.owner, 'id', getter('100000000000000003')),
      ),
    );
    expectRejected(
      variant((profile) =>
        Object.defineProperty(profile.application, 'verify_key', getter(VERIFY_KEY)),
      ),
    );
    expectRejected(
      variant((profile) =>
        Object.defineProperty(profile.application, 'verify_key', {
          enumerable: true,
          configurable: true,
          set(): void {
            calls += 1;
          },
        }),
      ),
    );
    expect(calls).toBe(0);
  });

  it('a required field that exists only on the prototype is missing', () => {
    expectRejected(
      variant((profile) => {
        const { id, ...rest } = profile.user;
        profile.user = Object.assign(Object.create({ id }) as Layer, rest);
      }),
    );
    expectRejected(
      variant((profile) => {
        const { verify_key: verifyKey, ...rest } = profile.application;
        profile.application = Object.assign<Layer, typeof rest>(
          Object.create({ verify_key: verifyKey }) as Layer,
          rest,
        );
      }),
    );
  });

  it('null-prototype objects are accepted on every layer', async () => {
    const source = inputProfile();
    const profile = toNullPrototype(source as unknown as Layer);
    await expectRoundTrip(profile, EXPECTED_USER, EXPECTED_APPLICATION);
  });

  it('class instances are rejected on every layer', () => {
    expectRejected(new Box(inputProfile() as unknown as Layer));
    for (const layer of LAYERS) {
      expectRejected(
        variant((profile) => {
          const boxed = new Box(layerOf(profile, layer)) as unknown as Layer;
          if (layer === 'user') profile.user = boxed;
          else if (layer === 'application')
            profile.application = boxed as MutableProfile['application'];
          else profile.application.owner = boxed;
        }),
      );
    }
  });

  it('rejects invalid ids on every layer, including leading zeros', () => {
    const invalid: unknown[] = [
      '0',
      '',
      '-1',
      '1e5',
      ' 1',
      '1 ',
      '0x10',
      '18446744073709551616',
      1,
      1n,
      '0100000000000000001',
    ];
    for (const value of invalid) {
      for (const layer of LAYERS) {
        expectRejected(
          variant((profile) => (layerOf(profile, layer)['id'] = value)),
          'id',
        );
      }
    }
  });

  it('accepts the id bounds 1 and 2^64-1', () => {
    for (const value of ['1', '18446744073709551615']) {
      for (const layer of LAYERS) {
        expectAccepted(variant((profile) => (layerOf(profile, layer)['id'] = value)));
      }
    }
  });

  it('the upper id bound round-trips', async () => {
    await expectRoundTrip(
      variant((profile) => (profile.user['id'] = '18446744073709551615')),
      { ...EXPECTED_USER, id: '18446744073709551615' },
      EXPECTED_APPLICATION,
    );
  });

  it('rejects out-of-range or non-string username and name', () => {
    const invalid: unknown[] = [
      '',
      'a'.repeat(101),
      'あ'.repeat(34),
      123,
      null,
      '\uD800',
      'a\uDC00',
    ];
    for (const value of invalid) {
      expectRejected(
        variant((profile) => (profile.user['username'] = value)),
        'username',
      );
      expectRejected(
        variant((profile) => (profile.application.owner['username'] = value)),
        'username',
      );
      expectRejected(
        variant((profile) => (profile.application['name'] = value)),
        'name',
      );
    }
  });

  it('accepts 1-100 UTF-8 byte names and round-trips their bytes', async () => {
    for (const value of ['a', 'a'.repeat(100), 'あ'.repeat(33), '😀'.repeat(25)]) {
      const profile = variant((candidate) => {
        candidate.user['username'] = value;
        candidate.application['name'] = value;
      });
      await withServer(expectAccepted(profile), async (port) => {
        const user = (await getJson(port, '/api/v10/users/@me')) as Layer;
        const application = (await getJson(port, '/api/v10/oauth2/applications/@me')) as Layer;
        expect(Buffer.from(user['username'] as string, 'utf8')).toEqual(Buffer.from(value, 'utf8'));
        expect(Buffer.from(application['name'] as string, 'utf8')).toEqual(
          Buffer.from(value, 'utf8'),
        );
      });
    }
  });

  it('rejects out-of-range or non-string description and accepts 0 or 1024 bytes', () => {
    for (const value of ['a'.repeat(1025), 'あ'.repeat(342), null, 7, '\uD800', 'a\uDC00']) {
      expectRejected(
        variant((profile) => (profile.application['description'] = value)),
        'description',
      );
    }
    for (const value of ['', 'a'.repeat(1024)]) {
      expectAccepted(variant((profile) => (profile.application['description'] = value)));
    }
  });

  it('validates discriminator on user and owner', () => {
    for (const value of ['00', '12345', 'abcd', '０００１', 0, '']) {
      expectRejected(
        variant((profile) => (profile.user['discriminator'] = value)),
        'discriminator',
      );
      expectRejected(
        variant((profile) => (profile.application.owner['discriminator'] = value)),
        'discriminator',
      );
    }
    for (const value of ['0', '0000', '0001', '9999']) {
      expectAccepted(variant((profile) => (profile.user['discriminator'] = value)));
      expectAccepted(variant((profile) => (profile.application.owner['discriminator'] = value)));
    }
  });

  it('avatar, icon and team accept only null', () => {
    for (const value of ['hash', undefined, {}, 0, false]) {
      expectRejected(
        variant((profile) => (profile.user['avatar'] = value)),
        'avatar',
      );
      expectRejected(
        variant((profile) => (profile.application.owner['avatar'] = value)),
        'avatar',
      );
      expectRejected(
        variant((profile) => (profile.application['icon'] = value)),
        'icon',
      );
      expectRejected(
        variant((profile) => (profile.application['team'] = value)),
        'team',
      );
    }
  });

  it('boolean fields accept only primitive booleans', () => {
    for (const value of [0, 1, 'true', null, new Boolean(true)]) {
      expectRejected(
        variant((profile) => (profile.user['bot'] = value)),
        'bot',
      );
      expectRejected(
        variant((profile) => (profile.application.owner['bot'] = value)),
        'bot',
      );
      expectRejected(
        variant((profile) => (profile.application['bot_public'] = value)),
        'bot_public',
      );
      expectRejected(
        variant((profile) => (profile.application['bot_require_code_grant'] = value)),
        'bot_require_code_grant',
      );
    }
  });

  it('the current user must be a bot and the owner must not be', () => {
    expectRejected(
      variant((profile) => (profile.user['bot'] = false)),
      'bot',
    );
    expectRejected(
      variant((profile) => (profile.application.owner['bot'] = true)),
      'bot',
    );
  });

  it('verify_key must be exactly 64 lowercase hex characters', () => {
    for (const value of [
      VERIFY_KEY.slice(1),
      `${VERIFY_KEY}0`,
      VERIFY_KEY.toUpperCase(),
      `g${VERIFY_KEY.slice(1)}`,
      ` ${VERIFY_KEY.slice(1)}`,
      `${VERIFY_KEY.slice(1)} `,
      1234,
    ]) {
      expectRejected(
        variant((profile) => (profile.application['verify_key'] = value)),
        'verify_key',
      );
    }
  });

  it('flags must be a non-negative safe integer', () => {
    for (const value of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0',
      1n,
    ]) {
      expectRejected(
        variant((profile) => (profile.application['flags'] = value)),
        'flags',
      );
    }
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      expectAccepted(variant((profile) => (profile.application['flags'] = value)));
    }
  });

  it('flags -0 is accepted and served as 0', async () => {
    await withServer(
      expectAccepted(variant((profile) => (profile.application['flags'] = -0))),
      async (port) => {
        const response = await send(port, '/api/v10/oauth2/applications/@me', {
          authorization: TOKEN_A,
        });
        expect(response.status).toBe(200);
        expect(response.text).toContain('"flags":0,');
        expect(JSON.parse(response.text)).toStrictEqual(EXPECTED_APPLICATION);
      },
    );
  });

  it('an undefined or absent bootstrap is unconfigured', async () => {
    const absent = new LocalRestEmulator(harness().options);
    const explicit = construct(undefined);
    for (const server of [absent, explicit]) {
      await withServer(server, async (port) => {
        const application = await send(port, '/api/v10/oauth2/applications/@me', {
          authorization: TOKEN_A,
        });
        expect(application.status).toBe(404);
        expect(JSON.parse(application.text)).toStrictEqual(NOT_FOUND);
      });
    }
  });

  it('rejected constructors leave no listener and the reserved port stays bindable', async () => {
    const port = await freePort();
    // Port checks stay outside the measured window; each awaits until its probe has closed.
    expect(await canBind(port)).toBe(true);
    await waitForStableTcpHandles(2_000);
    const created: number[] = [];
    const hook = createHook({
      init(asyncId, type) {
        if (type === 'TCPWRAP' || type === 'TCPSERVERWRAP') created.push(asyncId);
      },
    });
    let window: { before: TcpHandleCounts; after: TcpHandleCounts } | undefined;
    hook.enable();
    try {
      // Same tick: no await between the two readings, only the rejected constructors.
      const before = tcpHandles();
      expectRejected(null);
      expectRejected(variant((profile) => (profile.user['bot'] = false)));
      expectRejected(variant((profile) => (profile.application['verify_key'] = 'x')));
      const after = tcpHandles();
      window = { before, after };
    } finally {
      hook.disable();
    }
    expect(window).toBeDefined();
    expect(created).toEqual([]);
    expect(window?.after).toEqual(window?.before);
    expect(await canBind(port)).toBe(true);
  });
});

describe('deep copy and immutability', () => {
  it('nested caller mutation after construction does not leak', async () => {
    const profile = inputProfile();
    const server = construct(profile);
    profile.user['username'] = 'x';
    profile.application.owner['id'] = '9';
    delete profile.application['team'];
    await withServer(server, async (port) => {
      expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual(EXPECTED_USER);
      expect(await getJson(port, '/api/v10/oauth2/applications/@me')).toStrictEqual(
        EXPECTED_APPLICATION,
      );
    });
  });

  it('replacing a caller sub-object after construction does not leak', async () => {
    const profile = inputProfile();
    const server = construct(profile);
    profile.application = { ...profile.application, name: 'Replaced', owner: {} };
    profile.user = {};
    await withServer(server, async (port) => {
      expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual(EXPECTED_USER);
      expect(await getJson(port, '/api/v10/oauth2/applications/@me')).toStrictEqual(
        EXPECTED_APPLICATION,
      );
    });
  });

  it('mutating a parsed response does not affect later responses', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      const firstUser = (await getJson(port, '/api/v10/users/@me')) as Layer;
      const firstApplication = (await getJson(port, '/api/v10/oauth2/applications/@me')) as Layer;
      firstUser['username'] = 'changed';
      (firstApplication['owner'] as Layer)['id'] = '9';
      delete firstApplication['verify_key'];
      expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual(EXPECTED_USER);
      expect(await getJson(port, '/api/v10/oauth2/applications/@me')).toStrictEqual(
        EXPECTED_APPLICATION,
      );
    });
  });

  it('the constructor does not freeze or alter the caller object', () => {
    const profile = inputProfile();
    construct(profile);
    expect(Object.isFrozen(profile)).toBe(false);
    expect(Object.isFrozen(profile.user)).toBe(false);
    expect(Object.isFrozen(profile.application)).toBe(false);
    expect(Object.isFrozen(profile.application.owner)).toBe(false);
    expect(profile).toStrictEqual({ user: EXPECTED_USER, application: EXPECTED_APPLICATION });
    profile.user['username'] = 'still writable';
    expect(profile.user['username']).toBe('still writable');
  });

  it('one caller object shared by two instances cannot affect either', async () => {
    const profile = inputProfile();
    const first = construct(profile, harness(TOKEN_A));
    const second = construct(profile, harness(TOKEN_B));
    profile.user['username'] = 'x';
    profile.application.owner['id'] = '9';
    delete profile.application['team'];
    await withServer(first, async (firstPort) => {
      await withServer(second, async (secondPort) => {
        expect(await getJson(firstPort, '/api/v10/users/@me', TOKEN_A)).toStrictEqual(
          EXPECTED_USER,
        );
        expect(await getJson(firstPort, '/api/v10/oauth2/applications/@me', TOKEN_A)).toStrictEqual(
          EXPECTED_APPLICATION,
        );
        expect(await getJson(secondPort, '/api/v10/users/@me', TOKEN_B)).toStrictEqual(
          EXPECTED_USER,
        );
        expect(
          await getJson(secondPort, '/api/v10/oauth2/applications/@me', TOKEN_B),
        ).toStrictEqual(EXPECTED_APPLICATION);
      });
    });
  });
});

function expectNoProfile(text: string): void {
  for (const id of PROFILE_IDS) expect(text).not.toContain(id);
  expect(text).not.toContain(VERIFY_KEY);
}

const shared = (id: string, route: string, limit: number): RateLimitRule => ({
  id,
  method: 'GET',
  route,
  limit,
  windowMs: 60_000,
  scope: 'shared',
});

describe('HTTP behavior', () => {
  it('bare and Bot-prefixed tokens return both profiles with existing headers', async () => {
    const base = harness(TOKEN_A, [
      shared('bootstrap-user', '/users/@me', 100),
      shared('bootstrap-application', '/oauth2/applications/@me', 100),
    ]);
    await withServer(construct(inputProfile(), base), async (port) => {
      for (const authorization of [TOKEN_A, `Bot ${TOKEN_A}`]) {
        for (const [path, expected, bucket] of [
          ['/api/v10/users/@me', EXPECTED_USER, 'bootstrap-user'],
          ['/api/v10/oauth2/applications/@me', EXPECTED_APPLICATION, 'bootstrap-application'],
        ] as const) {
          const response = await send(port, path, { authorization });
          expect(response.status).toBe(200);
          expect(JSON.parse(response.text)).toStrictEqual(expected);
          expect(response.headers['content-type']).toBe('application/json');
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.headers['x-ratelimit-limit']).toBe('100');
          expect(response.headers['x-ratelimit-bucket']).toBe(bucket);
          expect(response.headers['x-ratelimit-remaining']).toBeDefined();
        }
      }
    });
  });

  it('invalid credentials return the exact 401 body without profile data', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      const invalid: (string | undefined)[] = [
        `Bearer ${TOKEN_A}`,
        'Bot wrong',
        'wrong',
        undefined,
        `Bot  ${TOKEN_A}`,
        `bot ${TOKEN_A}`,
      ];
      for (const path of ['/api/v10/users/@me', '/api/v10/oauth2/applications/@me']) {
        for (const authorization of invalid) {
          const response = await send(
            port,
            path,
            authorization === undefined ? {} : { authorization },
          );
          expect(response.status).toBe(401);
          expect(response.text).toBe(UNAUTHORIZED_TEXT);
          expectNoProfile(response.text);
        }
      }
    });
  });

  it('rejected credentials do not consume the valid bucket', async () => {
    const base = harness(TOKEN_A, [shared('bootstrap-application', '/oauth2/applications/@me', 1)]);
    await withServer(construct(inputProfile(), base), async (port) => {
      const path = '/api/v10/oauth2/applications/@me';
      for (const authorization of [`Bearer ${TOKEN_A}`, 'Bot wrong', 'wrong']) {
        expect((await send(port, path, { authorization })).status).toBe(401);
      }
      const first = await send(port, path, { authorization: TOKEN_A });
      expect(first.status).toBe(200);
      expect(JSON.parse(first.text)).toStrictEqual(EXPECTED_APPLICATION);
      expect((await send(port, path, { authorization: TOKEN_A })).status).toBe(429);
    });
  });

  it('an exhausted bucket keeps the existing 429 contract without profile data', async () => {
    const base = harness(TOKEN_A, [
      shared('bootstrap-user', '/users/@me', 1),
      shared('bootstrap-application', '/oauth2/applications/@me', 1),
    ]);
    await withServer(construct(inputProfile(), base), async (port) => {
      const userPath = '/api/v10/users/@me';
      const applicationPath = '/api/v10/oauth2/applications/@me';
      expect((await send(port, userPath, { authorization: TOKEN_A })).status).toBe(200);
      expect((await send(port, applicationPath, { authorization: TOKEN_A })).status).toBe(200);
      const userLimited = await send(port, userPath, { authorization: TOKEN_A });
      const applicationLimited = await send(port, applicationPath, { authorization: TOKEN_A });
      for (const limited of [userLimited, applicationLimited]) {
        expect(limited.status).toBe(429);
        expect(JSON.parse(limited.text)).toStrictEqual({
          message: 'You are being rate limited.',
          retry_after: 60,
          global: false,
        });
        expect(limited.headers['retry-after']).toBe('60');
        expect(limited.headers['x-ratelimit-remaining']).toBe('0');
        expectNoProfile(limited.text);
      }
      const headerNames = (headers: IncomingHttpHeaders) =>
        Object.keys(headers)
          .filter((name) => !['date', 'connection', 'keep-alive'].includes(name))
          .sort();
      expect(headerNames(applicationLimited.headers)).toEqual(headerNames(userLimited.headers));
      expect(applicationLimited.text).toBe(userLimited.text);
    });
  });

  it('unsupported methods on the application route are 404', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await send(port, '/api/v10/oauth2/applications/@me', {
          method,
          authorization: TOKEN_A,
        });
        expect(response.status).toBe(404);
        expect(JSON.parse(response.text)).toStrictEqual(NOT_FOUND);
        expectNoProfile(response.text);
      }
    });
  });

  it('nearby unknown routes are 404', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      for (const path of [
        '/api/v10/oauth2/applications/@me/',
        '/api/v10/oauth2/applications/100000000000000002',
        '/api/v10/oauth2/applications',
        '/api/v10/applications/@me',
        '/api/v10/oauth2/applications/@me/assets',
        '/api/v10/OAUTH2/applications/@me',
        '/api/v10/oauth2/applications/%40me',
      ]) {
        const response = await send(port, path, { authorization: TOKEN_A });
        expect(response.status, path).toBe(404);
        expect(JSON.parse(response.text)).toStrictEqual(NOT_FOUND);
      }
    });
  });

  it('the v9 prefix and query strings follow the existing route rules', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      expect(await getJson(port, '/api/v9/users/@me')).toStrictEqual(EXPECTED_USER);
      expect(await getJson(port, '/api/v9/oauth2/applications/@me')).toStrictEqual(
        EXPECTED_APPLICATION,
      );
      expect(await getJson(port, '/api/v10/users/@me?with_counts=true')).toStrictEqual(
        EXPECTED_USER,
      );
      expect(
        await getJson(port, '/api/v10/oauth2/applications/@me?with_counts=true'),
      ).toStrictEqual(EXPECTED_APPLICATION);
      expect(await getJson(port, '/api/v9/oauth2/applications/@me?with_counts=true')).toStrictEqual(
        EXPECTED_APPLICATION,
      );
    });
  });

  it('unconfigured users/@me keeps the existing fallback and state behavior', async () => {
    const empty = harness();
    await withServer(new LocalRestEmulator(empty.options), async (port) => {
      expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual({
        id: '0',
        username: 'DisRunner Bot',
        discriminator: '0000',
        bot: true,
      });
    });
    const populated = harness();
    populated.state.create('user', { id: '555', username: 'State Bot', bot: true });
    await withServer(new LocalRestEmulator(populated.options), async (port) => {
      expect(await getJson(port, '/api/v10/users/@me')).toStrictEqual({
        id: '555',
        username: 'State Bot',
        bot: true,
      });
    });
  });

  it('unconfigured application route is 404 even with a bot user in state', async () => {
    const populated = harness();
    populated.state.create('user', { id: '555', username: 'State Bot', bot: true });
    await withServer(new LocalRestEmulator(populated.options), async (port) => {
      const response = await send(port, '/api/v10/oauth2/applications/@me', {
        authorization: TOKEN_A,
      });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.text)).toStrictEqual(NOT_FOUND);
      expect(response.text).not.toContain('555');
    });
  });

  it('a configured profile wins over a bot user in state', async () => {
    const populated = harness();
    populated.state.create('user', { id: '555', username: 'State Bot', bot: true });
    await withServer(construct(inputProfile(), populated), async (port) => {
      const user = await send(port, '/api/v10/users/@me', { authorization: TOKEN_A });
      const application = await send(port, '/api/v10/oauth2/applications/@me', {
        authorization: TOKEN_A,
      });
      expect(JSON.parse(user.text)).toStrictEqual(EXPECTED_USER);
      expect(JSON.parse(application.text)).toStrictEqual(EXPECTED_APPLICATION);
      expect(user.text).not.toContain('555');
      expect(application.text).not.toContain('555');
      expect(application.text).not.toContain('State Bot');
    });
  });

  it('a non-loopback Host header is 403 without profile data', async () => {
    await withServer(construct(inputProfile()), async (port) => {
      for (const path of ['/api/v10/users/@me', '/api/v10/oauth2/applications/@me']) {
        const response = await send(port, path, {
          authorization: TOKEN_A,
          host: 'example.com',
        });
        expect(response.status).toBe(403);
        expect(JSON.parse(response.text)).toStrictEqual({
          code: 0,
          message: 'Only loopback requests are accepted.',
        });
        expectNoProfile(response.text);
      }
    });
  });
});

describe('isolation, state and resources', () => {
  it('concurrent instances serve only their own profile and token', async () => {
    const first = construct(inputProfile(), harness(TOKEN_A));
    const second = construct(inputP2(), harness(TOKEN_B));
    const third = new LocalRestEmulator(harness(TOKEN_C).options);
    const [a, b, c] = await Promise.all([first.start(0), second.start(0), third.start(0)]);
    try {
      expect(await getJson(a.port, '/api/v10/users/@me', TOKEN_A)).toStrictEqual(EXPECTED_USER);
      expect(await getJson(a.port, '/api/v10/oauth2/applications/@me', TOKEN_A)).toStrictEqual(
        EXPECTED_APPLICATION,
      );
      expect(await getJson(b.port, '/api/v10/users/@me', TOKEN_B)).toStrictEqual(EXPECTED_P2_USER);
      expect(await getJson(b.port, '/api/v10/oauth2/applications/@me', TOKEN_B)).toStrictEqual(
        EXPECTED_P2_APPLICATION,
      );
      const unconfigured = await send(c.port, '/api/v10/oauth2/applications/@me', {
        authorization: TOKEN_C,
      });
      expect(unconfigured.status).toBe(404);
      expect(JSON.parse(unconfigured.text)).toStrictEqual(NOT_FOUND);
      const crossToken = await send(b.port, '/api/v10/oauth2/applications/@me', {
        authorization: TOKEN_A,
      });
      expect(crossToken.status).toBe(401);
      expect(crossToken.text).toBe(UNAUTHORIZED_TEXT);
    } finally {
      await Promise.all([first.stop(), second.stop(), third.stop()]);
    }
  });

  it('serving the profile does not write to VirtualState', async () => {
    const base = harness();
    base.state.create('user', { id: '555', username: 'State Bot', bot: true });
    const beforeSnapshot = base.state.snapshot();
    const beforeUsers = base.state.list('user');
    await withServer(construct(inputProfile(), base), async (port) => {
      await getJson(port, '/api/v10/users/@me');
      await getJson(port, '/api/v10/oauth2/applications/@me');
    });
    expect(base.state.snapshot()).toStrictEqual(beforeSnapshot);
    expect(base.state.list('user')).toStrictEqual(beforeUsers);
    for (const id of PROFILE_IDS) {
      expect(base.state.list().some((resource) => resource.id === id)).toBe(false);
    }
  });

  it('stop releases the listener, port and handles', async () => {
    const server = construct(inputProfile());
    const background = createNetServer();
    await new Promise<void>((resolve) => background.listen(0, '127.0.0.1', resolve));
    const closeBackground = () =>
      new Promise<void>((resolve, reject) =>
        background.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    const scope = new AsyncResource('rest-stop-test');
    const descendants = new Set([scope.asyncId()]);
    const created = new Map<number, string>();
    const live = new Set<number>();
    // Track this run's descendants independently of other listeners finishing their teardown.
    const hook = createHook({
      init(asyncId, type, triggerAsyncId) {
        if (!descendants.has(triggerAsyncId)) return;
        descendants.add(asyncId);
        if (type === 'TCPWRAP' || type === 'TCPSERVERWRAP') {
          created.set(asyncId, type);
          live.add(asyncId);
        }
      },
      destroy(asyncId) {
        live.delete(asyncId);
      },
    });
    hook.enable();
    try {
      await scope.runInAsyncScope(async () => {
        const { port } = await server.start(0);
        await closeBackground();
        await getJson(port, '/api/v10/oauth2/applications/@me');
        const listeners = [...created].filter(([, type]) => type === 'TCPSERVERWRAP');
        expect(listeners).toHaveLength(1);
        expect(
          [...created.values()].filter((type) => type === 'TCPWRAP').length,
        ).toBeGreaterThanOrEqual(2);
        expect(listeners.every(([asyncId]) => live.has(asyncId))).toBe(true);
        await server.stop();
        expect(server.address).toBeUndefined();
        await expect(
          send(port, '/api/v10/users/@me', { authorization: TOKEN_A }),
        ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        expect(await canBind(port)).toBe(true);
        await expect.poll(() => [...live]).toEqual([]);
      });
    } finally {
      try {
        await server.stop();
      } finally {
        try {
          if (background.listening) await closeBackground();
        } finally {
          hook.disable();
          scope.emitDestroy();
        }
      }
    }
  });
});
