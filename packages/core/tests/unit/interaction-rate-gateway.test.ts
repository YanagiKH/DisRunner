import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  DiscordApiError,
  GatewayEmulator,
  GatewayIntents,
  GatewayProtocolError,
  InteractionEngine,
  RateLimitCapacityError,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  createSimulationProfile,
  type RiskFinding,
} from '../../src/index.js';

function interactionHarness(): {
  clock: VirtualClock;
  engine: InteractionEngine;
  risks: RiskFinding[];
} {
  const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 50_000 });
  const random = new SeededRandom(1);
  const risks: RiskFinding[] = [];
  return {
    clock,
    risks,
    engine: new InteractionEngine({
      clock,
      random,
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
      onRisk: (risk) => risks.push(risk),
    }),
  };
}

describe('interaction lifecycle boundaries', () => {
  it('accepts 2,999 ms but rejects exactly 3,000 ms', () => {
    const { clock, engine } = interactionHarness();
    const accepted = engine.create();
    clock.advanceBy(2_999);
    expect(engine.respond(accepted.id, 'message').status).toBe('responded');

    const expired = engine.create();
    clock.advanceBy(3_000);
    try {
      engine.respond(expired.id, 'message');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordApiError);
      expect(error).toMatchObject({ status: 404, code: 10062 });
    }
  });

  it('rejects caller-supplied production-shaped interaction tokens', () => {
    const { engine } = interactionHarness();
    expect(() =>
      engine.create({
        token: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.ABCDEF.abcdefghijklmnopqrstuvwxyz',
      }),
    ).toThrow(TypeError);
  });

  it('invalidates the token at exactly 900,000 ms', () => {
    const { clock, engine, risks } = interactionHarness();
    const interaction = engine.create();
    engine.respond(interaction.id, 'defer');
    clock.advanceBy(899_999);
    expect(engine.followup(interaction.id, { content: 'still valid' }).data).toMatchObject({
      content: 'still valid',
    });

    const second = engine.create();
    engine.respond(second.id, 'defer');
    clock.advanceBy(900_000);
    expect(() => engine.followup(second.id)).toThrowError(DiscordApiError);
    try {
      engine.respond(second.id, 'message');
      expect.unreachable('expired interactions must reject a second response');
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordApiError);
      if (!(error instanceof DiscordApiError)) throw error;
      expect(error.status).toBe(404);
      expect(error.code).toBe(10062);
    }
    expect(risks.map((risk) => risk.ruleId)).not.toContain('DOUBLE_INTERACTION_RESPONSE');
  });

  it('rejects follow-up-before-ack and double initial response with risks', () => {
    const { engine, risks } = interactionHarness();
    const interaction = engine.create();
    expect(() => engine.followup(interaction.id)).toThrowError(DiscordApiError);
    engine.respond(interaction.id, 'message');
    expect(() => engine.respond(interaction.id, 'message')).toThrowError(DiscordApiError);
    expect(risks.map((risk) => risk.ruleId)).toEqual(
      expect.arrayContaining(['FOLLOWUP_BEFORE_ACK', 'DOUBLE_INTERACTION_RESPONSE']),
    );
  });
});

describe('dynamic rate limits', () => {
  it('returns Discord-compatible decimal 429 data and resets on the exact boundary', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const engine = new RateLimitEngine(clock, [
      {
        id: 'message',
        method: 'POST',
        route: '/channels/:channelId/messages',
        limit: 2,
        windowMs: 1_250,
      },
    ]);
    expect(engine.acquire({ method: 'POST', path: '/channels/10/messages' }).remaining).toBe(1);
    expect(engine.acquire({ method: 'POST', path: '/channels/10/messages' }).remaining).toBe(0);
    const limited = engine.acquire({ method: 'POST', path: '/channels/10/messages' });
    expect(limited).toMatchObject({ allowed: false, status: 429, retryAfterMs: 1_250 });
    expect(limited.headers['X-RateLimit-Reset-After']).toBe('1.25');
    expect(limited.body?.retry_after).toBe(1.25);
    clock.advanceBy(1_250);
    expect(engine.acquire({ method: 'POST', path: '/channels/10/messages' }).allowed).toBe(true);
  });

  it('learns dynamic buckets from headers and applies global limits', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const engine = new RateLimitEngine(clock);
    const request = { method: 'PATCH', path: '/channels/1', identity: 'bot' };
    engine.observe(request, {
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset-After': '0.5',
      'X-RateLimit-Bucket': 'learned',
      'X-RateLimit-Scope': 'user',
    });
    expect(engine.acquire(request)).toMatchObject({ allowed: false, retryAfterMs: 500 });
    clock.advanceBy(500);
    expect(engine.acquire(request).allowed).toBe(true);
    engine.injectGlobalLimit(250);
    expect(engine.acquire({ method: 'GET', path: '/gateway' })).toMatchObject({
      allowed: false,
      global: true,
    });
  });

  it('bounds bucket and observed-request cardinality and prunes expired entries', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const engine = new RateLimitEngine(
      clock,
      [
        {
          id: 'bounded',
          method: 'GET',
          route: '/channels/:channelId',
          limit: 1,
          windowMs: 1_000,
          scope: 'user',
        },
      ],
      { maxBuckets: 2, maxObservedRequests: 1 },
    );
    expect(engine.acquire({ method: 'GET', path: '/channels/1', identity: 'one' }).allowed).toBe(
      true,
    );
    expect(engine.acquire({ method: 'GET', path: '/channels/2', identity: 'two' }).allowed).toBe(
      true,
    );
    expect(() => engine.acquire({ method: 'GET', path: '/channels/3', identity: 'three' })).toThrow(
      RateLimitCapacityError,
    );
    expect(engine.buckets()).toHaveLength(2);

    clock.advanceBy(1_000);
    expect(engine.acquire({ method: 'GET', path: '/channels/3', identity: 'three' }).allowed).toBe(
      true,
    );
    expect(engine.buckets()).toHaveLength(1);

    const observed = new RateLimitEngine(clock, [], {
      maxBuckets: 2,
      maxObservedRequests: 1,
    });
    const headers = {
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset-After': '1',
      'X-RateLimit-Bucket': 'observed',
    };
    observed.observe({ method: 'GET', path: '/one', identity: 'one' }, headers);
    expect(() =>
      observed.observe({ method: 'GET', path: '/two', identity: 'two' }, headers),
    ).toThrow(RateLimitCapacityError);
    expect(observed.buckets()).toHaveLength(1);
  });
});
describe('Gateway lifecycle and replay', () => {
  function gatewayHarness(sessionTtlMs = 300_000): {
    clock: VirtualClock;
    gateway: GatewayEmulator;
  } {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const random = new SeededRandom(7);
    return {
      clock,
      gateway: new GatewayEmulator({
        clock,
        random,
        snowflakes: new SnowflakeGenerator(clock),
        fakeToken: 'disrunner.offline.test-only-token-x',
        sessionTtlMs,
      }),
    };
  }

  it('validates token, filters messages, increments sequence, and replays after resume', () => {
    const { gateway } = gatewayHarness();
    expect(() => gateway.identify({ token: 'wrong', intents: 0 })).toThrowError(
      GatewayProtocolError,
    );
    const identified = gateway.identify({
      token: 'Bot disrunner.offline.test-only-token-x',
      intents: GatewayIntents.GUILD_MESSAGES,
    });
    const message = gateway.dispatch(identified.sessionId, 'MESSAGE_CREATE', {
      id: '1',
      guild_id: '2',
      content: 'not visible',
      embeds: [],
      attachments: [],
      components: [],
    });
    expect(message).toMatchObject({ s: 2, d: { content: '' } });
    gateway.disconnect(identified.sessionId);
    const resumed = gateway.resume(identified.sessionId, 'disrunner.offline.test-only-token-x', 1);
    expect(resumed.accepted).toBe(true);
    expect(resumed.replayed.map((event) => event.s)).toEqual([2]);
    expect(resumed.resumed).toMatchObject({ t: 'RESUMED', s: 3 });
  });

  it('rejects an oversized dispatch before advancing the sequence or replay history', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(70),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      maxDispatchBytes: 1_024,
      maxReplayBytesPerSession: 4_096,
      maxTotalReplayBytes: 8_192,
    });
    const identified = gateway.identify({ token, intents: 0 });

    expect(() =>
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', {
        text: 'x'.repeat(8 * 1_048_576),
      }),
    ).toThrowError(/dispatch exceeds the configured 1024 byte limit/i);
    expect(() =>
      gateway.dispatch(identified.sessionId, 'E'.repeat(1_000_000), { ok: true }),
    ).toThrowError(/event name exceeds 256 encoded bytes/i);
    expect(() =>
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', { text: 'x'.repeat(2_000) }),
    ).toThrowError(/dispatch exceeds the configured 1024 byte limit/i);
    expect(() =>
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', {
        hidden: new Map([['large', 'x'.repeat(2_000)]]),
      }),
    ).toThrowError(/plain JSON objects and arrays/i);
    expect(() =>
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', { sparse: new Array(100) }),
    ).toThrowError(/must not be sparse/i);
    expect(gateway.session(identified.sessionId)?.sequence).toBe(identified.ready.s);
    expect(gateway.replay(identified.sessionId, identified.ready.s)).toEqual([]);
    expect(gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', { ok: true })).toMatchObject({
      s: 2,
    });
  });

  it('evicts replay packets by retained byte size even before the count limit', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(71),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      replayLimit: 100,
      maxDispatchBytes: 800,
      maxReplayBytesPerSession: 800,
      maxTotalReplayBytes: 8_192,
    });
    const identified = gateway.identify({ token, intents: 0 });
    for (let index = 0; index < 4; index += 1) {
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', {
        index,
        text: 'x'.repeat(300),
      });
    }

    expect(gateway.replay(identified.sessionId, 0).map((event) => event.s)).toEqual([4, 5]);
  });

  it('accounts exact JSON wire bytes for escaped and non-ASCII dispatch data', () => {
    const token = 'disrunner.offline.test-only-token-x';
    const data = {
      text: '"\\\b\t\n\f\r\u0001é😀\ud800'.repeat(100),
      values: [null, true, false, -0, 1e21],
      nested: { 'escaped"\\key': 'value' },
    };
    const exactBytes = Buffer.byteLength(
      JSON.stringify({ op: 0, t: 'CUSTOM_EVENT', s: 2, d: data }),
    );
    const createGateway = (maxDispatchBytes: number): GatewayEmulator => {
      const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
      return new GatewayEmulator({
        clock,
        random: new SeededRandom(75),
        snowflakes: new SnowflakeGenerator(clock),
        fakeToken: token,
        maxDispatchBytes,
        maxReplayBytesPerSession: exactBytes * 3,
        maxTotalReplayBytes: exactBytes * 5,
      });
    };

    const accepted = createGateway(exactBytes);
    const acceptedSession = accepted.identify({ token, intents: 0 });
    expect(() => accepted.dispatch(acceptedSession.sessionId, 'CUSTOM_EVENT', data)).not.toThrow();

    const rejected = createGateway(exactBytes - 1);
    const rejectedSession = rejected.identify({ token, intents: 0 });
    expect(() => rejected.dispatch(rejectedSession.sessionId, 'CUSTOM_EVENT', data)).toThrowError(
      /dispatch exceeds the configured/i,
    );
    expect(rejected.session(rejectedSession.sessionId)?.sequence).toBe(rejectedSession.ready.s);
  });

  it('rejects total replay capacity exhaustion without advancing the session', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(72),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      maxDispatchBytes: 1_024,
      maxReplayBytesPerSession: 2_048,
      maxTotalReplayBytes: 1_024,
    });
    const identified = gateway.identify({ token, intents: 0 });

    expect(() =>
      gateway.dispatch(identified.sessionId, 'CUSTOM_EVENT', { text: 'x'.repeat(850) }),
    ).toThrowError(/replay history capacity exceeded/i);
    expect(gateway.session(identified.sessionId)?.sequence).toBe(identified.ready.s);
    expect(gateway.replay(identified.sessionId, identified.ready.s)).toEqual([]);
  });

  it('keeps a disconnected session resumable when the RESUMED dispatch exceeds total capacity', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(74),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      maxDispatchBytes: 350,
      maxReplayBytesPerSession: 2_048,
      maxTotalReplayBytes: 550,
    });
    const first = gateway.identify({ token, intents: 0 });
    const second = gateway.identify({ token, intents: 0 });
    gateway.disconnect(first.sessionId);

    expect(() => gateway.resume(first.sessionId, token, first.ready.s)).toThrowError(
      /replay history capacity exceeded/i,
    );
    expect(gateway.session(first.sessionId)).toMatchObject({
      state: 'disconnected',
      sequence: first.ready.s,
    });
    gateway.invalidate(second.sessionId, false);
    expect(gateway.resume(first.sessionId, token, first.ready.s).accepted).toBe(true);
  });

  it('rejects resume at the exact session expiry boundary', () => {
    const { clock, gateway } = gatewayHarness(1_000);
    const identified = gateway.identify({
      token: 'disrunner.offline.test-only-token-x',
      intents: 0,
    });
    gateway.disconnect(identified.sessionId);
    clock.advanceBy(1_000);
    expect(
      gateway.resume(
        identified.sessionId,
        'disrunner.offline.test-only-token-x',
        identified.ready.s,
      ),
    ).toMatchObject({
      accepted: false,
    });
  });

  it('releases expired session bytes from the cross-session replay budget', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(73),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      sessionTtlMs: 1,
      maxDispatchBytes: 350,
      maxReplayBytesPerSession: 350,
      maxTotalReplayBytes: 350,
    });
    const first = gateway.identify({ token, intents: 0 });
    gateway.disconnect(first.sessionId);
    clock.advanceBy(1);

    expect(gateway.resume(first.sessionId, token, first.ready.s).accepted).toBe(false);
    expect(gateway.identify({ token, intents: 0 })).toHaveProperty('sessionId');
  });

  it('detects a missed heartbeat acknowledgement', () => {
    const { clock, gateway } = gatewayHarness();
    const identified = gateway.identify({
      token: 'disrunner.offline.test-only-token-x',
      intents: 0,
    });
    gateway.setHeartbeatAckEnabled(false);
    expect(gateway.heartbeat(identified.sessionId, identified.ready.s)).toBeUndefined();
    clock.advanceBy(41_250);
    expect(gateway.checkLiveness(identified.sessionId)).toBe(false);
  });

  it('does not let invalid credentials consume the identify quota', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(8),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      maxIdentifiesPerWindow: 1,
    });
    for (let index = 0; index < 3; index += 1) {
      expect(() => gateway.identify({ token: 'wrong', intents: 0 })).toThrowError(
        GatewayProtocolError,
      );
    }
    expect(gateway.identify({ token, intents: 0 })).toHaveProperty('sessionId');
    expect(() => gateway.identify({ token, intents: 0 })).toThrowError(GatewayProtocolError);
  });

  it('only resumes disconnected sessions and bounds retained session state', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS + 1_000 });
    const token = 'disrunner.offline.test-only-token-x';
    const gateway = new GatewayEmulator({
      clock,
      random: new SeededRandom(9),
      snowflakes: new SnowflakeGenerator(clock),
      fakeToken: token,
      sessionTtlMs: 1_000,
      maxSessions: 2,
    });
    const first = gateway.identify({ token, intents: 0 });
    const second = gateway.identify({ token, intents: 0 });
    expect(gateway.resume(first.sessionId, token, first.ready.s)).toMatchObject({
      accepted: false,
    });
    expect(() => gateway.identify({ token, intents: 0 })).toThrowError(GatewayProtocolError);
    gateway.disconnect(first.sessionId);
    clock.advanceBy(1_000);
    expect(gateway.identify({ token, intents: 0 })).toHaveProperty('sessionId');
    expect(gateway.sessions()).toHaveLength(2);
    expect(gateway.session(second.sessionId)?.state).toBe('ready');
  });
});
