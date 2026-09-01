import {
  Box,
  FlaskConical,
  LayoutDashboard,
  Settings,
  ShieldAlert,
  SquareTerminal,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import type { Surface } from '../types';
import { BrandMark } from './BrandMark';

interface WorkspaceRailProps {
  readonly active: Surface;
  readonly onNavigate: (surface: Surface) => void;
}

interface RailItem {
  readonly id: Surface;
  readonly label: string;
  readonly icon: ComponentType<LucideProps>;
  readonly tone?: string;
}

const PRIMARY_ITEMS: readonly RailItem[] = [
  { id: 'simulator', label: 'Simulator', icon: LayoutDashboard },
  { id: 'guild-editor', label: 'Guild Editor', icon: Box },
  { id: 'scenario-lab', label: 'Scenario Lab', icon: FlaskConical, tone: 'green' },
  { id: 'command-explorer', label: 'Command Explorer', icon: SquareTerminal, tone: 'purple' },
  { id: 'risk-center', label: 'Risk Center', icon: ShieldAlert, tone: 'red' },
];

export function WorkspaceRail({ active, onNavigate }: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label="Workspace tools">
      <button
        aria-label="Simulator home"
        className={`rail-brand ${active === 'simulator' ? 'active' : ''}`}
        onClick={() => onNavigate('simulator')}
        type="button"
      >
        <BrandMark size={34} />
      </button>
      <div className="rail-separator" />
      {PRIMARY_ITEMS.slice(1).map(({ id, label, icon: Icon, tone }) => (
        <button
          aria-current={active === id ? 'page' : undefined}
          aria-label={label}
          className={`rail-button ${tone ?? ''} ${active === id ? 'active' : ''}`}
          data-tooltip={label}
          key={id}
          onClick={() => onNavigate(id)}
          type="button"
        >
          <Icon size={23} />
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        aria-current={active === 'settings' ? 'page' : undefined}
        aria-label="Settings"
        className={`rail-button rail-settings ${active === 'settings' ? 'active' : ''}`}
        data-tooltip="Settings"
        onClick={() => onNavigate('settings')}
        type="button"
      >
        <Settings size={22} />
      </button>
    </nav>
  );
}
