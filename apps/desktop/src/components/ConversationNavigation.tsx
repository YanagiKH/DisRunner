import type { Guild } from '../types';

interface ConversationNavigationProps {
  readonly guilds: readonly Guild[];
  readonly selectedGuild: Guild;
  readonly selectedChannelId: string;
  readonly onSelect: (guildId: string, channelId: string) => void;
}

const conversationKey = (guildId: string, channelId: string) =>
  JSON.stringify([guildId, channelId]);

export function ConversationNavigation({
  guilds,
  selectedGuild,
  selectedChannelId,
  onSelect,
}: ConversationNavigationProps) {
  const conversations = guilds.flatMap((guild) =>
    guild.groups.flatMap((group) =>
      group.channels.map((channel) => ({
        key: conversationKey(guild.id, channel.id),
        guildId: guild.id,
        channelId: channel.id,
      })),
    ),
  );
  const selected = conversationKey(selectedGuild.id, selectedChannelId);
  const hasSelection = conversations.some((item) => item.key === selected);

  return (
    <nav className="conversation-navigation" aria-label="Conversation navigation">
      <label>
        <span>Conversation</span>
        <select
          aria-label="Conversation"
          disabled={conversations.length === 0}
          value={hasSelection ? selected : ''}
          onChange={(event) => {
            const next = conversations.find((item) => item.key === event.target.value);
            if (next) onSelect(next.guildId, next.channelId);
          }}
        >
          {!hasSelection && <option value="">No conversation selected</option>}
          {guilds.map((guild) => (
            <optgroup key={guild.id} label={guild.name}>
              {guild.groups.flatMap((group) =>
                group.channels.map((channel) => (
                  <option
                    data-channel-id={channel.id}
                    key={channel.id}
                    value={conversationKey(guild.id, channel.id)}
                  >
                    {channel.name}
                  </option>
                )),
              )}
            </optgroup>
          ))}
        </select>
      </label>
    </nav>
  );
}
