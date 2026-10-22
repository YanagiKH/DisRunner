import { describe, expect, it, vi, type MockInstance } from 'vitest';

import * as core from '../../src/index.js';
import {
  DiscordApiError,
  GatewayEmulator,
  MessageDomainService,
  InteractionEngine,
  LocalRestEmulator,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  TraceCollector,
  VirtualClock,
  VirtualState,
  createSimulationProfile,
} from '../../src/index.js';
import type {
  InteractionMessageCommand,
  MessageDomainEvent,
  SimulatedInteraction,
} from '../../src/index.js';

const APP = '111111111111111111';
const BOT = '333333333333333333';
const OTHER_APP = '222222222222222222';
const MISSING_MESSAGE = '999999999999999999';
const WRONG_TOKEN = 'disrunner.offline.interaction_wrongwrongwrongwrongwrong';
const BAD_ENCODING = '%e0%a4%a';
const TOKEN_LIFETIME_MS = 900_000;
const enc = encodeURIComponent;

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
  readonly headers: Headers;
}

interface Stack {
  readonly clock: VirtualClock;
  readonly engine: InteractionEngine;
  readonly gateway: GatewayEmulator;
  readonly rateLimits: RateLimitEngine;
  readonly acquire: MockInstance;
  readonly trace: TraceCollector;
  readonly server: LocalRestEmulator;
  readonly replies: Reply[];
  readonly api: string;
}

async function startStack(): Promise<Stack> {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const random = new SeededRandom(8_411);
  const snowflakes = new SnowflakeGenerator(clock);
  const engine = new InteractionEngine({
    applicationId: APP,
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
  });
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: APP,
    botUserId: BOT,
  });
  const rateLimits = new RateLimitEngine(clock);
  const acquire = vi.spyOn(rateLimits, 'acquire');
  const trace = new TraceCollector({ clock, random });
  const server = new LocalRestEmulator({
    state: new VirtualState(clock, snowflakes),
    interactions: engine,
    gateway,
    rateLimits,
    trace,
  });
  const address = await server.start();
  return {
    clock,
    engine,
    gateway,
    rateLimits,
    acquire,
    trace,
    server,
    replies: [],
    api: address.apiBaseUrl,
  };
}

async function withStack(run: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await startStack();
  try {
    await run(stack);
  } finally {
    await stack.server.stop();
  }
}

async function call(
  stack: Stack,
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly raw?: string; readonly auth?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== undefined) headers['Authorization'] = options.auth;
  const body =
    options.raw !== undefined
      ? options.raw
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    parsed = undefined;
  }
  const reply = { status: response.status, text, body: parsed, headers: response.headers };
  stack.replies.push(reply);
  return reply;
}

/** Every new token route: original and followup item, read/edit/delete. */
function itemRoutes(app: string, token: string): readonly (readonly [string, string, unknown])[] {
  const base = `/webhooks/${app}/${token}/messages`;
  return [
    ['GET', `${base}/@original`, undefined],
    ['PATCH', `${base}/@original`, { content: 'edit' }],
    ['DELETE', `${base}/@original`, undefined],
    ['GET', `${base}/${MISSING_MESSAGE}`, undefined],
    ['PATCH', `${base}/${MISSING_MESSAGE}`, { content: 'edit' }],
    ['DELETE', `${base}/${MISSING_MESSAGE}`, undefined],
  ];
}

function acknowledged(stack: Stack): SimulatedInteraction {
  const interaction = stack.engine.create();
  stack.engine.respond(interaction.id, 'message', { content: 'Model.' });
  return interaction;
}

function expectError(reply: Reply, status: number, code: number): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toMatchObject({ code });
}

describe('interaction message token routes: authentication before quota', () => {
  it('rejects a wrong application on original and followup item routes before quota or body read', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      const before = structuredClone(stack.rateLimits.buckets());
      for (const [method, path, body] of itemRoutes(OTHER_APP, enc(interaction.token))) {
        expectError(await call(stack, method, path, { body }), 404, 10015);
        if (method === 'PATCH')
          expectError(await call(stack, method, path, { raw: '{invalid-json' }), 404, 10015);
      }
      expect(stack.acquire).not.toHaveBeenCalled();
      expect(stack.rateLimits.buckets()).toEqual(before);
    });
  });

  it('rejects a wrong token on original and followup item routes with unknown webhook', async () => {
    await withStack(async (stack) => {
      acknowledged(stack);
      const before = structuredClone(stack.rateLimits.buckets());
      for (const [method, path, body] of itemRoutes(APP, enc(WRONG_TOKEN)))
        expectError(await call(stack, method, path, { body }), 404, 10015);
      expect(stack.acquire).not.toHaveBeenCalled();
      expect(stack.rateLimits.buckets()).toEqual(before);
    });
  });

  it('rejects malformed token encoding on the new routes before quota', async () => {
    await withStack(async (stack) => {
      acknowledged(stack);
      for (const [method, path, body] of itemRoutes(APP, BAD_ENCODING))
        expectError(await call(stack, method, path, { body }), 400, 50035);
      expect(stack.acquire).not.toHaveBeenCalled();
    });
  });

  it('treats the new routes as token routes that need no bot authorization', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      for (const [method, path, body] of itemRoutes(APP, enc(interaction.token))) {
        const anonymous = await call(stack, method, path, { body });
        expect(anonymous.status).not.toBe(401);
        const withBot = await call(stack, method, path, {
          body,
          auth: `Bot ${stack.gateway.sessionToken}`,
        });
        expect(withBot.status).toBe(anonymous.status);
        expect(withBot.body).toEqual(anonymous.body);
      }
    });
  });

  it('rejects an expired token on the new routes without spending quota', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      stack.clock.advanceBy(TOKEN_LIFETIME_MS);
      const before = structuredClone(stack.rateLimits.buckets());
      for (const [method, path, body] of itemRoutes(APP, enc(interaction.token)))
        expectError(await call(stack, method, path, { body }), 404, 10015);
      expect(stack.acquire).not.toHaveBeenCalled();
      expect(stack.rateLimits.buckets()).toEqual(before);
    });
  });
});

describe('model-only interactions keep their existing behavior', () => {
  it('returns the existing followup wrapper for a model interaction', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      const reply = await call(stack, 'POST', `/webhooks/${APP}/${enc(interaction.token)}`, {
        body: { content: 'Model.' },
      });
      expect(reply.status).toBe(200);
      expect(Object.keys(reply.body as object).sort()).toEqual([
        'atMs',
        'data',
        'deleted',
        'ephemeral',
        'id',
      ]);
      expect((reply.body as { data: { content: unknown } }).data.content).toBe('Model.');
    });
  });

  it('answers every original and followup item route of a model interaction with one fixed 501', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      const messages = new Set<string>();
      for (const [method, path, body] of itemRoutes(APP, enc(interaction.token))) {
        const reply = await call(stack, method, path, { body });
        expectError(reply, 501, 0);
        const message = (reply.body as { message: string }).message;
        expect(typeof message).toBe('string');
        for (const value of [interaction.token, interaction.id, APP, MISSING_MESSAGE, '/webhooks'])
          expect(message).not.toContain(value);
        messages.add(message);
      }
      expect(messages.size).toBe(1);
    });
  });

  it('never returns the token in a response header', async () => {
    await withStack(async (stack) => {
      const interaction = acknowledged(stack);
      await call(stack, 'POST', `/webhooks/${APP}/${enc(interaction.token)}`, {
        body: { content: 'Model.' },
      });
      for (const [method, path, body] of itemRoutes(APP, enc(interaction.token)))
        await call(stack, method, path, { body });
      for (const reply of stack.replies)
        for (const [, value] of reply.headers) {
          expect(value).not.toContain(interaction.token);
          expect(value).not.toContain(enc(interaction.token));
        }
    });
  });
});

// Authoritative stack: shared state, then Gateway, then the bootstrap user, then REST and engine.
const RUN = 'interaction-message-run';
const ACTOR = '666666666666666666';
const GUILD = '777777777777777777';
const CHANNEL = '888888888888888888';
const AUTHOR = { id: BOT, username: 'fixture-bot', discriminator: '0000', avatar: null, bot: true };
const MARK = (n: number): string => `zz-private-marker-${n}`;

interface Authority {
  readonly clock: VirtualClock;
  readonly state: VirtualState;
  readonly gateway: GatewayEmulator;
  readonly engine: InteractionEngine;
  readonly ordinary: MessageDomainService;
  readonly server: LocalRestEmulator;
  readonly api: string;
  readonly packets: { readonly t: string; readonly id: string }[];
}

interface Evidence {
  readonly records: readonly { readonly event: MessageDomainEvent; readonly delivery: unknown }[];
  readonly dropped: number;
}

function authorityParts(seed = 9_101, runId = RUN) {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const random = new SeededRandom(seed);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'user', ...AUTHOR },
    { resourceType: 'user', id: ACTOR, username: 'actor', bot: false },
    { resourceType: 'guild', id: GUILD, name: 'guild' },
    { resourceType: 'channel', id: CHANNEL, type: 0, guild_id: GUILD },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: APP,
    botUserId: BOT,
  });
  const server = new LocalRestEmulator({
    state,
    gateway,
    // Evidence reader for this run only; its own engine is a plain model engine.
    interactions: new InteractionEngine({
      applicationId: APP,
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile(),
    }),
    rateLimits: new RateLimitEngine(clock),
    messageDomain: { runId },
  });
  return { clock, random, snowflakes, state, gateway, server };
}

async function startAuthority(seed = 9_101): Promise<Authority> {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const random = new SeededRandom(seed);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'user', ...AUTHOR },
    { resourceType: 'user', id: ACTOR, username: 'actor', bot: false },
    { resourceType: 'guild', id: GUILD, name: 'guild' },
    { resourceType: 'channel', id: CHANNEL, type: 0, guild_id: GUILD },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: APP,
    botUserId: BOT,
  });
  const engine = new InteractionEngine({
    applicationId: APP,
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
    messageAuthority: { state, gateway, author: AUTHOR, context: { runId: RUN } },
  });
  const server = new LocalRestEmulator({
    state,
    gateway,
    interactions: engine,
    rateLimits: new RateLimitEngine(clock),
    messageDomain: { runId: RUN },
  });
  const ordinary = new MessageDomainService({
    state,
    gateway,
    author: AUTHOR,
    context: { runId: RUN },
  });
  const packets: { t: string; id: string }[] = [];
  gateway.identify({ token: gateway.sessionToken, intents: 512 });
  gateway.subscribeBroadcast((_session, packet) => {
    if (typeof packet.t === 'string' && packet.t.startsWith('MESSAGE_'))
      packets.push({ t: packet.t, id: (packet.d as { id: string }).id });
  });
  const address = await server.start();
  return { clock, state, gateway, engine, ordinary, server, api: address.apiBaseUrl, packets };
}

async function withAuthority(run: (a: Authority) => void | Promise<void>): Promise<void> {
  const authority = await startAuthority();
  try {
    await run(authority);
  } finally {
    await authority.server.stop();
  }
}

function chatInput(a: Pick<Authority, 'engine'>): SimulatedInteraction {
  return a.engine.create({
    type: 'command',
    data: { type: 1, name: 'ping' },
    messageProfile: 'chat-input-messages-v1',
    context: { actorId: ACTOR, channelId: CHANNEL, guildId: GUILD },
  });
}

function execute(a: Pick<Authority, 'engine'>, command: InteractionMessageCommand) {
  return a.engine.executeMessage(command);
}

function evidence(a: { readonly server: LocalRestEmulator }): Evidence {
  return a.server.messageEvidence();
}

function summary(e: Evidence): readonly (readonly [string, number, string, unknown])[] {
  return e.records.map(({ event }) => [
    event.origin,
    event.sequence,
    event.payload.type,
    event.payload.message['content'],
  ]);
}

function expectApiError(run: () => unknown, status: number, code: number, message?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DiscordApiError);
  expect((caught as DiscordApiError).status).toBe(status);
  expect((caught as DiscordApiError).code).toBe(code);
  if (message !== undefined) expect((caught as DiscordApiError).message).toBe(message);
}

async function send(
  a: Authority,
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) headers['Authorization'] = auth;
  const response = await fetch(`${a.api}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, body: parsed, headers: response.headers };
}

function ordinaryPost(a: Authority, content: string): Promise<Reply> {
  return send(
    a,
    'POST',
    `/channels/${CHANNEL}/messages`,
    { content },
    `Bot ${a.gateway.sessionToken}`,
  );
}

describe('authoritative construction', () => {
  it('rejects an engine whose application differs from the Gateway application', () => {
    const { clock, random, snowflakes, state, gateway } = authorityParts();
    expect(
      () =>
        new InteractionEngine({
          applicationId: OTHER_APP,
          clock,
          random,
          snowflakes,
          profile: createSimulationProfile(),
          messageAuthority: { state, gateway, author: AUTHOR, context: { runId: RUN } },
        }),
    ).toThrow(new TypeError('Interaction application must match the Gateway application.'));
  });

  it('authors a committed original as the bot user, compared by value', async () => {
    await withAuthority((a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      const original = a.engine.getOriginalMessage(interaction.id);
      expect(original['author']).toMatchObject({ id: BOT, bot: true });
      expect(a.gateway.botUserId).toBe(BOT);
    });
  });
});

describe('shared message guard, sequence and evidence', () => {
  it('exports no guard, sequence or evidence collector from the package index', () => {
    const exported = Object.keys(core);
    // Internal guard, sequence and evidence helpers stay out of the package index.
    for (const name of [
      'messageCommandActive',
      'assertMessageCommandIdle',
      'withMessageCommand',
      'nextMessageSequence',
      'commitMessageSequence',
      'readMessageEvidence',
      'recordMessageEvidence',
    ])
      expect(exported).not.toContain(name);
    expect(exported).toEqual(
      expect.arrayContaining(['isOrdinaryMessage', 'mapMessageEvent', 'projectMessageWire']),
    );
  });

  it('keeps the public message helpers exported as functions from the package index', () => {
    expect(typeof core.isOrdinaryMessage).toBe('function');
    expect(typeof core.mapMessageEvent).toBe('function');
    expect(typeof core.projectMessageWire).toBe('function');
  });

  it('runs no observer, fanout or evidence write when payload validation fails', async () => {
    await withAuthority((a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      const before = evidence(a);
      const revision = a.state.revision;
      const packets = a.packets.length;
      const observer = vi.fn();
      const remove = a.gateway.subscribeBroadcast(observer);
      try {
        expectApiError(
          () =>
            execute(a, {
              operation: 'create-followup',
              interactionId: interaction.id,
              data: { content: 1, tts: MARK(1) },
            }),
          400,
          50035,
          'Invalid interaction message payload.',
        );
      } finally {
        remove();
      }
      expect(observer).not.toHaveBeenCalled();
      expect(a.packets).toHaveLength(packets);
      expect(a.state.revision).toBe(revision);
      expect(evidence(a)).toEqual(before);
    });
  });

  it('does not consume a sequence number for a rejected command between two commits', async () => {
    await withAuthority((a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      expectApiError(
        () =>
          execute(a, {
            operation: 'edit-original',
            interactionId: interaction.id,
            data: { content: 7 },
          }),
        400,
        50035,
      );
      execute(a, {
        operation: 'edit-original',
        interactionId: interaction.id,
        data: { content: 'edited' },
      });
      const e = evidence(a);
      expect(e.dropped).toBe(0);
      expect(summary(e)).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['interaction', 2, 'MESSAGE_UPDATE', 'edited'],
      ]);
    });
  });

  it('keeps a committed message, its sequence and a partial delivery when Gateway delivery fails', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      const remove = a.gateway.subscribeBroadcast(() => {
        throw new Error(MARK(9));
      });
      let reply: Reply;
      try {
        reply = await send(a, 'POST', `/webhooks/${APP}/${enc(interaction.token)}`, {
          content: 'followup',
        });
      } finally {
        remove();
      }
      expect(reply.status).toBe(200);
      expect(reply.headers.get('x-disrunner-delivery')).toBe('partial');
      expect(Number(reply.headers.get('x-disrunner-delivery-failures'))).toBeGreaterThanOrEqual(1);
      const id = (reply.body as { id: string }).id;
      expect(a.engine.getFollowupMessage(interaction.id, id)['content']).toBe('followup');
      expect(reply.text).not.toContain(MARK(9));
      for (const [, value] of reply.headers) expect(value).not.toContain(MARK(9));
      expect(JSON.stringify(evidence(a))).not.toContain(MARK(9));
      execute(a, {
        operation: 'edit-original',
        interactionId: interaction.id,
        data: { content: 'after' },
      });
      expect(summary(evidence(a))).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['interaction', 2, 'MESSAGE_CREATE', 'followup'],
        ['interaction', 3, 'MESSAGE_UPDATE', 'after'],
      ]);
    });
  });

  it('allocates no sequence number for no-op, ephemeral and loading-only operations', async () => {
    await withAuthority((a) => {
      const ephemeral = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: ephemeral.id,
        responseType: 'message',
        data: { content: 'secret', flags: 64 },
      });
      const deferred = chatInput(a);
      execute(a, { operation: 'respond', interactionId: deferred.id, responseType: 'defer' });
      const visible = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: visible.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      execute(a, {
        operation: 'edit-original',
        interactionId: visible.id,
        data: { content: 'hello' },
      });
      execute(a, {
        operation: 'edit-original',
        interactionId: visible.id,
        data: { content: 'changed' },
      });
      expect(summary(evidence(a))).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['interaction', 2, 'MESSAGE_UPDATE', 'changed'],
      ]);
    });
  });

  it('draws interaction and ordinary channel events from one increasing sequence without duplicates', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      expect((await ordinaryPost(a, 'ordinary')).status).toBe(200);
      execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: 'followup' },
      });
      const sequences = evidence(a).records.map(({ event }) => event.sequence);
      expect(sequences).toEqual([1, 2, 3]);
      expect(new Set(sequences).size).toBe(sequences.length);
    });
  });

  it('serializes concurrent edits on one state and rejects a reentrant command from a broadcast observer with 409', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, { operation: 'respond', interactionId: interaction.id, responseType: 'defer' });
      const path = `/webhooks/${APP}/${enc(interaction.token)}/messages/@original`;
      const replies = await Promise.all([
        send(a, 'PATCH', path, { content: 'first' }),
        send(a, 'PATCH', path, { content: 'second' }),
      ]);
      for (const reply of replies) expect(reply.status).toBe(200);
      const e = evidence(a);
      expect(e.records.map(({ event }) => [event.sequence, event.payload.type])).toEqual([
        [1, 'MESSAGE_CREATE'],
        [2, 'MESSAGE_UPDATE'],
      ]);
      expect(new Set(e.records.map(({ event }) => event.payload.message['id'])).size).toBe(1);

      let inner: unknown;
      const remove = a.gateway.subscribeBroadcast(() => {
        if (inner !== undefined) return;
        try {
          execute(a, {
            operation: 'create-followup',
            interactionId: interaction.id,
            data: { content: 'inner' },
          });
          inner = 'no error';
        } catch (error) {
          inner = error;
        }
      });
      try {
        execute(a, {
          operation: 'create-followup',
          interactionId: interaction.id,
          data: { content: 'outer' },
        });
      } finally {
        remove();
      }
      expect(inner).toBeInstanceOf(DiscordApiError);
      expect((inner as DiscordApiError).status).toBe(409);
      expect((inner as DiscordApiError).code).toBe(0);
      expect((inner as DiscordApiError).message).toBe(
        'Reentrant message commands are not supported.',
      );
      expect(summary(evidence(a)).slice(2)).toEqual([
        ['interaction', 3, 'MESSAGE_CREATE', 'outer'],
      ]);
      expect(evidence(a).records).toHaveLength(3);
    });
  });

  it('rejects a command started inside an open state transaction with 409', async () => {
    await withAuthority((a) => {
      const interaction = chatInput(a);
      const revision = a.state.revision;
      let caught: unknown;
      try {
        a.state.transaction('outer', () => {
          execute(a, {
            operation: 'respond',
            interactionId: interaction.id,
            responseType: 'message',
            data: { content: 'hello' },
          });
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DiscordApiError);
      expect((caught as DiscordApiError).status).toBe(409);
      expect((caught as DiscordApiError).code).toBe(0);
      expect((caught as DiscordApiError).message).toBe(
        'Message commands require an outermost transaction.',
      );
      expect(a.state.revision).toBe(revision);
      expect(evidence(a).records).toHaveLength(0);
    });
  });

  it('keeps two independent states unblocked with independent sequences', async () => {
    const first = await startAuthority(9_201);
    const second = await startAuthority(9_202);
    try {
      const one = chatInput(first);
      const two = chatInput(second);
      let nested: unknown;
      const remove = first.gateway.subscribeBroadcast(() => {
        if (nested !== undefined) return;
        nested = execute(second, {
          operation: 'respond',
          interactionId: two.id,
          responseType: 'message',
          data: { content: 'second' },
        });
      });
      try {
        execute(first, {
          operation: 'respond',
          interactionId: one.id,
          responseType: 'message',
          data: { content: 'first' },
        });
      } finally {
        remove();
      }
      expect(nested).toMatchObject({ message: { content: 'second' } });
      expect(summary(evidence(first))).toEqual([['interaction', 1, 'MESSAGE_CREATE', 'first']]);
      expect(summary(evidence(second))).toEqual([['interaction', 1, 'MESSAGE_CREATE', 'second']]);
    } finally {
      await first.server.stop();
      await second.server.stop();
    }
  });

  it('releases the guard after an observer throws or a nested command is rejected so a later command commits', async () => {
    await withAuthority((a) => {
      const interaction = chatInput(a);
      const remove = a.gateway.subscribeBroadcast(() => {
        execute(a, {
          operation: 'create-followup',
          interactionId: interaction.id,
          data: { content: 'inner' },
        });
      });
      try {
        execute(a, {
          operation: 'respond',
          interactionId: interaction.id,
          responseType: 'message',
          data: { content: 'hello' },
        });
      } finally {
        remove();
      }
      try {
        a.state.transaction('outer', () =>
          execute(a, {
            operation: 'create-followup',
            interactionId: interaction.id,
            data: { content: 'blocked' },
          }),
        );
      } catch {
        // The rejection itself is asserted in the transaction test.
      }
      const result = execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: 'later' },
      });
      expect(result.message).toMatchObject({ content: 'later' });
      expect(summary(evidence(a))).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['interaction', 2, 'MESSAGE_CREATE', 'later'],
      ]);
    });
  });

  it('rejects a public commit under one run beyond the registration capacity without side effects', () => {
    const { clock, random, snowflakes, state, gateway } = authorityParts(9_301);
    gateway.identify({ token: gateway.sessionToken, intents: 512 });
    const runs = Array.from({ length: 128 }, (_, index) => `capacity-run-${index}`);
    const firstRun = 'capacity-run-0';
    for (const runId of runs)
      new MessageDomainService({ state, gateway, author: AUTHOR, context: { runId } }).create(
        CHANNEL,
        { content: runId },
      );
    const engine = new InteractionEngine({
      applicationId: APP,
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile(),
      messageAuthority: { state, gateway, author: AUTHOR, context: { runId: 'capacity-run-128' } },
    });
    const late = new LocalRestEmulator({
      state,
      gateway,
      interactions: engine,
      rateLimits: new RateLimitEngine(clock),
      messageDomain: { runId: 'capacity-run-128' },
    });
    const interaction = chatInput({ engine });
    const revision = state.revision;
    const observer = vi.fn();
    const remove = gateway.subscribeBroadcast(observer);
    try {
      expectApiError(
        () =>
          engine.executeMessage({
            operation: 'respond',
            interactionId: interaction.id,
            responseType: 'message',
            data: { content: 'too many' },
          }),
        503,
        0,
        'Message run registration capacity exceeded.',
      );
    } finally {
      remove();
    }
    expect(observer).not.toHaveBeenCalled();
    expect(state.revision).toBe(revision);
    expect(evidence({ server: late })).toEqual({ records: [], dropped: 0 });
    expect(() => engine.getOriginalMessage(interaction.id)).toThrow();
    const first = new MessageDomainService({
      state,
      gateway,
      author: AUTHOR,
      context: { runId: firstRun },
    });
    first.create(CHANNEL, { content: 'again' });
    expect(
      first
        .evidence()
        .records.map(({ event }) => [event.sequence, event.payload.message['content']]),
    ).toEqual([
      [1, firstRun],
      [2, 'again'],
    ]);
  });
});

describe('complete message evidence records', () => {
  it('records interaction, ordinary and interaction creates as one complete ordered list with sequences 1, 2, 3 and nothing dropped', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      expect((await ordinaryPost(a, 'ordinary')).status).toBe(200);
      execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: 'followup' },
      });
      const e = evidence(a);
      expect(e.dropped).toBe(0);
      expect(summary(e)).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['rest', 2, 'MESSAGE_CREATE', 'ordinary'],
        ['interaction', 3, 'MESSAGE_CREATE', 'followup'],
      ]);
    });
  });

  it('stores the owning interaction as correlation, a distinct causation and the header revision and event ID on every record', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      const replies = [
        await send(
          a,
          'POST',
          `/interactions/${interaction.id}/${enc(interaction.token)}/callback`,
          {
            type: 4,
            data: { content: 'hello' },
          },
        ),
        await ordinaryPost(a, 'ordinary'),
        await send(a, 'POST', `/webhooks/${APP}/${enc(interaction.token)}`, {
          content: 'followup',
        }),
      ];
      const e = evidence(a);
      expect(summary(e)).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['rest', 2, 'MESSAGE_CREATE', 'ordinary'],
        ['interaction', 3, 'MESSAGE_CREATE', 'followup'],
      ]);
      e.records.forEach(({ event }, index) => {
        const reply = replies[index] as Reply;
        expect(Number.isSafeInteger(event.stateRevision)).toBe(true);
        expect(event.stateRevision).toBe(Number(reply.headers.get('x-disrunner-state-revision')));
        expect(event.eventId).toBe(reply.headers.get('x-disrunner-event-id'));
        expect(typeof event.correlationId).toBe('string');
        expect(typeof event.causationId).toBe('string');
        expect(event.causationId).not.toBe('');
        if (event.origin === 'interaction') {
          expect(event.correlationId).toBe(interaction.id);
          for (const other of [
            interaction.id,
            interaction.token,
            event.payload.message['id'],
            event.eventId,
          ])
            expect(event.causationId).not.toBe(other);
        }
      });
    });
  });

  it('keeps the partial-delivery record without the observer error text or the token', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      const remove = a.gateway.subscribeBroadcast(() => {
        throw new Error(MARK(9));
      });
      let reply: Reply;
      try {
        reply = await send(a, 'POST', `/webhooks/${APP}/${enc(interaction.token)}`, {
          content: 'followup',
        });
      } finally {
        remove();
      }
      const e = evidence(a);
      expect(e.records).toHaveLength(2);
      const last = e.records[1] as Evidence['records'][number];
      const delivery = last.delivery as { status: string; failed: number; transportFailed: number };
      expect(delivery.status).toBe('partial');
      expect(delivery.failed + delivery.transportFailed).toBeGreaterThanOrEqual(1);
      expect(String(delivery.failed + delivery.transportFailed)).toBe(
        reply.headers.get('x-disrunner-delivery-failures'),
      );
      const serialized = JSON.stringify(e);
      expect(serialized).not.toContain(MARK(9));
      expect(serialized).not.toContain(interaction.token);
    });
  });

  it('adds no record for ephemeral, deferred, no-op, unmaterialized loading deletion, modal or rejected operations', async () => {
    await withAuthority(async (a) => {
      const visible = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: visible.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      const before = evidence(a);
      const ephemeral = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: ephemeral.id,
        responseType: 'message',
        data: { content: 'secret', flags: 64 },
      });
      const deferred = chatInput(a);
      execute(a, { operation: 'respond', interactionId: deferred.id, responseType: 'defer' });
      execute(a, {
        operation: 'create-followup',
        interactionId: visible.id,
        data: { content: 'quiet', flags: 64 },
      });
      execute(a, {
        operation: 'edit-original',
        interactionId: visible.id,
        data: { content: 'hello' },
      });
      execute(a, { operation: 'delete-original', interactionId: deferred.id });
      const modal = chatInput(a);
      const modalReply = await send(
        a,
        'POST',
        `/interactions/${modal.id}/${enc(modal.token)}/callback`,
        {
          type: 9,
          data: {
            custom_id: 'm1',
            title: 'Form',
            components: [
              { type: 1, components: [{ type: 4, custom_id: 'f1', label: 'Field', style: 1 }] },
            ],
          },
        },
      );
      expect(modalReply.status).toBe(204);
      expectApiError(
        () =>
          execute(a, {
            operation: 'create-followup',
            interactionId: visible.id,
            data: { content: 3 },
          }),
        400,
        50035,
      );
      const wrongApp = await send(a, 'POST', `/webhooks/${OTHER_APP}/${enc(visible.token)}`, {
        content: 'wrong',
      });
      expect(wrongApp.status).toBe(404);
      const after = evidence(a);
      expect(after.records).toHaveLength(before.records.length);
      expect(after.records.at(-1)).toEqual(before.records.at(-1));
      expect(after.dropped).toBe(before.dropped);
      expect(after).toEqual(before);
      execute(a, {
        operation: 'create-followup',
        interactionId: visible.id,
        data: { content: 'next' },
      });
      expect(summary(evidence(a))).toEqual([
        ['interaction', 1, 'MESSAGE_CREATE', 'hello'],
        ['interaction', 2, 'MESSAGE_CREATE', 'next'],
      ]);
    });
  });

  it('pairs every delivered message dispatch with exactly one evidence record', async () => {
    await withAuthority(async (a) => {
      const interaction = chatInput(a);
      execute(a, {
        operation: 'respond',
        interactionId: interaction.id,
        responseType: 'message',
        data: { content: 'hello' },
      });
      expect((await ordinaryPost(a, 'ordinary')).status).toBe(200);
      const followup = execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: 'followup' },
      });
      execute(a, {
        operation: 'edit-followup',
        interactionId: interaction.id,
        messageId: (followup.message as { id: string }).id,
        data: { content: 'edited' },
      });
      execute(a, { operation: 'delete-original', interactionId: interaction.id });
      const records = evidence(a).records.map(({ event }) => ({
        t: event.payload.type,
        id: event.payload.message['id'],
      }));
      expect(records).toHaveLength(5);
      expect(a.packets).toEqual(records);
    });
  });

  it('keeps separate ledgers for two run IDs on one state, each starting at sequence 1', () => {
    const {
      clock,
      random,
      snowflakes,
      state,
      gateway,
      server: restB,
    } = authorityParts(9_401, 'run-b');
    const engine = new InteractionEngine({
      applicationId: APP,
      clock,
      random,
      snowflakes,
      profile: createSimulationProfile(),
      messageAuthority: { state, gateway, author: AUTHOR, context: { runId: 'run-a' } },
    });
    const restA = new LocalRestEmulator({
      state,
      gateway,
      interactions: engine,
      rateLimits: new RateLimitEngine(clock),
      messageDomain: { runId: 'run-a' },
    });
    const interaction = chatInput({ engine });
    engine.executeMessage({
      operation: 'respond',
      interactionId: interaction.id,
      responseType: 'message',
      data: { content: 'in a' },
    });
    new MessageDomainService({
      state,
      gateway,
      author: AUTHOR,
      context: { runId: 'run-b' },
    }).create(CHANNEL, { content: 'in b' });
    const a = evidence({ server: restA });
    const b = evidence({ server: restB });
    expect(summary(a)).toEqual([['interaction', 1, 'MESSAGE_CREATE', 'in a']]);
    expect(summary(b)).toEqual([['rest', 1, 'MESSAGE_CREATE', 'in b']]);
    expect(a.records.every(({ event }) => event.runId === 'run-a')).toBe(true);
    expect(b.records.every(({ event }) => event.runId === 'run-b')).toBe(true);
  });
});

/** Alternating public commits through the engine and the ordinary domain, one shared run. */
function alternate(a: Authority, count: number): SimulatedInteraction {
  const interaction = chatInput(a);
  execute(a, {
    operation: 'respond',
    interactionId: interaction.id,
    responseType: 'message',
    data: { content: 'ack', flags: 64 },
  });
  for (let index = 1; index <= count; index += 1) {
    if (index % 2 === 1)
      execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: `m${index}` },
      });
    else a.ordinary.create(CHANNEL, { content: `m${index}` });
  }
  return interaction;
}

function expectedOrigins(from: number, to: number): readonly (readonly [string, number])[] {
  const rows: (readonly [string, number])[] = [];
  for (let index = from; index <= to; index += 1)
    rows.push([index % 2 === 1 ? 'interaction' : 'rest', index]);
  return rows;
}

function originsAndSequences(e: Evidence): readonly (readonly [string, number])[] {
  return e.records.map(({ event }) => [event.origin, event.sequence]);
}

describe('bounded evidence truncation', () => {
  it('uses complete-list comparison only while at most 100 records are kept and none were dropped', async () => {
    await withAuthority((a) => {
      alternate(a, 100);
      const e = evidence(a);
      expect(e.dropped).toBe(0);
      expect(e.records).toHaveLength(100);
      expect(originsAndSequences(e)).toEqual(expectedOrigins(1, 100));
    });
  });

  it('keeps the newest 100 of 105 alternating commits with 5 dropped and contiguous sequences 6 to 105', async () => {
    await withAuthority((a) => {
      alternate(a, 105);
      const e = evidence(a);
      expect(e.records).toHaveLength(100);
      expect(e.dropped).toBe(5);
      expect(originsAndSequences(e)).toEqual(expectedOrigins(6, 105));
      expect(e.records.map(({ event }) => event.payload.message['content'])).toEqual(
        Array.from({ length: 100 }, (_, index) => `m${index + 6}`),
      );
    });
  });

  it('continues with sequence 106 and 6 dropped after one more commit instead of resetting', async () => {
    await withAuthority((a) => {
      alternate(a, 105);
      a.ordinary.create(CHANNEL, { content: 'm106' });
      const e = evidence(a);
      expect(e.records).toHaveLength(100);
      expect(e.dropped).toBe(6);
      expect(e.records[0]?.event.sequence).toBe(7);
      expect(e.records.at(-1)?.event.sequence).toBe(106);
      expect(e.records.at(-1)?.event.payload.message['content']).toBe('m106');
    });
  });

  it('leaves records, dropped count and the next sequence unchanged for ephemeral and no-op operations after the cap', async () => {
    await withAuthority((a) => {
      const interaction = alternate(a, 105);
      const before = evidence(a);
      const followup = execute(a, {
        operation: 'create-followup',
        interactionId: interaction.id,
        data: { content: 'quiet', flags: 64 },
      });
      const last = before.records.at(-1)?.event.payload.message as { id: string };
      execute(a, {
        operation: 'edit-followup',
        interactionId: interaction.id,
        messageId: last.id,
        data: { content: 'm105' },
      });
      expect(followup.eventId).toBeNull();
      const after = evidence(a);
      expect(after).toEqual(before);
      expect(after.dropped).toBe(5);
      a.ordinary.create(CHANNEL, { content: 'm106' });
      expect(evidence(a).records.at(-1)?.event.sequence).toBe(106);
    });
  });
});
