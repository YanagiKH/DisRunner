import { useEffect, useRef, useState } from 'react';
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
import type { ProjectAction } from '../state/project-workspace';

interface MessageFeedProps {
  readonly messages: readonly ChatMessage[];
  readonly channelName: string;
  readonly onAction?: ((action: ProjectAction) => void) | undefined;
  readonly onSaveAttachment?: ((id: string) => void) | undefined;
}

function label(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
function MessageText({ content }: { readonly content: string }) {
  return (
    <>
      {content
        .split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*)/gu)
        .map((part, index) =>
          part.startsWith('```') && part.endsWith('```') ? (
            <pre key={index}>
              <code>{part.slice(3, -3)}</code>
            </pre>
          ) : part.startsWith('**') && part.endsWith('**') ? (
            <strong key={index}>{part.slice(2, -2)}</strong>
          ) : part.startsWith('~~') && part.endsWith('~~') ? (
            <s key={index}>{part.slice(2, -2)}</s>
          ) : part.startsWith('`') && part.endsWith('`') ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : part.startsWith('*') && part.endsWith('*') ? (
            <em key={index}>{part.slice(1, -1)}</em>
          ) : (
            part
          ),
        )}
    </>
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function ComponentControl({
  component,
  messageId,
  onAction,
}: {
  readonly component: Readonly<Record<string, unknown>>;
  readonly messageId: string;
  readonly onAction: MessageFeedProps['onAction'];
}) {
  const [values, setValues] = useState<string[]>(() => {
    if (Array.isArray(component['options']))
      return component['options']
        .filter(isRecord)
        .filter((option) => option['default'] === true && typeof option['value'] === 'string')
        .map((option) => option['value'] as string);
    if (Array.isArray(component['default_values']))
      return component['default_values']
        .filter(isRecord)
        .map((option) => label(option['id']))
        .filter(Boolean);
    return [];
  });
  const type = Number(component['type']);
  const customId = typeof component['custom_id'] === 'string' ? component['custom_id'] : '';
  const disabled = component['disabled'] === true || onAction === undefined;
  if (type === 1) {
    const children = Array.isArray(component['components'])
      ? component['components'].filter(isRecord)
      : [];
    return (
      <div className="message-component-row">
        {children.map((child, index) => (
          <ComponentControl
            key={`${String(child['custom_id'] ?? child['url'])}:${index}`}
            component={child}
            messageId={messageId}
            onAction={onAction}
          />
        ))}
      </div>
    );
  }
  if (type === 2) {
    const link = component['style'] === 5;
    return (
      <button
        type="button"
        className={`message-component-button style-${String(component['style'])}`}
        disabled={disabled || link || !customId}
        title={link ? label(component['url']) : undefined}
        onClick={() => onAction?.({ type: 'component', componentType: 2, messageId, customId })}
      >
        {String(
          component['label'] ??
            (isRecord(component['emoji']) ? component['emoji']['name'] : 'Button'),
        )}
        {link ? ' ↗' : ''}
      </button>
    );
  }
  if (![3, 5, 6, 7, 8].includes(type) || !customId) return null;
  const minimum = typeof component['min_values'] === 'number' ? component['min_values'] : 1;
  const maximum = typeof component['max_values'] === 'number' ? component['max_values'] : 1;
  const options = Array.isArray(component['options']) ? component['options'].filter(isRecord) : [];
  return (
    <div className="message-select">
      <label>
        <span>{label(component['placeholder'], 'Choose an option')}</span>
        {type === 3 ? (
          <select
            aria-label={label(component['placeholder'], customId)}
            disabled={disabled}
            multiple={maximum > 1}
            value={maximum > 1 ? values : (values[0] ?? '')}
            onChange={(event) =>
              setValues(
                Array.from(event.currentTarget.selectedOptions)
                  .map((option) => option.value)
                  .filter(Boolean),
              )
            }
          >
            {maximum === 1 && <option value="">Select a value</option>}
            {options.map((option) => (
              <option key={String(option['value'])} value={String(option['value'])}>
                {String(option['label'] ?? option['value'])}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={label(component['placeholder'], customId)}
            disabled={disabled}
            placeholder="Resource IDs, separated by commas"
            value={values.join(',')}
            onChange={(event) =>
              setValues(
                event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
        )}
      </label>
      <button
        type="button"
        disabled={disabled || values.length < minimum || values.length > maximum}
        onClick={() =>
          onAction?.({ type: 'component', componentType: type, messageId, customId, values })
        }
      >
        Select
      </button>
    </div>
  );
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

export function MessageFeed({
  messages,
  channelName,
  onAction,
  onSaveAttachment,
}: MessageFeedProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

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
              {editing === message.id ? (
                <form
                  className="message-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onAction?.({
                      type: 'message-edit',
                      messageId: message.id,
                      content: editContent,
                    });
                    setEditing(null);
                  }}
                >
                  <textarea
                    aria-label="Edit message content"
                    autoFocus
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                    maxLength={2000}
                  />
                  <div className="project-toolbar">
                    <button type="submit">Save message</button>
                    <button type="button" onClick={() => setEditing(null)}>
                      Cancel edit
                    </button>
                  </div>
                </form>
              ) : (
                <div className={`message-content ${message.command ? 'command' : ''}`}>
                  <MessageText content={message.content} />
                </div>
              )}
              {message.embeds?.map((embed, embedIndex) => (
                <div
                  className="message-embed"
                  key={embedIndex}
                  style={
                    typeof embed['color'] === 'number'
                      ? { borderLeftColor: `#${embed['color'].toString(16).padStart(6, '0')}` }
                      : undefined
                  }
                >
                  {typeof embed['title'] === 'string' && <strong>{embed['title']}</strong>}
                  {typeof embed['description'] === 'string' && <p>{embed['description']}</p>}
                  {Array.isArray(embed['fields']) &&
                    embed['fields'].filter(isRecord).map((field, index) => (
                      <section key={index}>
                        <strong>{label(field['name'])}</strong>
                        <p>{label(field['value'])}</p>
                      </section>
                    ))}
                  {isRecord(embed['footer']) && <small>{label(embed['footer']['text'])}</small>}
                </div>
              ))}
              {message.attachments?.map((attachment, index) => (
                <div className="message-attachment" key={label(attachment['id'], String(index))}>
                  {label(attachment['filename'], 'Local attachment')}
                  {typeof attachment['size'] === 'number' ? ` · ${attachment['size']} bytes` : ''}
                  {typeof attachment['id'] === 'string' && onSaveAttachment && (
                    <button
                      type="button"
                      onClick={() => onSaveAttachment(attachment['id'] as string)}
                    >
                      Save {label(attachment['filename'], 'attachment')}
                    </button>
                  )}
                </div>
              ))}
              {message.components?.map((component, index) => (
                <ComponentControl
                  key={index}
                  component={component}
                  messageId={message.id}
                  onAction={onAction}
                />
              ))}
              {message.metadata && <div className="message-metadata">{message.metadata}</div>}
              {onAction && message.editable === true && (
                <div className="message-actions">
                  <button
                    type="button"
                    aria-label={`Edit message ${message.id}`}
                    onClick={() => {
                      setEditing(message.id);
                      setEditContent(message.content);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete message ${message.id}`}
                    onClick={() => onAction({ type: 'message-delete', messageId: message.id })}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </article>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
