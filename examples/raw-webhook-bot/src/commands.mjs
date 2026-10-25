export const LOCAL_COMMANDS = [
  { name: 'ping', description: 'Check the Bot connection.' },
  { name: 'secret', description: 'Show a private response.' },
  {
    name: 'echo',
    description: 'Repeat some text.',
    options: [{ name: 'text', description: 'Text to repeat.', type: 3, required: true }],
  },
  { name: 'slow', description: 'Complete a deferred response.' },
  { name: 'defer', description: 'Edit a deferred response.' },
  { name: 'followup', description: 'Send an additional response.' },
  { name: 'controls', description: 'Show buttons and a select menu.' },
  { name: 'modal', description: 'Open a text input dialog.' },
  { name: 'attachment', description: 'Send a local text attachment.' },
  {
    name: 'search',
    description: 'Search local choices.',
    options: [{ name: 'query', description: 'Search text.', type: 3, autocomplete: true }],
  },
  {
    name: 'tools',
    description: 'Local development tools.',
    options: [
      {
        type: 2,
        name: 'math',
        description: 'Arithmetic.',
        options: [
          {
            type: 1,
            name: 'add',
            description: 'Add two integers.',
            options: [
              { type: 4, name: 'left', description: 'Left number.', required: true },
              { type: 4, name: 'right', description: 'Right number.', required: true },
            ],
          },
        ],
      },
    ],
  },
  { name: 'Inspect user', type: 2 },
  { name: 'Inspect message', type: 3 },
];

export function interactionReply(interaction) {
  const data = interaction.data ?? {};
  if (interaction.type === 4) {
    const focused = flattenOptions(data.options).find((option) => option.focused);
    const query = typeof focused?.value === 'string' ? focused.value : '';
    return {
      callback: {
        type: 8,
        data: {
          choices: ['apple', 'banana', 'cherry']
            .filter((choice) => choice.startsWith(query))
            .map((choice) => ({ name: choice, value: choice })),
        },
      },
    };
  }
  if (interaction.type === 3) {
    if (data.custom_id === 'open-debug-modal')
      return { callback: modal('debug-modal', 'summary', 'Summary', 'Reproduce a failure') };
    if (data.custom_id === 'confirm')
      return { callback: { type: 7, data: { content: 'Button clicked.', components: [] } } };
    if (data.custom_id === 'choice')
      return { callback: message(`Selected: ${(data.values ?? []).join(', ')}`, 64) };
    return { callback: message('Unknown local control.', 64) };
  }
  if (interaction.type === 5) {
    const fieldId = data.custom_id === 'debug-modal' ? 'summary' : 'answer';
    const fields = Array.isArray(data.components)
      ? data.components.flatMap((row) => (Array.isArray(row.components) ? row.components : []))
      : [];
    const answer = fields.find((field) => field.custom_id === fieldId)?.value ?? '';
    return { callback: message(`Submitted: ${String(answer)}`) };
  }
  if (data.type === 2) {
    const user = data.resolved?.users?.[data.target_id];
    return { callback: message(`User: ${user?.username ?? 'Unknown user'}`) };
  }
  if (data.type === 3) {
    const target = data.resolved?.messages?.[data.target_id];
    return { callback: message(`Message: ${target?.content ?? ''}`) };
  }
  switch (data.name) {
    case 'ping':
      return { callback: message('Pong! Offline and deterministic.') };
    case 'secret':
      return { callback: message('Only you can see this.', 64) };
    case 'echo':
      return {
        callback: message(
          String(
            flattenOptions(data.options).find((option) => option.name === 'text')?.value ?? '',
          ),
        ),
      };
    case 'slow':
    case 'defer':
      return { callback: { type: 5, data: { flags: 64 } }, afterAck: 'edit-original' };
    case 'followup':
      return { callback: message('First reply.'), afterAck: 'followup' };
    case 'attachment':
      return { callback: { type: 5 }, afterAck: 'attachment' };
    case 'controls':
      return {
        callback: {
          type: 4,
          data: {
            content: 'Choose a control.',
            components: [
              {
                type: 1,
                components: [{ type: 2, custom_id: 'confirm', label: 'Confirm', style: 1 }],
              },
              {
                type: 1,
                components: [
                  {
                    type: 3,
                    custom_id: 'choice',
                    min_values: 1,
                    max_values: 1,
                    options: [
                      { label: 'Apple', value: 'apple' },
                      { label: 'Banana', value: 'banana' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      };
    case 'modal':
      return { callback: modal('feedback', 'answer', 'Answer', 'Feedback') };
    case 'tools': {
      const options = flattenOptions(data.options);
      const left = options.find((option) => option.name === 'left')?.value;
      const right = options.find((option) => option.name === 'right')?.value;
      return { callback: message(`Sum: ${Number(left) + Number(right)}`) };
    }
    default:
      return { callback: message(`Unknown local command: ${String(data.name ?? 'interaction')}`) };
  }
}

function message(content, flags = 0) {
  return { type: 4, data: { content, ...(flags === 0 ? {} : { flags }) } };
}
function modal(customId, fieldId, label, title) {
  return {
    type: 9,
    data: {
      custom_id: customId,
      title,
      components: [
        { type: 1, components: [{ type: 4, custom_id: fieldId, label, style: 2, required: true }] },
      ],
    },
  };
}
function flattenOptions(options, depth = 0) {
  if (!Array.isArray(options) || depth > 4) return [];
  return options.flatMap((option) =>
    option !== null && typeof option === 'object'
      ? [option, ...flattenOptions(option.options, depth + 1)]
      : [],
  );
}
