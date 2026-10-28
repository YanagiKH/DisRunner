import { useMemo, useState } from 'react';
import { Braces, Gift, Plus, SendHorizonal, Smile } from 'lucide-react';
import { COMMANDS } from '../data';
import type { CommandSpec } from '../types';

interface ComposerProps {
  readonly channelName: string;
  readonly botRunning: boolean;
  readonly invocationBlockReason?: string | undefined;
  readonly onSubmit: (value: string) => void;
  readonly commands?: readonly CommandSpec[] | undefined;
}

export function Composer({
  channelName,
  botRunning,
  onSubmit,
  invocationBlockReason,
  commands = COMMANDS,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [focusedCommand, setFocusedCommand] = useState(0);
  const matchingCommands = useMemo(() => {
    if (!value.startsWith('/')) return [];
    const query = value.toLowerCase();
    return commands.filter((command) => command.name.startsWith(query));
  }, [value, commands]);

  const submit = () => {
    if (!value.trim() || invocationBlockReason !== undefined) return;
    onSubmit(value);
    setValue('');
    setFocusedCommand(0);
  };

  return (
    <div className="composer-wrap">
      {matchingCommands.length > 0 && (
        <div className="command-menu" role="listbox" aria-label="Available slash commands">
          <div className="command-menu-title">Application commands</div>
          {matchingCommands.map((command, index) => (
            <button
              aria-selected={focusedCommand === index}
              className={focusedCommand === index ? 'active' : ''}
              key={command.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setValue(command.name);
                setFocusedCommand(index);
              }}
              role="option"
              type="button"
            >
              <span
                className="command-icon"
                style={{ '--command-color': command.color } as React.CSSProperties}
              >
                <Braces size={15} />
              </span>
              <span>
                <strong>{command.name}</strong>
                <small>{command.description}</small>
              </span>
              <kbd>{command.shortcut}</kbd>
            </button>
          ))}
        </div>
      )}
      {invocationBlockReason && <p id="invocation-unavailable">{invocationBlockReason}</p>}
      <div className={`composer ${botRunning ? '' : 'bot-offline'}`}>
        <button aria-label="Choose attachments in Command Explorer" disabled type="button">
          <Plus size={18} />
        </button>
        <input
          aria-label={`Message #${channelName}`}
          aria-describedby={invocationBlockReason ? 'invocation-unavailable' : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setFocusedCommand(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && matchingCommands.length > 0) {
              event.preventDefault();
              setFocusedCommand((current) => (current + 1) % matchingCommands.length);
            } else if (event.key === 'ArrowUp' && matchingCommands.length > 0) {
              event.preventDefault();
              setFocusedCommand(
                (current) => (current - 1 + matchingCommands.length) % matchingCommands.length,
              );
            } else if (event.key === 'Tab' && matchingCommands[focusedCommand]) {
              event.preventDefault();
              setValue(matchingCommands[focusedCommand].name);
            } else if (event.key === 'Escape') {
              setValue('');
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={
            invocationBlockReason ??
            (botRunning
              ? `Message #${channelName}${commands.some((command) => command.name === '/ping') ? '  ·  try /ping' : ''}`
              : 'Start the bot to send local events')
          }
          value={value}
        />
        <button aria-label="Bot components appear on messages" disabled type="button">
          <Gift size={18} />
        </button>
        <button
          aria-label="Insert emoji"
          onClick={() => setValue((current) => `${current} 🙂`)}
          type="button"
        >
          <Smile size={19} />
        </button>
        <button
          aria-label="Send local event"
          className="send-button"
          disabled={!value.trim() || invocationBlockReason !== undefined}
          aria-describedby={invocationBlockReason ? 'invocation-unavailable' : undefined}
          onClick={submit}
          type="button"
        >
          <SendHorizonal size={18} />
        </button>
      </div>
    </div>
  );
}
