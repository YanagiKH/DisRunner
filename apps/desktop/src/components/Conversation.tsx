import { useMemo, useState } from 'react';
import { Bell, Hash, Pin, Search, SlidersHorizontal, Users, X } from 'lucide-react';
import type { Channel, ChatMessage, CommandSpec } from '../types';
import type { ProjectAction } from '../state/project-workspace';
import { Composer } from './Composer';
import { MessageFeed } from './MessageFeed';

interface ConversationProps {
  readonly channel: Channel;
  readonly messages: readonly ChatMessage[];
  readonly botRunning: boolean;
  readonly invocationBlockReason?: string | undefined;
  readonly onSubmit: (value: string) => void;
  readonly commands?: readonly CommandSpec[] | undefined;
  readonly onAction?: ((action: ProjectAction) => void) | undefined;
  readonly onSaveAttachment?: ((id: string) => void) | undefined;
}

export function Conversation({
  channel,
  messages,
  botRunning,
  onSubmit,
  invocationBlockReason,
  commands,
  onAction,
  onSaveAttachment,
}: ConversationProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filteredMessages = useMemo(
    () =>
      query
        ? messages.filter((message) =>
            `${message.author} ${message.content} ${message.metadata ?? ''}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
        : messages,
    [messages, query],
  );

  return (
    <main className="conversation" aria-label={`Virtual channel ${channel.name}`}>
      <header className="channel-header">
        <Hash size={22} />
        <strong>{channel.name}</strong>
        <span className="channel-description">{channel.description}</span>
        <div className="channel-header-spacer" />
        {searchOpen && (
          <label className="channel-search">
            <Search size={14} />
            <input
              autoFocus
              aria-label="Search current channel"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              value={query}
            />
            <button
              aria-label="Close search"
              onClick={() => {
                setSearchOpen(false);
                setQuery('');
              }}
              type="button"
            >
              <X size={13} />
            </button>
          </label>
        )}
        <button aria-label="Channel notification settings unavailable" disabled type="button">
          <Bell size={18} />
        </button>
        <button aria-label="Pinned virtual messages unavailable" disabled type="button">
          <Pin size={18} />
        </button>
        <button
          aria-label="Search channel"
          className={searchOpen ? 'active' : ''}
          onClick={() => setSearchOpen((value) => !value)}
          type="button"
        >
          <Search size={19} />
        </button>
        <button aria-label="Show virtual members unavailable" disabled type="button">
          <Users size={19} />
        </button>
        <button aria-label="Channel filters unavailable" disabled type="button">
          <SlidersHorizontal size={18} />
        </button>
      </header>
      <MessageFeed
        channelName={channel.name}
        messages={filteredMessages}
        onAction={botRunning ? onAction : undefined}
        onSaveAttachment={botRunning ? onSaveAttachment : undefined}
      />
      {query && (
        <div className="search-result-count">{filteredMessages.length} matching events</div>
      )}
      <Composer
        botRunning={botRunning}
        channelName={channel.name}
        onSubmit={onSubmit}
        invocationBlockReason={invocationBlockReason}
        commands={commands}
      />
    </main>
  );
}
