import { describe, expect, it } from 'vitest';
import { createInitialState, simulationReducer } from './simulation';

function runningState() {
  return simulationReducer(createInitialState(), { type: 'set-bot', status: 'running' });
}

describe('simulationReducer', () => {
  it('starts fully offline with the deterministic Foundation fixture selected', () => {
    const state = createInitialState();
    expect(state.botStatus).toBe('stopped');
    expect(state.guildId).toBe('foundation');
    expect(state.channelId).toBe('bot-testing');
    expect(state.interaction.outcome).toBe('Timed out');
  });

  it('selects a guild and its first available channel atomically', () => {
    const state = simulationReducer(createInitialState(), {
      type: 'select-guild',
      guildId: 'sandbox',
    });
    expect(state.guildId).toBe('sandbox');
    expect(state.channelId).toBe('sandbox-general');
    expect(state.surface).toBe('simulator');
  });

  it('records an immediate ping reply and trace when the bot is running', () => {
    const state = simulationReducer(runningState(), { type: 'execute', input: '/ping' });
    const messages = state.messages['bot-testing'] ?? [];
    expect(messages.at(-2)?.content).toBe('/ping');
    expect(messages.at(-1)).toMatchObject({
      content: 'Pong!  ·  123ms',
      responseState: 'immediate',
    });
    expect(state.interaction).toMatchObject({
      command: '/ping',
      outcome: 'Passed',
      durationMs: 123,
    });
  });

  it('models a deferred reply followed by a token-backed follow-up', () => {
    const pending = simulationReducer(runningState(), { type: 'execute', input: '/slow' });
    expect((pending.messages['bot-testing'] ?? []).at(-1)?.responseState).toBe('deferred');
    expect(pending.interaction.outcome).toBe('Deferred');

    const completed = simulationReducer(pending, {
      type: 'complete-deferred',
      executionId: 1,
      channelId: 'bot-testing',
    });
    expect((completed.messages['bot-testing'] ?? []).at(-1)).toMatchObject({
      content: "Here's the result you asked for.",
      responseState: 'follow-up',
    });
    expect(completed.interaction.outcome).toBe('Passed');
  });

  it.each([
    ['/secret', 'ephemeral', 'Payload'],
    ['/permissions', 'denied', 'Permissions'],
    ['/rate-limit', 'rate-limited', 'Rate Limits'],
    ['/resume', 'resumed', 'Trace'],
  ] as const)('maps %s to the expected state and inspector', (command, responseState, tab) => {
    const state = simulationReducer(runningState(), { type: 'execute', input: command });
    expect((state.messages['bot-testing'] ?? []).at(-1)?.responseState).toBe(responseState);
    expect(state.inspectorTab).toBe(tab);
  });

  it('does not dispatch an interaction while the bot is offline', () => {
    const state = simulationReducer(createInitialState(), { type: 'execute', input: '/ping' });
    expect((state.messages['bot-testing'] ?? []).at(-1)?.content).toContain('offline');
    expect(state.interaction.outcome).toBe('Timed out');
  });

  it('retains runtime callbacks as diagnostics without appending channel messages', () => {
    const state = simulationReducer(runningState(), {
      type: 'execute-runtime',
      input: '/ping',
      result: {
        runId: 'run-1',
        requestId: 'request-1',
        context: { actorId: '3000', guildId: '1000', channelId: '2100' },
        ok: true,
        command: 'ping',
        interactionId: '1234567890',
        durationMs: 37,
        response: { type: 'message', data: { content: 'Actual bot response', flags: 64 } },
        error: null,
      },
    });
    expect(state.messages['2100']).toBeUndefined();
    expect(state.interaction.details).toBe('Actual bot response');
    expect(state.interaction).toMatchObject({ interactionId: '1234567890', durationMs: 37 });
    expect(state.inspectorTab).toBe('Payload');
  });

  it('renders sanitized runtime failures as evidence rather than a canned bot reply', () => {
    const state = simulationReducer(runningState(), {
      type: 'runtime-failed',
      request: {
        runId: 'run-1',
        requestId: 'request-2',
        input: '/timeout',
        context: { actorId: '3000', guildId: '1000', channelId: '2100' },
      },
      error: 'Bot interaction timed out after 3000 ms.',
    });
    expect(state.messages['2100']).toBeUndefined();
    expect(state.interaction.details).toBe('Bot interaction timed out after 3000 ms.');
    expect(state.interaction.outcome).toBe('Timed out');
  });
});
