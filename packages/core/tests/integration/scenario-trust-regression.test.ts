import { readFileSync } from 'node:fs';

import type { AnySchema } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { parseScenario, runScenario, type ScenarioDefinition } from '../../src/index.js';

// Validate the same corpus independently with the declared Draft 2020 validator.
const schema = JSON.parse(
  readFileSync(
    new URL('../../../../docs/schemas/discord-scenario.schema.json', import.meta.url),
    'utf8',
  ),
) as AnySchema;
const validate = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).compile(
  schema,
);
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/scenario-trust/cases.json', import.meta.url), 'utf8'),
) as { name: string; valid: boolean; scenario: unknown }[];
const scenarioInput = (value: unknown): ScenarioDefinition => value as ScenarioDefinition;

// These are execution-model oracles only; no real Discord bot or compatibility claim.
describe('scenario trust: execution outcomes', () => {
  it.each(['strict', 'lenient'] as const)(
    'fails a permission mismatch with empty assertions (%s)',
    async (mode) => {
      const result = await runScenario(
        scenarioInput({
          name: 'permission mismatch',
          mode,
          actions: [
            { type: 'permission-check', permission: 'MANAGE_MESSAGES', expected: 'allowed' },
          ],
          assertions: [],
        }),
      );
      expect(result.report).toMatchObject({ passed: false, status: 'failed' });
      expect(
        result.report.risks.some((risk) => risk.ruleId === 'SCENARIO_EXPECTATION_MISMATCH'),
      ).toBe(true);
    },
  );

  it('does not let a risk assertion excuse a permission expectation mismatch', async () => {
    const result = await runScenario(
      scenarioInput({
        name: 'mismatch is unconditional',
        actions: [{ type: 'permission-check', permission: 'MANAGE_MESSAGES', expected: 'allowed' }],
        assertions: [{ type: 'risk-present', ruleId: 'SCENARIO_EXPECTATION_MISMATCH' }],
      }),
    );
    expect(result.assertions[0]?.passed).toBe(true);
    expect(result.report.passed).toBe(false);
  });

  it('keeps an explicitly expected permission denial passing', async () => {
    const result = await runScenario(
      scenarioInput({
        name: 'expected denial',
        actions: [{ type: 'permission-check', permission: 'MANAGE_MESSAGES', expected: 'denied' }],
      }),
    );
    expect(result.report.passed).toBe(true);
  });

  it('fails the reverse permission mismatch too', async () => {
    const result = await runScenario(
      scenarioInput({
        name: 'owner allowed',
        initialState: { guilds: [{ id: 'g', ownerId: 'b' }], users: [{ id: 'b', bot: true }] },
        actions: [{ type: 'permission-check', permission: 'MANAGE_MESSAGES', expected: 'denied' }],
      }),
    );
    expect(result.report).toMatchObject({ passed: false, status: 'failed' });
  });

  const lateInteraction = { type: 'interaction', at: 0, command: 'late', acknowledgeAfterMs: 3001 };
  const earlyFollowup = {
    type: 'interaction',
    at: 0,
    command: 'early',
    acknowledgeAfterMs: 100,
    followUpAfterMs: 1,
  };
  const expiredFollowup = {
    type: 'interaction',
    at: 0,
    command: 'expired',
    acknowledgeAfterMs: 1,
    followUpAfterMs: 900000,
  };
  it.each([
    ['late acknowledgement', lateInteraction],
    ['follow-up before acknowledgement', earlyFollowup],
    ['expired follow-up', expiredFollowup],
  ])('fails an unasserted %s operation error', async (_label, action) => {
    const result = await runScenario(
      scenarioInput({ name: 'unhandled operation', actions: [action], assertions: [] }),
    );
    expect(result.report).toMatchObject({ passed: false, status: 'failed' });
  });

  it.each([
    [lateInteraction, 'INTERACTION_ACK_LATE'],
    [earlyFollowup, 'FOLLOWUP_BEFORE_ACK'],
    [expiredFollowup, 'EXPIRED_INTERACTION_TOKEN'],
  ])('keeps an explicit negative risk oracle passing: %s', async (action, ruleId) => {
    const result = await runScenario(
      scenarioInput({
        name: 'explicit negative',
        actions: [action],
        assertions: [{ type: 'risk-detected', ruleId }],
      }),
    );
    expect(result.assertions[0]?.passed).toBe(true);
    expect(result.report.passed).toBe(true);
  });

  it('does not excuse a different operation error with an unrelated passing assertion', async () => {
    const result = await runScenario(
      scenarioInput({
        name: 'unrelated assertion',
        actions: [lateInteraction, earlyFollowup],
        assertions: [{ type: 'risk-present', ruleId: 'INTERACTION_ACK_LATE' }],
      }),
    );
    expect(result.assertions[0]?.passed).toBe(true);
    expect(result.report.passed).toBe(false);
  });

  it('fails a rejected timeline resume instead of silently succeeding', async () => {
    const result = await runScenario(
      scenarioInput({
        name: 'invalid resume',
        actions: [{ type: 'gateway-resume', at: 0 }],
        assertions: [],
      }),
    );
    expect(result.report).toMatchObject({ passed: false, status: 'failed' });
  });

  it('does not turn a canonical thrown operation error into success', async () => {
    await expect(
      runScenario({
        name: 'unknown interaction',
        steps: [{ type: 'interaction-followup', interactionId: 'missing' }],
      }),
    ).rejects.toThrow();
  });

  it('round-trips normalized definitions without changing the model result', async () => {
    const input = scenarioInput({
      name: 'round trip',
      actions: [earlyFollowup],
      assertions: [{ type: 'risk-present', ruleId: 'FOLLOWUP_BEFORE_ACK' }],
    });
    expect(await runScenario(parseScenario(input))).toEqual(await runScenario(input));
  });
});

describe('scenario trust: parser and independent JSON Schema oracle', () => {
  for (const fixture of cases) {
    it(`${fixture.valid ? 'accepts' : 'rejects'} ${fixture.name}`, () => {
      expect(validate(fixture.scenario), JSON.stringify(validate.errors)).toBe(fixture.valid);
      const parse = () => parseScenario(scenarioInput(fixture.scenario));
      if (fixture.valid) {
        const normalized = parse();
        expect(validate(normalized), JSON.stringify(validate.errors)).toBe(true);
        expect(parseScenario(normalized)).toEqual(normalized);
      } else {
        expect(parse).toThrow();
      }
    });
  }

  it('preserves arbitrary resource and nested payload keys', () => {
    const payload = { custom: { typoLookingButOpen: true, nested: [1, null, { x: 'ok' }] } };
    const parsed = parseScenario({
      name: 'open payload',
      initialState: [{ resourceType: 'custom-type', ...payload }],
      steps: [{ type: 'create-resource', resourceType: 'custom-type', data: payload }],
    });
    expect(parsed.initialState?.[0]?.['custom']).toEqual(payload.custom);
    expect(parsed.steps[0]).toMatchObject({ data: payload });
  });
});
