import { describe, expect, it } from 'vitest';

import { filterGatewayEvent, GatewayIntents, runScenario } from '../../src/index.js';

// Unknown channels remain legacy unclassified messages. This slice does not validate
// channel/guild authority or infer a guild from names, channel types, or other resources.
describe('scenario send-message channel context', () => {
  it('retains known guild context in state and filters the single dispatched event', async () => {
    const result = await runScenario({
      name: 'guild-message',
      initialState: [{ resourceType: 'channel', id: 'channel', guild_id: 'guild' }],
      steps: [
        { type: 'send-message', channelId: 'channel', authorId: 'human', content: 'private text' },
      ],
    });
    expect(result.report.passed).toBe(true);
    const messages = result.finalState.resources.filter((r) => r.resourceType === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      guild_id: 'guild',
      channel_id: 'channel',
      content: 'private text',
      author: { id: 'human' },
    });
    expect(result.events.map((event) => event.t)).toEqual(['READY', 'MESSAGE_CREATE']);
    expect(result.events[1]?.d).toMatchObject({
      id: messages[0]?.id,
      guild_id: 'guild',
      channel_id: 'channel',
      content: '',
      embeds: [],
      attachments: [],
      components: [],
      poll: null,
    });
    expect(
      filterGatewayEvent('MESSAGE_CREATE', messages[0], GatewayIntents.DIRECT_MESSAGES).delivered,
    ).toBe(false);
    expect(
      filterGatewayEvent('MESSAGE_CREATE', messages[0], GatewayIntents.GUILD_MESSAGES),
    ).toMatchObject({
      delivered: true,
      strippedMessageContent: true,
    });
  });

  it('resolves the current channel created through an alias, not another guild', async () => {
    const result = await runScenario({
      name: 'current-channel',
      initialState: [{ resourceType: 'channel', id: 'unrelated', guild_id: 'wrong-guild' }],
      steps: [
        {
          type: 'create-resource',
          resourceType: 'channel',
          data: { guild_id: 'old-guild' },
          saveAs: 'target',
        },
        {
          type: 'update-resource',
          resourceType: 'channel',
          id: '$target',
          changes: { guild_id: 'new-guild' },
        },
        { type: 'send-message', channelId: '$target', authorId: 'human', content: 'secret' },
      ],
    });
    expect(result.events.map((event) => event.t)).toEqual(['READY', 'MESSAGE_CREATE']);
    expect(result.events[1]?.d).toMatchObject({ guild_id: 'new-guild', content: '' });
    expect(result.finalState.resources.filter((r) => r.resourceType === 'message')).toEqual([
      expect.objectContaining({ guild_id: 'new-guild', content: 'secret' }),
    ]);
  });

  it.each([1, 3])(
    'keeps known DM channel type %i content and routes it only as a DM',
    async (type) => {
      const result = await runScenario({
        name: 'dm-message',
        initialState: [{ resourceType: 'channel', id: 'dm', type }],
        steps: [{ type: 'send-message', channelId: 'dm', authorId: 'human', content: 'hello' }],
      });
      expect(result.report.passed).toBe(true);
      expect(result.events.map((event) => event.t)).toEqual(['READY', 'MESSAGE_CREATE']);
      const message = result.finalState.resources.find((r) => r.resourceType === 'message');
      expect(message).not.toHaveProperty('guild_id');
      expect(result.events[1]?.d).toMatchObject({
        id: message?.id,
        channel_id: 'dm',
        content: 'hello',
      });
      expect(result.events[1]?.d).not.toHaveProperty('guild_id');
      expect(
        filterGatewayEvent('MESSAGE_CREATE', message, GatewayIntents.GUILD_MESSAGES).delivered,
      ).toBe(false);
      expect(
        filterGatewayEvent('MESSAGE_CREATE', message, GatewayIntents.DIRECT_MESSAGES),
      ).toMatchObject({
        delivered: true,
        strippedMessageContent: false,
      });
    },
  );

  it.each([undefined, null, 42])(
    'does not invent guild context from absent/non-string guild_id %s',
    async (guildId) => {
      const result = await runScenario({
        name: 'unclassified-channel',
        initialState: [
          {
            resourceType: 'channel',
            id: 'channel',
            ...(guildId === undefined ? {} : { guild_id: guildId }),
          },
        ],
        steps: [
          { type: 'send-message', channelId: 'channel', authorId: 'human', content: 'legacy' },
        ],
      });
      expect(result.events.map((event) => event.t)).toEqual(['READY', 'MESSAGE_CREATE']);
      expect(result.events[1]?.d).toMatchObject({ content: 'legacy' });
      expect(result.events[1]?.d).not.toHaveProperty('guild_id');
    },
  );

  it('preserves unknown-channel behavior without borrowing an unrelated guild', async () => {
    const result = await runScenario({
      name: 'unknown-channel',
      initialState: [{ resourceType: 'channel', id: 'other', guild_id: 'guild' }],
      steps: [{ type: 'send-message', channelId: 'unknown', authorId: 'human', content: 'legacy' }],
    });
    expect(result.report.passed).toBe(true);
    expect(result.events.map((event) => event.t)).toEqual(['READY', 'MESSAGE_CREATE']);
    expect(result.events[1]?.d).toMatchObject({ channel_id: 'unknown', content: 'legacy' });
    expect(result.events[1]?.d).not.toHaveProperty('guild_id');
  });
});
