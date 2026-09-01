import {
  Bot,
  ChevronDown,
  ChevronsRight,
  EllipsisVertical,
  Minus,
  Play,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { BrandMark } from './BrandMark';
import type { BotStatus } from '../types';

interface TopBarProps {
  readonly botStatus: BotStatus;
  readonly guildName: string;
  readonly onStart: () => void;
  readonly onStop: () => void;
}

export function TopBar({ botStatus, guildName, onStart, onStop }: TopBarProps) {
  const desktop = window.disrunnerDesktop !== undefined;
  const controlWindow = (action: 'minimize' | 'maximize' | 'close') => {
    void window.disrunnerDesktop?.controlWindow(action);
  };

  const statusLabel: Readonly<Record<BotStatus, string>> = {
    idle: 'No project',
    ready: 'Ready',
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping',
    stopped: 'Offline',
    error: 'Runtime error',
  };
  const transitioning = botStatus === 'starting' || botStatus === 'stopping';

  return (
    <header className="top-bar">
      <div className="brand-lockup" aria-label="DisRunner">
        <BrandMark className="brand-mark" size={30} />
        <strong>DisRunner</strong>
        <span className="preview-label">Visual preview shell</span>
      </div>
      <div className="top-divider" />
      <button className="workspace-switcher" disabled type="button">
        <span>{guildName}</span>
        <ChevronDown size={16} />
      </button>
      <div className="top-divider top-divider-soft" />
      <div className={`run-indicator ${botStatus}`} aria-live="polite">
        <span className="status-dot" />
        {statusLabel[botStatus]}
      </div>
      <button className="mode-control" disabled type="button">
        <ShieldCheck size={16} />
        <span>Profile preview · Strict</span>
      </button>
      <div className="seed-control" title="Sample deterministic random seed">
        Sample seed 42042
      </div>
      <div className="virtual-clock" aria-label="Sample virtual time controls">
        <span>Sample time</span>
        <output>12:34:56</output>
        <button aria-label="Virtual time playback unavailable" disabled type="button">
          <Play fill="currentColor" size={16} />
        </button>
        <button aria-label="Virtual time advance unavailable" disabled type="button">
          <ChevronsRight fill="currentColor" size={17} />
        </button>
      </div>
      <div className="top-spacer" />
      <div className="runner-controls" aria-label="Bot process controls">
        <button
          className="start-button"
          disabled={botStatus === 'running' || transitioning}
          onClick={onStart}
          type="button"
        >
          <Bot size={15} />
          Start bot
        </button>
        <button
          className="stop-button"
          disabled={!['running', 'starting', 'stopping'].includes(botStatus)}
          onClick={onStop}
          type="button"
        >
          <Square fill="currentColor" size={12} />
          Stop bot
        </button>
      </div>
      <button
        aria-label="More application actions unavailable"
        className="top-icon-button"
        disabled
        type="button"
      >
        <EllipsisVertical size={18} />
      </button>
      <div className="top-divider window-divider" />
      <div className="window-controls" aria-label="Window controls">
        <button
          aria-label="Minimize window"
          disabled={!desktop}
          onClick={() => controlWindow('minimize')}
          type="button"
        >
          <Minus size={15} />
        </button>
        <button
          aria-label="Maximize window"
          disabled={!desktop}
          onClick={() => controlWindow('maximize')}
          type="button"
        >
          <Square size={12} />
        </button>
        <button
          aria-label="Close window"
          disabled={!desktop}
          onClick={() => controlWindow('close')}
          type="button"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
