import type { ChatMessage, CommandSpec, Guild, InspectorTab, InteractionTrace } from './types';

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  'Trace',
  'Payload',
  'State Diff',
  'Permissions',
  'Rate Limits',
  'Risks',
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: '/ping',
    description: 'Immediate interaction reply',
    response: 'Pong! · 123ms',
    shortcut: 'Immediate',
    color: '#42D392',
  },
  {
    name: '/slow',
    description: 'Deferred acknowledgment and follow-up',
    response: 'Working… then a follow-up result',
    shortcut: 'Deferred',
    color: '#F4B860',
  },
  {
    name: '/secret',
    description: 'Visible only to the invoking user',
    response: 'Only you can see this.',
    shortcut: 'Ephemeral',
    color: '#6677F4',
  },
  {
    name: '/permissions',
    description: 'Evaluate role and channel overwrites',
    response: 'Missing Manage Messages',
    shortcut: '403',
    color: '#F06470',
  },
  {
    name: '/rate-limit',
    description: 'Exhaust a local REST bucket',
    response: '429 · retry after 1.25 seconds',
    shortcut: '429',
    color: '#F4B860',
  },
  {
    name: '/resume',
    description: 'Simulate a Gateway disconnect and resume',
    response: 'Session replayed from sequence 482',
    shortcut: 'Gateway',
    color: '#42D392',
  },
];

export const GUILDS: readonly Guild[] = [
  {
    id: 'foundation',
    name: 'Foundation Lab',
    accent: '#6677F4',
    mark: 'F',
    groups: [
      {
        id: 'getting-started',
        name: 'Getting Started',
        channels: [
          {
            id: 'rules',
            name: 'rules',
            description: 'Fixture rules and simulator notes.',
            locked: true,
          },
          { id: 'info', name: 'info', description: 'Project information and runtime health.' },
        ],
      },
      {
        id: 'development',
        name: 'Development',
        channels: [
          { id: 'general', name: 'general', description: 'General bot development conversation.' },
          {
            id: 'bot-testing',
            name: 'bot-testing',
            description: 'Test slash commands and interactions.',
          },
          {
            id: 'commands',
            name: 'commands',
            description: 'Registered application command fixtures.',
          },
        ],
      },
      {
        id: 'events',
        name: 'Events',
        channels: [
          {
            id: 'interactions',
            name: 'interactions',
            description: 'Raw interaction event stream.',
          },
          {
            id: 'messages',
            name: 'messages',
            description: 'Message create, update, and delete events.',
          },
          { id: 'voice', name: 'voice', description: 'Virtual voice-state events.' },
        ],
      },
      {
        id: 'logs',
        name: 'Logs',
        channels: [
          {
            id: 'audit',
            name: 'audit',
            description: 'Mutation and permission audit entries.',
            locked: true,
          },
          {
            id: 'errors',
            name: 'errors',
            description: 'Simulator errors and stack traces.',
            locked: true,
          },
        ],
      },
    ],
    members: [
      {
        id: 'testbot',
        name: 'TestBot',
        role: 'bot',
        status: 'online',
        color: '#6677F4',
        detail: 'Application bot',
      },
      {
        id: 'dev',
        name: 'DevUser',
        role: 'developer',
        status: 'online',
        color: '#6677F4',
        detail: 'Invoking as developer',
      },
      {
        id: 'qa',
        name: 'QAOperator',
        role: 'operator',
        status: 'online',
        color: '#9DB7F6',
        detail: 'Scenario runner',
      },
      {
        id: 'mod',
        name: 'ModUser',
        role: 'moderator',
        status: 'online',
        color: '#F4B860',
        detail: 'Manage Messages',
      },
      { id: 'legacy', name: 'LegacyUser', role: 'member', status: 'offline', color: '#758092' },
      { id: 'guest', name: 'GuestUser', role: 'member', status: 'offline', color: '#758092' },
    ],
  },
  {
    id: 'sandbox',
    name: 'Sandbox Arena',
    accent: '#42D392',
    mark: 'S',
    groups: [
      {
        id: 'sandbox-channels',
        name: 'Sandbox',
        channels: [
          {
            id: 'sandbox-general',
            name: 'general',
            description: 'An isolated guild for free-form simulation.',
          },
          {
            id: 'sandbox-bot-testing',
            name: 'bot-testing',
            description: 'Run commands against the sandbox fixture.',
          },
          { id: 'chaos', name: 'chaos', description: 'Fault injection and malformed event cases.' },
        ],
      },
    ],
    members: [
      { id: 'testbot', name: 'TestBot', role: 'bot', status: 'online', color: '#6677F4' },
      { id: 'dev', name: 'DevUser', role: 'developer', status: 'online', color: '#42D392' },
      { id: 'chaos', name: 'ChaosAgent', role: 'operator', status: 'online', color: '#F06470' },
    ],
  },
  {
    id: 'qa-hub',
    name: 'QA Hub',
    accent: '#9DB7F6',
    mark: 'Q',
    groups: [
      {
        id: 'qa-channels',
        name: 'Verification',
        channels: [
          {
            id: 'regression',
            name: 'regression',
            description: 'Deterministic regression scenarios.',
          },
          {
            id: 'release-checks',
            name: 'release-checks',
            description: 'Release-gate runs and evidence.',
          },
        ],
      },
    ],
    members: [
      { id: 'testbot', name: 'TestBot', role: 'bot', status: 'online', color: '#6677F4' },
      { id: 'qa', name: 'QAOperator', role: 'operator', status: 'online', color: '#9DB7F6' },
      { id: 'release', name: 'ReleaseBot', role: 'bot', status: 'offline', color: '#758092' },
    ],
  },
];

const testMessages: readonly ChatMessage[] = [
  {
    id: 'seed-command-ping',
    author: 'DevUser',
    authorRole: 'developer',
    content: '/ping',
    time: 'Today at 12:34:01',
    command: '/ping',
    metadata: 'Application Command  ·  id: 8f3a1c2d',
  },
  {
    id: 'seed-reply-ping',
    author: 'TestBot',
    authorRole: 'bot',
    content: 'Pong!  ·  123ms',
    time: 'Today at 12:34:01',
    responseState: 'immediate',
    metadata: 'Message (reply)  ·  id: a1b2c3d4',
    parentId: 'seed-command-ping',
  },
  {
    id: 'seed-command-slow',
    author: 'DevUser',
    authorRole: 'developer',
    content: '/slow',
    time: 'Today at 12:34:10',
    command: '/slow',
    metadata: 'Application Command  ·  id: 9e7b6c5d',
  },
  {
    id: 'seed-deferred',
    author: 'TestBot',
    authorRole: 'bot',
    content: 'Working on that…',
    time: 'Today at 12:34:10',
    responseState: 'deferred',
    metadata: 'Deferred Acknowledge  ·  id: def456aa',
    parentId: 'seed-command-slow',
  },
  {
    id: 'seed-follow-up',
    author: 'TestBot',
    authorRole: 'bot',
    content: "Here's the result you asked for.",
    time: 'Today at 12:34:11',
    responseState: 'follow-up',
    metadata: 'Follow-up Message  ·  id: fff111bb',
    parentId: 'seed-deferred',
  },
  {
    id: 'seed-command-secret',
    author: 'DevUser',
    authorRole: 'developer',
    content: '/secret',
    time: 'Today at 12:34:20',
    command: '/secret',
    metadata: 'Application Command  ·  id: c0ffee42',
  },
  {
    id: 'seed-secret',
    author: 'TestBot',
    authorRole: 'bot',
    content: 'Only you can see this.',
    time: 'Today at 12:34:20',
    responseState: 'ephemeral',
    metadata: 'Ephemeral Response  ·  id: eph99aa',
    parentId: 'seed-command-secret',
  },
];

const channelMessage = (channel: string): readonly ChatMessage[] => [
  {
    id: `welcome-${channel}`,
    author: 'DisRunner',
    authorRole: 'bot',
    content: `Virtual channel #${channel} is ready with seeded local fixture data.`,
    time: 'Today at 12:34:00',
    responseState: 'system',
    metadata: 'Local fixture · imported bot egress is not sandboxed',
  },
];

export const SEED_MESSAGES: Readonly<Record<string, readonly ChatMessage[]>> = Object.fromEntries(
  GUILDS.flatMap((guild) =>
    guild.groups.flatMap((group) =>
      group.channels.map((channel) => [
        channel.id,
        channel.id === 'bot-testing' ? testMessages : channelMessage(channel.name),
      ]),
    ),
  ),
);

export const INITIAL_TRACE: InteractionTrace = {
  id: 'trace-timeout-001',
  command: '/slow',
  user: 'DevUser (1001)',
  channel: '#bot-testing (2002)',
  interactionId: '9e7b6c5d7f8a9b0c',
  createdAt: '12:34:10.123',
  outcome: 'Timed out',
  severity: 'high',
  durationMs: 3420,
  steps: [
    { id: 'receive', label: 'Interaction received', startMs: 0, durationMs: 120, tone: 'success' },
    { id: 'handler', label: 'Handler + database', startMs: 1210, durationMs: 460, tone: 'info' },
    {
      id: 'timeout',
      label: 'Application did not respond',
      startMs: 0,
      durationMs: 3420,
      tone: 'danger',
    },
  ],
  payload: {
    id: '9e7b6c5d7f8a9b0c',
    type: 2,
    guild_id: 'foundation',
    channel_id: 'bot-testing',
    data: { name: 'slow', type: 1 },
    locale: 'en-US',
    token: '[REDACTED]',
  },
  details:
    'The application did not send a final response within 3.000 seconds. A follow-up was sent, but no final response was received.',
  recommendation:
    'Send or defer the initial response within 3 seconds, then complete work with a follow-up.',
};
