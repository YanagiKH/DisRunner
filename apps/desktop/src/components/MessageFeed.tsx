import { useEffect, useRef } from 'react';
import {
  Bot,
  Clock3,
  Eye,
  Gauge,
  KeyRound,
  Link2,
  RadioTower,
  ShieldX,
  UserRound,
} from 'lucide-react';
import type { ChatMessage, ResponseState } from '../types';

interface MessageFeedProps {
  readonly messages: readonly ChatMessage[];
  readonly channelName: string;
}

const STATE_LABELS: Readonly<Partial<Record<ResponseState, string>>> = {
  immediate: 'Immediate',
  deferred: 'Deferred',
  'follow-up': 'Follow-up',
  ephemeral: 'Ephemeral',
  timeout: 'Timed out',
  denied: 'Denied',
  'rate-limited': 'Rate limited',
  resumed: 'Resumed',
  system: 'Local only',
};

function StateGlyph({ state }: { readonly state: ResponseState }) {
  switch (state) {
    case 'deferred':
    case 'timeout':
      return <Clock3 size={12} />;
    case 'follow-up':
      return <Link2 size={12} />;
    case 'ephemeral':
      return <Eye size={12} />;
    case 'denied':
      return <ShieldX size={12} />;
    case 'rate-limited':
      return <Gauge size={12} />;
    case 'resumed':
      return <RadioTower size={12} />;
    case 'system':
      return <KeyRound size={12} />;
    case 'immediate':
      return <Link2 size={12} />;
  }
}

export function MessageFeed({ messages, channelName }: MessageFeedProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="message-feed" aria-label={`Messages in ${channelName}`} role="log">
      {messages.map((message, index) => {
        const prior = messages[index - 1];
        const chained = Boolean(message.parentId && prior && message.parentId === prior.id);
        return (
          <article
            className={`chat-message ${chained ? 'chained' : ''} ${message.responseState === 'ephemeral' ? 'ephemeral' : ''}`}
            data-message-id={message.id}
            key={message.id}
          >
            {chained && <span className="reply-connector" aria-hidden="true" />}
            <div className={`chat-avatar ${message.authorRole}`}>
              {message.authorRole === 'bot' ? <Bot size={19} /> : <UserRound size={19} />}
            </div>
            <div className="chat-body">
              <div className="chat-meta-row">
                <strong>{message.author}</strong>
                {message.authorRole === 'bot' && message.author === 'TestBot' && (
                  <span className="bot-label">BOT</span>
                )}
                <time>{message.time}</time>
                {message.responseState && STATE_LABELS[message.responseState] && (
                  <span className={`response-badge ${message.responseState}`}>
                    <StateGlyph state={message.responseState} />
                    {STATE_LABELS[message.responseState]}
                  </span>
                )}
              </div>
              <div className={`message-content ${message.command ? 'command' : ''}`}>
                {message.content}
              </div>
              {message.metadata && <div className="message-metadata">{message.metadata}</div>}
            </div>
          </article>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
