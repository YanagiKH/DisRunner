import { describe, expect, it } from 'vitest';

import { ApplicationCommandRegistry } from '../../src/application-command-registry.js';
import { parseCommandRegistryProfile } from '../../src/application-command-profile.js';
import { VirtualClock } from '../../src/clock.js';
import { SnowflakeGenerator } from '../../src/random.js';
import { VirtualState } from '../../src/state.js';

function fixture() {
  const clock = new VirtualClock({ nowMs: 1_420_070_500_000 });
  const state = new VirtualState(clock, new SnowflakeGenerator(clock), [
    { resourceType: 'guild', id: '1000', name: 'Guild' },
  ]);
  const registry = new ApplicationCommandRegistry(state, '4000', {
    profile: 'command-registry-v2',
    guildIds: ['1000'],
  });
  return { state, registry };
}

describe('SDK application command registry profile', () => {
  it('accepts the pinned SDK sync fields and retains typed options and context commands', () => {
    expect(
      parseCommandRegistryProfile({ profile: 'command-registry-v2', guildIds: ['1000'] }),
    ).toEqual({ profile: 'command-registry-v2', guildIds: ['1000'] });
    const { registry } = fixture();
    const result = registry.put('4000', undefined, [
      {
        name: 'search',
        description: 'Search local data',
        nsfw: false,
        dm_permission: true,
        default_member_permissions: null,
        contexts: null,
        integration_types: null,
        name_localizations: {},
        description_localizations: {},
        options: [
          { type: 3, name: 'query', description: 'Query', required: true, autocomplete: true },
          { type: 4, name: 'limit', description: 'Limit', min_value: 1, max_value: 25 },
        ],
      },
      { type: 2, name: 'Inspect user' },
      { type: 3, name: 'Inspect message' },
    ]);
    expect(result).toMatchObject([
      {
        type: 1,
        name: 'search',
        options: [
          { type: 3, name: 'query', required: true, autocomplete: true },
          { type: 4, name: 'limit', min_value: 1, max_value: 25 },
        ],
      },
      { type: 2, name: 'Inspect user', description: '' },
      { type: 3, name: 'Inspect message', description: '' },
    ]);
    expect(registry.list('4000')).toEqual(result);
  });

  it('keeps subcommand groups, choices and omitted PATCH fields; option edits revise the command', () => {
    const { registry } = fixture();
    const command = registry.post('4000', '1000', {
      name: 'admin',
      description: 'Local administration',
      default_member_permissions: '8',
      dm_permission: true,
      contexts: null,
      integration_types: null,
      options: [
        {
          type: 2,
          name: 'member',
          description: 'Member actions',
          options: [
            {
              type: 1,
              name: 'inspect',
              description: 'Inspect a member',
              options: [
                {
                  type: 3,
                  name: 'format',
                  description: 'Output format',
                  required: true,
                  choices: [
                    { name: 'Plain text', value: 'text' },
                    { name: 'JSON', value: 'json' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }).command;
    const changed = registry.patch('4000', '1000', command.id, {
      description: 'Inspect guild data',
    });
    expect(changed['options']).toEqual(command['options']);
    expect(changed['default_member_permissions']).toBe('8');
    expect(changed.version).not.toBe(command.version);
    const options = [{ type: 1, name: 'reset', description: 'Reset local state' }];
    const revised = registry.patch('4000', '1000', command.id, { options });
    expect(revised['options']).toEqual(options);
    expect(revised.version).not.toBe(changed.version);
    expect(registry.patch('4000', '1000', command.id, {}).version).toBe(revised.version);
    options[0]!.name = 'mutated';
    expect(registry.get('4000', '1000', command.id)['options']).toEqual([
      { type: 1, name: 'reset', description: 'Reset local state' },
    ]);
  });

  it.each(
    [
      [
        {
          type: 3,
          name: 'value',
          description: 'Value',
          choices: [{ name: 'One', value: '1' }],
          autocomplete: true,
        },
      ],
      [{ type: 3, name: 'value', description: 'Value', min_length: 10, max_length: 1 }],
      [{ type: 4, name: 'value', description: 'Value', choices: [{ name: 'Half', value: 0.5 }] }],
      [
        {
          type: 1,
          name: 'sub',
          description: 'Sub',
          options: [{ type: 1, name: 'nested', description: 'No' }],
        },
      ],
      [
        { type: 3, name: 'same', description: 'One' },
        { type: 3, name: 'same', description: 'Two' },
      ],
      [
        { type: 3, name: 'optional', description: 'Optional' },
        { type: 3, name: 'required', description: 'Required', required: true },
      ],
      [
        { type: 1, name: 'sub', description: 'Sub' },
        { type: 3, name: 'value', description: 'Value' },
      ],
      [
        {
          type: 2,
          name: 'group',
          description: 'Group',
          options: [{ type: 3, name: 'value', description: 'Value' }],
        },
      ],
      [{ type: 7, name: 'channel', description: 'Channel', channel_types: [999] }],
    ].map((options) => ({ options })),
  )('rejects an invalid option tree atomically: $options', ({ options }) => {
    const { state, registry } = fixture();
    registry.post('4000', undefined, { name: 'ping', description: 'Ping' });
    const before = state.snapshot();
    expect(() =>
      registry.put('4000', undefined, [{ name: 'bad', description: 'Bad', options }]),
    ).toThrow();
    expect(state.snapshot()).toEqual(before);
  });

  it('does not expand the v1 profile or accept unknown fields and user-installation scope', () => {
    const { state, registry } = fixture();
    for (const extra of [
      { unsupported: true },
      { integration_types: [1] },
      { nsfw: 'false' },
      { type: null },
      { nsfw: null },
      { options: null },
    ]) {
      expect(() =>
        registry.post('4000', undefined, { name: 'ping', description: 'Ping', ...extra }),
      ).toThrow();
    }
    const legacy = new ApplicationCommandRegistry(state, '4000', {
      profile: 'command-registry-v1',
      guildIds: ['1000'],
    });
    expect(() =>
      legacy.post('4000', undefined, {
        name: 'echo',
        description: 'Echo',
        options: [{ type: 3, name: 'text', description: 'Text' }],
      }),
    ).toThrow('Unsupported application command feature');
    expect(state.revision).toBe(0);
  });
});
