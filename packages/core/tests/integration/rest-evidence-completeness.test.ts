import { describe, expect, it } from 'vitest';
import {
  FaultPolicy,
  GatewayEmulator,
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

async function harness(commands = false) {
  const clock = new VirtualClock();
  const random = new SeededRandom(42);
  const snowflakes = new SnowflakeGenerator(clock);
  const user = {
    id: '3000',
    username: 'actor',
    discriminator: '0',
    avatar: null,
    bot: false,
  } as const;
  const bot = { ...user, id: '4000', username: 'bot', bot: true } as const;
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: '1000', name: 'Guild', owner_id: user.id },
    { resourceType: 'channel', id: '2000', guild_id: '1000', name: 'general', type: 0 },
    { resourceType: 'user', ...bot },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: '9000',
    botUserId: bot.id,
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    profile: createSimulationProfile(),
  });
  const trace = new TraceCollector({ clock, random, maxOpenSpans: 2 });
  const faults = new FaultPolicy();
  const rest = new LocalRestEmulator({
    state,
    interactions,
    gateway,
    trace,
    faultPolicy: faults,
    rateLimits: new RateLimitEngine(clock),
    ...(commands
      ? {
          commandRegistry: { profile: 'command-registry-v2' as const, guildIds: [] },
          bootstrap: {
            user: bot,
            application: {
              id: '9000',
              name: 'Application',
              description: '',
              icon: null,
              bot_public: false,
              bot_require_code_grant: false,
              owner: user,
              verify_key: '0'.repeat(64),
              flags: 0,
              team: null,
            },
          },
        }
      : {}),
  });
  const address = await rest.start(0);
  const get = (path: string) =>
    fetch(address.apiBaseUrl + path, { headers: { Authorization: 'Bot ' + gateway.sessionToken } });
  return { state, bot, trace, faults, rest, get };
}

describe('REST early-return evidence', () => {
  it('completes injected-failure spans and remains usable after faults are exhausted', async () => {
    const h = await harness();
    try {
      h.faults.set([
        { id: 'temporary', kind: 'http-status', status: 503, route: '/gateway', count: 2 },
      ]);
      for (let index = 0; index < 2; index += 1) {
        const response = await h.get('/gateway');
        expect(response.status).toBe(503);
        await response.text();
        expect(h.trace.openSpanCount()).toBe(0);
      }
      const recovered = await h.get('/gateway');
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(h.trace.spans().map(({ status }) => status)).toEqual(['error', 'error', 'ok']);
      expect(h.trace.evidence()).toMatchObject({
        startedSpans: 3,
        completedSpans: 3,
        openSpans: 0,
        rejectedSpans: 0,
        complete: true,
      });
    } finally {
      await h.rest.stop();
    }
  });

  it('records a command-registry 5xx as an error rather than a successful route', async () => {
    const h = await harness(true);
    try {
      h.faults.set([
        { id: 'registry', kind: 'http-status', status: 503, route: '/applications/9000/commands' },
      ]);
      const response = await h.get('/applications/9000/commands');
      expect(response.status).toBe(503);
      await response.text();
      expect(h.trace.openSpanCount()).toBe(0);
      expect(h.trace.spans().map(({ status }) => status)).toEqual(['error']);
    } finally {
      await h.rest.stop();
    }
  });

  it('completes authenticated binary attachment downloads without leaking spans', async () => {
    const h = await harness();
    try {
      const prepared = h.rest.localAttachments().prepare([
        {
          id: '0',
          filename: 'note.txt',
          contentType: 'text/plain',
          data: Buffer.from('local content'),
        },
      ]);
      const metadata = prepared.attachments[0]!;
      prepared.commit();
      h.state.create('message', {
        type: 0,
        channel_id: '2000',
        guild_id: '1000',
        author: h.bot,
        content: '',
        flags: 0,
        visibility: 'channel',
        attachments: [metadata],
      });
      for (let index = 0; index < 3; index += 1) {
        const response = await h.get(`/attachments/${metadata.id}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('local content');
      }
      expect(h.trace.spans().map(({ status }) => status)).toEqual(['ok', 'ok', 'ok']);
      expect(h.trace.evidence()).toMatchObject({
        startedSpans: 3,
        completedSpans: 3,
        openSpans: 0,
        droppedSpans: 0,
        complete: true,
      });
    } finally {
      await h.rest.stop();
    }
  });
});
