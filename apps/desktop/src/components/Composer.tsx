import { useMemo, useState } from 'react';
import { Braces, Gift, Plus, SendHorizonal, Smile } from 'lucide-react';
import { COMMANDS } from '../data';

interface ComposerProps {
  readonly channelName: string;
  readonly botRunning: boolean;
  readonly onSubmit: (value: string) => void;
}

export function Composer({ channelName, botRunning, onSubmit }: ComposerProps) {
  const [value, setValue] = useState('');
  const [focusedCommand, setFocusedCommand] = useState(0);
  const matchingCommands = useMemo(() => {
    if (!value.startsWith('/')) return [];
    const query = value.toLowerCase();
    return COMMANDS.filter((command) => command.name.startsWith(query));
  }, [value]);

  const submit = () => {
    if (!value.trim()) return;
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
      <div className={`composer ${botRunning ? '' : 'bot-offline'}`}>
        <button
          aria-label="Attach local fixture"
          onClick={() => setValue((current) => `${current}${current ? ' ' : ''}[fixture.json]`)}
          type="button"
        >
          <Plus size={18} />
        </button>
        <input
          aria-label={`Message #${channelName}`}
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
            botRunning
              ? `Message #${channelName}  ·  try /ping`
              : 'Start TestBot to invoke local commands'
          }
          value={value}
        />
        <button
          aria-label="Insert test component"
          onClick={() => setValue((current) => `${current}${current ? ' ' : ''}[Button: Confirm]`)}
          type="button"
        >
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
          disabled={!value.trim()}
          onClick={submit}
          type="button"
        >
          <SendHorizonal size={18} />
        </button>
      </div>
    </div>
  );
}
