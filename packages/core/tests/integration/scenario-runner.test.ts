import { describe, expect, it } from 'vitest';

import { parseScenario, runScenario } from '../../src/index.js';

const timelineScenario = `
version: 1
name: interaction-lifecycle
seed: 42042
mode: strict
initialState:
  guilds:
    - id: "1000"
      name: Foundation Lab
  channels:
    - id: "2000"
      guildId: "1000"
      name: bot-testing
actions:
  - at: 0
    type: interaction
    command: ping
    acknowledgeAfterMs: 120
  - at: 1000
    type: interaction
    command: deferred
    acknowledgeAfterMs: 2800
    followUpAfterMs: 4200
  - at: 7000
    type: interaction
    command: late
    acknowledgeAfterMs: 3001
  - at: 12000
    type: gateway-disconnect
    resumable: true
  - at: 12500
    type: gateway-resume
  - at: 14000
    type: permission-check
    permission: MANAGE_MESSAGES
    expected: denied
  - at: 15000
    type: rest-request
    route: POST /channels/2000/messages
    repeat: 6
assertions:
  - type: interaction-acknowledged
    command: ping
    withinMs: 3000
  - type: interaction-acknowledged
    command: deferred
    withinMs: 3000
  - type: risk-detected
    ruleId: INTERACTION_ACK_LATE
  - type: gateway-resumed
  - type: no-secret-leak
`;

describe('ScenarioRunner integration', () => {
  it('accepts the repository timeline dialect and exercises all core engines', async () => {
    const parsed = parseScenario(timelineScenario);
    expect(parsed).toMatchObject({ name: 'interaction-lifecycle', seed: 42042, mode: 'strict' });
    expect(parsed.steps).toHaveLength(7);
    expect(parsed.initialState).toContainEqual(
      expect.objectContaining({ resourceType: 'channel', id: '2000', guild_id: '1000' }),
    );

    const result = await runScenario(parsed);
    expect(result.report.passed).toBe(true);
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(result.report.risks.map((risk) => risk.ruleId)).toEqual(
      expect.arrayContaining([
        'INTERACTION_TIMEOUT',
        'INTERACTION_ACK_LATE',
        'MISSING_BOT_PERMISSION',
        'RATE_LIMIT_HOT_BUCKET',
      ]),
    );
    expect(result.events.some((event) => event.t === 'RESUMED')).toBe(true);
  });

  it('produces byte-identical deterministic results for the same seed', async () => {
    const first = await runScenario(timelineScenario);
    const second = await runScenario(timelineScenario);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('lets an explicit runtime profile override the seed embedded in a scenario', async () => {
    const result = await runScenario(timelineScenario, { profile: { seed: 42 } });
    expect(result.report.seed).toBe(42);
  });

  it('runs canonical actions with aliases, state mutation, event dispatch, and assertions', async () => {
    const result = await runScenario({
      version: 1,
      name: 'canonical',
      seed: 7,
      steps: [
        {
          type: 'create-resource',
          resourceType: 'channel',
          data: { name: 'lab' },
          saveAs: 'channel',
        },
        {
          type: 'send-message',
          channelId: '$channel',
          authorId: 'user',
          content: 'hello',
          saveAs: 'message',
        },
        {
          type: 'update-resource',
          resourceType: 'message',
          id: '$message',
          changes: { content: 'edited' },
        },
      ],
      assertions: [
        {
          type: 'resource-field-equals',
          resourceType: 'message',
          id: '$message',
          field: 'content',
          expected: 'edited',
        },
        { type: 'event-received', event: 'MESSAGE_CREATE' },
        { type: 'risk-absent', ruleId: 'INTERACTION_TIMEOUT' },
      ],
    });
    expect(result.report.passed).toBe(true);
    expect(
      result.finalState.resources.find((resource) => resource.resourceType === 'message'),
    ).toMatchObject({
      content: 'edited',
    });
  });

  it('returns a failed report instead of hiding failed assertions', async () => {
    const result = await runScenario({
      name: 'failure',
      steps: [],
      assertions: [{ type: 'resource-exists', resourceType: 'guild', id: 'missing' }],
    });
    expect(result.report).toMatchObject({ passed: false, status: 'failed' });
    expect(result.assertions[0]).toMatchObject({ type: 'resource-exists', passed: false });
  });
});
