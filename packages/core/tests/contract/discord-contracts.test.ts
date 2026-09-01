import { describe, expect, it } from 'vitest';

import {
  DISCORD_EPOCH_MS,
  DiscordApiError,
  DiscordValidationError,
  InteractionEngine,
  MessageFlags,
  RateLimitEngine,
  SeededRandom,
  SnowflakeGenerator,
  VirtualClock,
  assertValidMessagePayload,
  createSimulationProfile,
  validateMessagePayload,
} from '../../src/index.js';

describe('Discord-compatible public contracts', () => {
  it('keeps the protocol profile fixed to v10, 3 seconds, 15 minutes, and offline', () => {
    expect(createSimulationProfile({ seed: 42, mode: 'lenient' })).toEqual({
      seed: 42,
      mode: 'lenient',
      apiVersion: 10,
      interactionDeadlineMs: 3_000,
      interactionTokenTtlMs: 900_000,
      networkPolicy: 'offline',
    });
    expect(() => createSimulationProfile({ interactionDeadlineMs: 3_001 as 3_000 })).toThrow(
      /3,000/,
    );
  });

  it('serializes Discord API errors as code/message without simulator internals', () => {
    const error = new DiscordApiError(403, 50013, 'Missing Permissions');
    expect(error.toJSON()).toEqual({ code: 50013, message: 'Missing Permissions' });
    expect(JSON.stringify(error.toJSON())).toBe('{"code":50013,"message":"Missing Permissions"}');
  });

  it('returns standard rate-limit headers and 429 body types', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const rateLimits = new RateLimitEngine(clock, [
      { id: 'bucket-a', method: 'GET', route: '/guilds/:guildId', limit: 1, windowMs: 2_500 },
    ]);
    rateLimits.acquire({ method: 'GET', path: '/guilds/1' });
    const response = rateLimits.acquire({ method: 'GET', path: '/guilds/1' });
    expect(response.status).toBe(429);
    expect(response.headers).toMatchObject({
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset-After': '2.5',
      'X-RateLimit-Bucket': 'bucket-a',
      'Retry-After': '2.5',
    });
    expect(response.body).toEqual({
      message: 'You are being rate limited.',
      retry_after: 2.5,
      global: false,
    });
  });

  it('enforces message, embed, component V2, and custom_id limits', () => {
    const result = validateMessagePayload({
      content: 'x'.repeat(2_001),
      embeds: [{ description: 'x'.repeat(4_097) }],
      flags: MessageFlags.IS_COMPONENTS_V2,
      components: [
        { type: 17, custom_id: 'same', components: [{ type: 2, custom_id: 'same' }] },
        ...Array.from({ length: 40 }, (_, index) => ({ type: 10, id: index })),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'BASE_TYPE_MAX_LENGTH',
        'COMPONENT_V2_CONTENT_CONFLICT',
        'COMPONENT_MAX_COUNT',
        'CUSTOM_ID_COLLISION',
      ]),
    );
    expect(() =>
      assertValidMessagePayload({ attachments: Array.from({ length: 11 }, () => ({})) }),
    ).toThrowError(DiscordValidationError);
  });

  it('turns strict validation failures into warnings in lenient mode', () => {
    const result = validateMessagePayload({ content: 'x'.repeat(2_001) }, 'lenient');
    expect(result).toMatchObject({ valid: true, issues: [] });
    expect(result.warnings).toHaveLength(1);
  });

  it('bounds deeply nested and oversized component graphs', () => {
    let nested: Record<string, unknown> = { type: 2, custom_id: 'leaf' };
    for (let index = 0; index < 100; index += 1) {
      nested = { type: 17, components: [nested] };
    }
    const deep = validateMessagePayload({
      flags: MessageFlags.IS_COMPONENTS_V2,
      components: [nested],
    });
    expect(deep.valid).toBe(false);
    expect(deep.issues.some((entry) => entry.code === 'COMPONENT_MAX_DEPTH')).toBe(true);

    const broad = validateMessagePayload({
      flags: MessageFlags.IS_COMPONENTS_V2,
      components: Array.from({ length: 1_100 }, () => ({ type: 10 })),
    });
    expect(broad.issues.some((entry) => entry.code === 'COMPONENT_SCAN_LIMIT')).toBe(true);
  });

  it('uses callback restrictions for autocomplete interactions', () => {
    const clock = new VirtualClock({ nowMs: DISCORD_EPOCH_MS });
    const random = new SeededRandom(2);
    const interactions = new InteractionEngine({
      clock,
      random,
      snowflakes: new SnowflakeGenerator(clock),
      profile: createSimulationProfile(),
    });
    const interaction = interactions.create({ type: 'autocomplete' });
    expect(() => interactions.respond(interaction.id, 'message')).toThrowError(DiscordApiError);
    expect(interactions.respond(interaction.id, 'autocomplete', { choices: [] }).status).toBe(
      'responded',
    );
  });
});
