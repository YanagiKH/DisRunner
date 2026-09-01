import { GUILDS, INITIAL_TRACE, SEED_MESSAGES } from '../data';
import type { BotStatus, ChatMessage, InspectorTab, InteractionTrace, Surface } from '../types';

export interface SimulatorState {
  readonly surface: Surface;
  readonly guildId: string;
  readonly channelId: string;
  readonly botStatus: BotStatus;
  readonly inspectorTab: InspectorTab;
  readonly messages: Readonly<Record<string, readonly ChatMessage[]>>;
  readonly interaction: InteractionTrace;
  readonly executionCount: number;
  readonly toast: string | null;
}

export type SimulatorAction =
  | { readonly type: 'navigate'; readonly surface: Surface }
  | { readonly type: 'select-guild'; readonly guildId: string }
  | { readonly type: 'select-channel'; readonly channelId: string }
  | { readonly type: 'set-bot'; readonly status: BotStatus }
  | { readonly type: 'select-inspector-tab'; readonly tab: InspectorTab }
  | { readonly type: 'execute'; readonly input: string }
  | {
      readonly type: 'execute-runtime';
      readonly input: string;
      readonly result: DisRunnerInvocationResult;
    }
  | { readonly type: 'complete-deferred'; readonly executionId: number; readonly channelId: string }
  | { readonly type: 'dismiss-toast' };

function firstChannelId(guildId: string): string {
  const guild = GUILDS.find((candidate) => candidate.id === guildId) ?? GUILDS[0];
  return guild?.groups[0]?.channels[0]?.id ?? 'bot-testing';
}

function cloneSeedMessages(): Readonly<Record<string, readonly ChatMessage[]>> {
  return Object.fromEntries(
    Object.entries(SEED_MESSAGES).map(([channelId, messages]) => [
      channelId,
      messages.map((message) => ({ ...message })),
    ]),
  );
}

export function createInitialState(): SimulatorState {
  return {
    surface: 'simulator',
    guildId: 'foundation',
    channelId: 'bot-testing',
    botStatus: 'stopped',
    inspectorTab: 'Trace',
    messages: cloneSeedMessages(),
    interaction: INITIAL_TRACE,
    executionCount: 0,
    toast: null,
  };
}

function timeFor(executionId: number, secondsOffset = 0): string {
  const seconds = 30 + executionId + secondsOffset;
  return `Today at 12:34:${String(seconds).padStart(2, '0')}`;
}

function traceFor(command: string, executionId: number, channelId: string): InteractionTrace {
  const base = {
    id: `trace-${executionId}`,
    command,
    user: 'DevUser (1001)',
    channel: `#${channelId} (2002)`,
    interactionId: `local-${String(executionId).padStart(8, '0')}`,
    createdAt: `12:34:${String(30 + executionId).padStart(2, '0')}.000`,
    payload: {
      id: `local-${String(executionId).padStart(8, '0')}`,
      type: 2,
      guild_id: 'local-guild',
      channel_id: channelId,
      data: { name: command.slice(1), type: 1 },
      token: '[REDACTED]',
    },
  } as const;

  switch (command) {
    case '/slow':
      return {
        ...base,
        outcome: 'Deferred',
        severity: 'medium',
        durationMs: 1410,
        steps: [
          {
            id: 'receive',
            label: 'Interaction received',
            startMs: 0,
            durationMs: 95,
            tone: 'success',
          },
          { id: 'work', label: 'Deferred work', startMs: 180, durationMs: 1230, tone: 'warning' },
        ],
        details:
          'The interaction was acknowledged with a deferred response. A local follow-up is pending.',
        recommendation: 'Keep follow-up work within the 15-minute interaction token lifetime.',
      };
    case '/permissions':
      return {
        ...base,
        outcome: 'Denied',
        severity: 'medium',
        durationMs: 84,
        steps: [
          {
            id: 'receive',
            label: 'Interaction received',
            startMs: 0,
            durationMs: 22,
            tone: 'success',
          },
          {
            id: 'permission',
            label: 'Permission evaluation',
            startMs: 24,
            durationMs: 60,
            tone: 'danger',
          },
        ],
        details: 'The channel overwrite denies Manage Messages for TestBot.',
        recommendation: 'Grant Manage Messages to the bot role or remove the channel-level deny.',
      };
    case '/rate-limit':
      return {
        ...base,
        outcome: 'Rate limited',
        severity: 'medium',
        durationMs: 1250,
        steps: [
          {
            id: 'receive',
            label: 'Interaction received',
            startMs: 0,
            durationMs: 70,
            tone: 'success',
          },
          {
            id: 'bucket',
            label: 'REST bucket cooldown',
            startMs: 72,
            durationMs: 1178,
            tone: 'warning',
          },
        ],
        details: 'Bucket msg:create:bot-testing reached 0 remaining requests.',
        recommendation:
          'Read Retry-After dynamically and resume the queued request after 1.25 seconds.',
      };
    case '/resume':
      return {
        ...base,
        outcome: 'Resumed',
        severity: 'none',
        durationMs: 420,
        steps: [
          {
            id: 'disconnect',
            label: 'Gateway disconnect',
            startMs: 0,
            durationMs: 80,
            tone: 'warning',
          },
          {
            id: 'resume',
            label: 'Session resumed · seq 482',
            startMs: 92,
            durationMs: 328,
            tone: 'success',
          },
        ],
        details: 'The Gateway session resumed and replayed three missed events in sequence.',
        recommendation: 'No action required. Resume handling completed successfully.',
      };
    default:
      return {
        ...base,
        outcome: 'Passed',
        severity: 'none',
        durationMs: command === '/secret' ? 146 : 123,
        steps: [
          {
            id: 'receive',
            label: 'Interaction received',
            startMs: 0,
            durationMs: 42,
            tone: 'success',
          },
          {
            id: 'response',
            label: command === '/secret' ? 'Ephemeral response' : 'Immediate response',
            startMs: 44,
            durationMs: 79,
            tone: 'success',
          },
        ],
        details:
          command === '/secret'
            ? 'The response is visible only to DevUser.'
            : 'The command replied before the initial response deadline.',
        recommendation: 'No action required.',
      };
  }
}

interface SimulatedResponse {
  readonly content: string;
  readonly responseState: NonNullable<ChatMessage['responseState']>;
  readonly metadata: string;
}

function responseFor(command: string): SimulatedResponse {
  switch (command) {
    case '/ping':
      return {
        content: 'Pong!  ·  123ms',
        responseState: 'immediate',
        metadata: 'Message (reply) · 123ms',
      };
    case '/slow':
      return {
        content: 'Working on that…',
        responseState: 'deferred',
        metadata: 'Deferred Acknowledge · follow-up pending',
      };
    case '/secret':
      return {
        content: 'Only you can see this.',
        responseState: 'ephemeral',
        metadata: 'Ephemeral Response · visible only to DevUser',
      };
    case '/permissions':
      return {
        content: 'I cannot do that here — Manage Messages is denied.',
        responseState: 'denied',
        metadata: 'REST 403 · Missing Permissions',
      };
    case '/rate-limit':
      return {
        content: 'Request queued. Retrying after 1.25 seconds.',
        responseState: 'rate-limited',
        metadata: 'REST 429 · bucket msg:create:bot-testing',
      };
    case '/resume':
      return {
        content: 'Gateway session resumed from sequence 482.',
        responseState: 'resumed',
        metadata: 'RESUMED · 3 events replayed',
      };
    default:
      return {
        content: `Unknown local command: ${command}`,
        responseState: 'system',
        metadata: 'No matching command fixture',
      };
  }
}

function execute(state: SimulatorState, rawInput: string): SimulatorState {
  const input = rawInput.trim();
  if (!input) return state;
  const executionId = state.executionCount + 1;
  const existing = state.messages[state.channelId] ?? [];

  if (state.botStatus === 'stopped') {
    const offlineMessage: ChatMessage = {
      id: `offline-${executionId}`,
      author: 'DisRunner',
      authorRole: 'bot',
      content: 'TestBot is offline. Start the bot before invoking a command.',
      time: timeFor(executionId),
      responseState: 'system',
      metadata: 'No event was dispatched',
    };
    return {
      ...state,
      messages: { ...state.messages, [state.channelId]: [...existing, offlineMessage] },
      executionCount: executionId,
      toast: 'Bot is offline',
    };
  }

  const command = input.startsWith('/') ? (input.split(/\s+/u)[0] ?? input) : input;
  const commandMessage: ChatMessage = {
    id: `cmd-${executionId}`,
    author: 'DevUser',
    authorRole: 'developer',
    content: input,
    command,
    time: timeFor(executionId),
    metadata: `Application Command · id: local-${String(executionId).padStart(8, '0')}`,
  };
  const reply = responseFor(command);
  const replyMessage: ChatMessage = {
    id: `bot-${executionId}`,
    author: command.startsWith('/') ? 'TestBot' : 'DisRunner',
    authorRole: 'bot',
    content: reply.content,
    responseState: reply.responseState,
    metadata: reply.metadata,
    time: timeFor(executionId),
    parentId: commandMessage.id,
  };
  const nextTrace = traceFor(command, executionId, state.channelId);
  const nextTab: InspectorTab =
    command === '/permissions'
      ? 'Permissions'
      : command === '/rate-limit'
        ? 'Rate Limits'
        : command === '/secret'
          ? 'Payload'
          : 'Trace';
  return {
    ...state,
    messages: { ...state.messages, [state.channelId]: [...existing, commandMessage, replyMessage] },
    interaction: nextTrace,
    inspectorTab: nextTab,
    executionCount: executionId,
    toast: `${command} simulated locally`,
  };
}

function executeRuntime(
  state: SimulatorState,
  rawInput: string,
  result: DisRunnerInvocationResult,
): SimulatorState {
  const input = rawInput.trim();
  if (!input) return state;
  const executionId = state.executionCount + 1;
  const existing = state.messages[state.channelId] ?? [];
  const command = `/${result.command}`;
  const commandMessage: ChatMessage = {
    id: `runtime-cmd-${executionId}`,
    author: 'DevUser',
    authorRole: 'developer',
    content: input,
    command,
    time: timeFor(executionId),
    metadata: `Real local interaction · ${result.interactionId ?? 'not dispatched'}`,
  };
  const callbackContent = result.response?.data['content'];
  const responseType = result.response?.type;
  const callbackFlags = result.response?.data['flags'];
  const ephemeral = typeof callbackFlags === 'number' && (callbackFlags & 64) === 64;
  const content = result.ok
    ? typeof callbackContent === 'string'
      ? callbackContent
      : responseType === 'defer' || responseType === 'defer-update'
        ? 'The bot deferred this interaction.'
        : `The bot returned a ${responseType ?? 'callback'} response.`
    : (result.error ?? 'The local bot interaction failed.');
  const responseState: NonNullable<ChatMessage['responseState']> = result.ok
    ? ephemeral
      ? 'ephemeral'
      : responseType === 'defer' || responseType === 'defer-update'
        ? 'deferred'
        : 'immediate'
    : /timed out/iu.test(content)
      ? 'timeout'
      : 'system';
  const replyMessage: ChatMessage = {
    id: `runtime-bot-${executionId}`,
    author: 'TestBot',
    authorRole: 'bot',
    content,
    responseState,
    metadata: result.ok
      ? `Signed local callback · ${ephemeral ? 'ephemeral · ' : ''}${responseType ?? 'unknown'} · ${result.durationMs}ms`
      : `Local invocation rejected · ${result.durationMs}ms`,
    time: timeFor(executionId),
    parentId: commandMessage.id,
  };
  const baseTrace = traceFor(command, executionId, state.channelId);
  const interaction: InteractionTrace = {
    ...baseTrace,
    id: result.interactionId ?? baseTrace.id,
    interactionId: result.interactionId ?? 'not-dispatched',
    outcome: result.ok
      ? responseState === 'deferred'
        ? 'Deferred'
        : 'Passed'
      : responseState === 'timeout'
        ? 'Timed out'
        : 'Denied',
    severity: result.ok ? 'none' : responseState === 'timeout' ? 'high' : 'medium',
    durationMs: result.durationMs,
    payload: { command, callbackType: responseType ?? null, signed: true },
    details: content,
    recommendation: result.ok
      ? 'Response came from the active local bot process.'
      : 'Inspect the runtime output and trace evidence.',
  };
  return {
    ...state,
    messages: { ...state.messages, [state.channelId]: [...existing, commandMessage, replyMessage] },
    interaction,
    inspectorTab: ephemeral ? 'Payload' : 'Trace',
    executionCount: executionId,
    toast: result.ok ? `${command} returned by local bot` : `${command} failed locally`,
  };
}

function completeDeferred(
  state: SimulatorState,
  executionId: number,
  channelId: string,
): SimulatorState {
  const existing = state.messages[channelId] ?? [];
  if (!existing.some((message) => message.id === `bot-${executionId}`)) return state;
  if (existing.some((message) => message.id === `followup-${executionId}`)) return state;
  const followUp: ChatMessage = {
    id: `followup-${executionId}`,
    author: 'TestBot',
    authorRole: 'bot',
    content: "Here's the result you asked for.",
    time: timeFor(executionId, 1),
    responseState: 'follow-up',
    metadata: 'Follow-up Message · token valid for 14m 58s',
    parentId: `bot-${executionId}`,
  };
  const interaction =
    state.interaction.id === `trace-${executionId}`
      ? {
          ...state.interaction,
          outcome: 'Passed' as const,
          severity: 'none' as const,
          durationMs: 1410,
          details: 'The interaction was deferred in time and completed with a follow-up response.',
          recommendation: 'No action required.',
        }
      : state.interaction;
  return {
    ...state,
    messages: { ...state.messages, [channelId]: [...existing, followUp] },
    interaction,
    toast: 'Deferred follow-up completed',
  };
}

export function simulationReducer(state: SimulatorState, action: SimulatorAction): SimulatorState {
  switch (action.type) {
    case 'navigate':
      return { ...state, surface: action.surface, toast: null };
    case 'select-guild':
      return {
        ...state,
        guildId: action.guildId,
        channelId: firstChannelId(action.guildId),
        surface: 'simulator',
        toast: null,
      };
    case 'select-channel':
      return { ...state, channelId: action.channelId, surface: 'simulator', toast: null };
    case 'set-bot':
      return {
        ...state,
        botStatus: action.status,
        toast: action.status === 'running' ? 'TestBot started locally' : 'TestBot stopped',
      };
    case 'select-inspector-tab':
      return { ...state, inspectorTab: action.tab };
    case 'execute':
      return execute(state, action.input);
    case 'execute-runtime':
      return executeRuntime(state, action.input, action.result);
    case 'complete-deferred':
      return completeDeferred(state, action.executionId, action.channelId);
    case 'dismiss-toast':
      return { ...state, toast: null };
  }
}
