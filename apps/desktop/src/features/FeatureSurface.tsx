import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Download,
  FileJson,
  FlaskConical,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  Hash,
  Info,
  KeyRound,
  ListChecks,
  Play,
  Plus,
  RadioTower,
  Save,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Square,
  TerminalSquare,
  TriangleAlert,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { COMMANDS } from '../data';
import type { Guild, Surface } from '../types';

interface FeatureSurfaceProps {
  readonly surface: Exclude<Surface, 'simulator'>;
  readonly guild: Guild;
  readonly onBack: () => void;
  readonly onInvoke: (command: string) => void;
  readonly onSelectProject: () => Promise<void>;
  readonly runtime: DisRunnerRuntimeState;
}

interface SurfaceHeaderProps {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly onBack: () => void;
  readonly actions?: React.ReactNode;
  readonly previewLabel?: string;
}

function SurfaceHeader({
  icon,
  title,
  description,
  onBack,
  actions,
  previewLabel,
}: SurfaceHeaderProps) {
  return (
    <header className="surface-header">
      <button
        aria-label="Back to simulator"
        className="surface-back"
        onClick={onBack}
        type="button"
      >
        <ArrowLeft size={17} />
      </button>
      <span className="surface-title-icon">{icon}</span>
      <div>
        <div className="surface-title-row">
          <h1>{title}</h1>
          {previewLabel !== undefined && <span className="preview-label">{previewLabel}</span>}
        </div>
        <p>{description}</p>
      </div>
      <div className="surface-header-actions">{actions}</div>
    </header>
  );
}

const EDITOR_TABS = ['Users', 'Roles', 'Channels', 'Permissions', 'Messages', 'Events'] as const;

function GuildEditor({ guild, onBack }: Pick<FeatureSurfaceProps, 'guild' | 'onBack'>) {
  const [tab, setTab] = useState<(typeof EDITOR_TABS)[number]>('Channels');
  const [selectedChannel, setSelectedChannel] = useState(guild.groups[0]?.channels[0]?.id ?? '');
  const channels = guild.groups.flatMap((group) => group.channels);
  const selected = channels.find((channel) => channel.id === selectedChannel) ?? channels[0];

  return (
    <div className="feature-surface">
      <SurfaceHeader
        actions={
          <button className="primary-action" disabled type="button">
            <Save size={15} />
            Save unavailable
          </button>
        }
        description="Explore sample resources and a sample permission result; editing is not persisted."
        icon={<Box size={20} />}
        onBack={onBack}
        previewLabel="Visual preview"
        title="Guild Editor"
      />
      <div className="surface-tabs" role="tablist" aria-label="Guild resource types">
        {EDITOR_TABS.map((item) => (
          <button
            aria-selected={tab === item}
            className={tab === item ? 'active' : ''}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      <div className="editor-workspace">
        <aside className="resource-list">
          <div className="surface-list-title">
            <span>{tab}</span>
            <button aria-label={`Create ${tab.toLowerCase()}`} disabled type="button">
              <Plus size={15} />
            </button>
          </div>
          <label className="surface-search">
            <Search size={14} />
            <input
              aria-label={`Search ${tab.toLowerCase()}`}
              disabled
              placeholder={`Search ${tab.toLowerCase()}`}
            />
          </label>
          {tab === 'Channels'
            ? channels.map((channel) => (
                <button
                  className={selectedChannel === channel.id ? 'active' : ''}
                  key={channel.id}
                  onClick={() => setSelectedChannel(channel.id)}
                  type="button"
                >
                  <Hash size={15} />
                  <span>
                    <strong>{channel.name}</strong>
                    <small>{channel.id}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            : guild.members.map((member) => (
                <button key={member.id} type="button">
                  <UserRound size={15} />
                  <span>
                    <strong>{member.name}</strong>
                    <small>{member.role}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
        </aside>
        <main className="resource-editor">
          <div className="resource-heading">
            <div>
              <span className="resource-symbol">
                <Hash size={20} />
              </span>
              <span>
                <h2>{selected?.name ?? tab}</h2>
                <p>{selected?.description ?? `${tab} fixture settings for ${guild.name}.`}</p>
              </span>
            </div>
            <span className="dirty-indicator">
              <CircleDot size={13} /> Sample data
            </span>
          </div>
          <div className="field-grid">
            <label>
              <span>Name</span>
              <input defaultValue={selected?.name ?? tab.toLowerCase()} disabled />
            </label>
            <label>
              <span>Snowflake ID</span>
              <input defaultValue="1190042002001" disabled readOnly />
            </label>
            <label className="field-wide">
              <span>Topic</span>
              <input
                defaultValue={selected?.description ?? 'Virtual guild resource fixture'}
                disabled
              />
            </label>
            <label>
              <span>Type</span>
              <select defaultValue="Guild Text" disabled>
                <option>Guild Text</option>
                <option>Guild Voice</option>
                <option>Forum</option>
              </select>
            </label>
            <label>
              <span>Slowmode</span>
              <select defaultValue="Off" disabled>
                <option>Off</option>
                <option>5 seconds</option>
                <option>30 seconds</option>
              </select>
            </label>
          </div>
          <section className="permission-open-panel">
            <div className="panel-section-heading">
              <div>
                <KeyRound size={16} />
                <span>
                  <h3>Permission overwrites</h3>
                  <p>Sample output shaped like a core permission decision</p>
                </span>
              </div>
              <button disabled type="button">
                <Plus size={14} /> Add overwrite
              </button>
            </div>
            <div className="permission-table" role="table">
              <div className="permission-table-row header">
                <span>Principal</span>
                <span>View channel</span>
                <span>Send messages</span>
                <span>Manage messages</span>
              </div>
              <div className="permission-table-row">
                <span>
                  <Users size={14} /> @everyone
                </span>
                <span className="allow">
                  <Check size={13} /> Allow
                </span>
                <span>Inherit</span>
                <span>Inherit</span>
              </div>
              <div className="permission-table-row">
                <span>
                  <Bot size={14} /> TestBot
                </span>
                <span>Inherit</span>
                <span className="allow">
                  <Check size={13} /> Allow
                </span>
                <span className="deny">
                  <X size={13} /> Deny
                </span>
              </div>
            </div>
          </section>
        </main>
        <aside className="resource-inspector">
          <div className="surface-list-title">Sample effective result</div>
          <div className="permission-score">
            <Shield size={25} />
            <strong>63 / 64</strong>
            <span>permissions allowed</span>
          </div>
          <div className="effective-row">
            <span>View Channel</span>
            <b className="allow">
              <Check size={13} /> Allow
            </b>
          </div>
          <div className="effective-row">
            <span>Send Messages</span>
            <b className="allow">
              <Check size={13} /> Allow
            </b>
          </div>
          <div className="effective-row">
            <span>Manage Messages</span>
            <b className="deny">
              <X size={13} /> Deny
            </b>
          </div>
          <div className="inspector-callout warning">
            <TriangleAlert size={16} />
            <span>Channel overwrite wins over the bot role grant.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ScenarioLab({ onBack }: Pick<FeatureSurfaceProps, 'onBack'>) {
  const [scenario, setScenario] = useState('Interaction deadline');

  return (
    <div className="feature-surface">
      <SurfaceHeader
        actions={
          <>
            <button className="secondary-action" disabled type="button">
              <Square size={12} /> Stop
            </button>
            <button className="primary-action" disabled type="button">
              <Play fill="currentColor" size={14} /> Run unavailable
            </button>
          </>
        }
        description="Preview a planned scenario workflow; execute supported scenarios from the CLI."
        icon={<FlaskConical size={20} />}
        onBack={onBack}
        previewLabel="Visual preview"
        title="Scenario Lab"
      />
      <div className="scenario-workspace">
        <aside className="scenario-list">
          <div className="surface-list-title">
            <span>Scenarios</span>
            <button aria-label="Create scenario" disabled type="button">
              <Plus size={15} />
            </button>
          </div>
          {['Interaction deadline', 'Permission denied', '429 retry queue', 'Gateway resume'].map(
            (name, index) => (
              <button
                className={scenario === name ? 'active' : ''}
                key={name}
                onClick={() => {
                  setScenario(name);
                }}
                type="button"
              >
                {index === 0 ? (
                  <Clock3 size={15} />
                ) : index === 1 ? (
                  <ShieldAlert size={15} />
                ) : index === 2 ? (
                  <Gauge size={15} />
                ) : (
                  <RadioTower size={15} />
                )}
                <span>
                  <strong>{name}</strong>
                  <small>
                    {index + 3} actions · {index + 2} assertions
                  </small>
                </span>
              </button>
            ),
          )}
        </aside>
        <main className="scenario-canvas">
          <div className="canvas-toolbar">
            <div>
              <strong>{scenario}</strong>
              <span>interaction-deadline.discord-scenario.yml</span>
            </div>
            <div>
              <button disabled type="button">
                <GitCompareArrows size={14} /> Diff
              </button>
              <button disabled type="button">
                <Code2 size={14} /> YAML
              </button>
            </div>
          </div>
          <div className="scenario-track">
            <div className="track-axis">
              <span>0ms</span>
              <span>500ms</span>
              <span>1.000s</span>
              <span>2.000s</span>
              <span>3.000s</span>
              <span>3.500s</span>
            </div>
            <div className="scenario-deadline">
              <span>3s deadline</span>
            </div>
            {[
              ['1', 'Invoke /slow', 'User action', '0ms', 'blue'],
              ['2', 'Delay handler', 'Fault · 3.420s', '220ms', 'amber'],
              ['3', 'Expect timeout', 'Risk assertion', '3.000s', 'red'],
              ['4', 'Follow-up arrives', 'Webhook callback', '3.420s', 'green'],
            ].map(([number, title, type, time, tone]) => (
              <div className={`scenario-node ${tone}`} key={number}>
                <span className="node-index">{number}</span>
                <span className="node-icon">
                  {number === '1' ? (
                    <Play size={13} />
                  ) : number === '2' ? (
                    <Clock3 size={13} />
                  ) : number === '3' ? (
                    <ListChecks size={13} />
                  ) : (
                    <Sparkles size={13} />
                  )}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{type}</small>
                </span>
                <time>{time}</time>
                <ChevronRight size={14} />
              </div>
            ))}
          </div>
        </main>
        <aside className="scenario-results">
          <div className="surface-list-title">Sample result layout</div>
          <div className="run-state idle">
            <FlaskConical size={27} />
            <strong>Visual preview only</strong>
            <span>No scenario has run in this screen</span>
          </div>
          <div className="assertion-list">
            {[
              'Interaction dispatched',
              'Initial response absent',
              'Timeout risk emitted',
              'Follow-up preserved',
            ].map((label, index) => (
              <div key={label}>
                <span>{index + 1}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CommandExplorer({
  onBack,
  onInvoke,
  runtime,
}: Pick<FeatureSurfaceProps, 'onBack' | 'onInvoke' | 'runtime'>) {
  const [selectedName, setSelectedName] = useState('/slow');
  const selected = COMMANDS.find((command) => command.name === selectedName) ?? COMMANDS[0];
  const desktop = window.disrunnerDesktop !== undefined;
  return (
    <div className="feature-surface">
      <SurfaceHeader
        actions={
          <button
            className="primary-action"
            disabled={!desktop || runtime.phase !== 'running'}
            onClick={() => selected && onInvoke(selected.name)}
            type="button"
          >
            <Play fill="currentColor" size={14} /> Invoke selected name
          </button>
        }
        description="Browse a sample command catalog; invocation sends only the selected name to a running raw webhook."
        icon={<TerminalSquare size={20} />}
        onBack={onBack}
        previewLabel="Visual preview · invocation can be real"
        title="Command Explorer"
      />
      <div className="command-workspace">
        <aside className="command-registry">
          <div className="surface-list-title">
            <span>Sample commands — {COMMANDS.length}</span>
            <button aria-label="Refresh command registry" disabled type="button">
              <Activity size={15} />
            </button>
          </div>
          <label className="surface-search">
            <Search size={14} />
            <input aria-label="Search commands" disabled placeholder="Search unavailable" />
          </label>
          {COMMANDS.map((command) => (
            <button
              className={selected?.name === command.name ? 'active' : ''}
              key={command.name}
              onClick={() => setSelectedName(command.name)}
              type="button"
            >
              <span className="registry-icon">
                <Braces size={15} />
              </span>
              <span>
                <strong>{command.name}</strong>
                <small>{command.description}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </aside>
        <main className="command-detail">
          <div className="command-detail-heading">
            <span className="command-glyph">
              <Braces size={22} />
            </span>
            <div>
              <h2>{selected?.name}</h2>
              <p>{selected?.description}</p>
            </div>
            <span className="version-tag">Sample · Guild · v4</span>
          </div>
          <div className="command-facts">
            <div>
              <span>Command ID</span>
              <code>1190042003004</code>
            </div>
            <div>
              <span>Integration</span>
              <strong>Guild install</strong>
            </div>
            <div>
              <span>Contexts</span>
              <strong>Guild · Bot DM</strong>
            </div>
            <div>
              <span>Default permission</span>
              <strong>Use Application Commands</strong>
            </div>
          </div>
          <section className="command-section">
            <div className="panel-section-heading">
              <div>
                <SlidersHorizontal size={16} />
                <span>
                  <h3>Options</h3>
                  <p>Sample schema; not discovered or validated from the running bot</p>
                </span>
              </div>
            </div>
            <div className="option-row">
              <span>
                <code>target</code>
                <b>User</b>
              </span>
              <span>Optional resolved user fixture</span>
              <span>
                <Info size={13} /> Sample
              </span>
            </div>
            <div className="option-row">
              <span>
                <code>reason</code>
                <b>String</b>
              </span>
              <span>1–100 UTF-16 code units</span>
              <span>
                <Info size={13} /> Sample
              </span>
            </div>
          </section>
          <section className="command-section payload-preview">
            <div className="panel-section-heading">
              <div>
                <FileJson size={16} />
                <span>
                  <h3>Invocation preview</h3>
                  <p>Sample shape only; the active runtime constructs its own IDs and context</p>
                </span>
              </div>
            </div>
            <pre>
              {JSON.stringify(
                {
                  type: 2,
                  data: { name: selected?.name.slice(1), type: 1 },
                  guild_id: desktop ? '[ACTIVE FIXTURE OR OMITTED]' : 'foundation',
                  channel_id: desktop ? '[ACTIVE FIXTURE OR OMITTED]' : 'bot-testing',
                  token: '[REDACTED]',
                },
                null,
                2,
              )}
            </pre>
          </section>
        </main>
      </div>
    </div>
  );
}

type RiskFilter = 'All' | 'High' | 'Medium' | 'Resolved';

function RiskCenter({ onBack, runtime }: Pick<FeatureSurfaceProps, 'onBack' | 'runtime'>) {
  const [filter, setFilter] = useState<RiskFilter>('All');
  const desktop = window.disrunnerDesktop !== undefined;
  const risks = useMemo(
    () =>
      desktop
        ? runtime.risks.map((risk) => ({
            id: risk.ruleId,
            level:
              risk.severity === 'critical'
                ? 'Critical'
                : `${risk.severity.slice(0, 1).toUpperCase()}${risk.severity.slice(1)}`,
            category: risk.ruleId.includes('INTERACTION') ? 'Interaction' : 'Runtime',
            title: risk.title,
            evidence: risk.evidence,
            score:
              (
                { critical: 100, high: 80, medium: 60, low: 30, info: 10 } as Readonly<
                  Record<string, number>
                >
              )[risk.severity] ?? 50,
          }))
        : [
            {
              id: 'INTERACTION_TIMEOUT',
              level: 'High',
              category: 'Interaction',
              title: 'Initial response missed the 3-second deadline',
              evidence: '/slow · trace-timeout-001',
              score: 92,
            },
            {
              id: 'MISSING_BOT_PERMISSION',
              level: 'Medium',
              category: 'Permission',
              title: 'Manage Messages denied by channel overwrite',
              evidence: '/permissions · #bot-testing',
              score: 67,
            },
            {
              id: 'RATE_LIMIT_HOT_BUCKET',
              level: 'Medium',
              category: 'Reliability',
              title: 'Message create bucket exhausted',
              evidence: '/rate-limit · retry after 1.25s',
              score: 61,
            },
            {
              id: 'BOT_TOKEN_IN_LOG',
              level: 'Resolved',
              category: 'Security',
              title: 'Credential-shaped value was redacted',
              evidence: 'trace export · automatic redaction',
              score: 0,
            },
          ],
    [desktop, runtime.risks],
  );
  const visible = risks.filter((risk) => filter === 'All' || risk.level === filter);
  const highCount = risks.filter(
    (risk) => risk.level === 'High' || risk.level === 'Critical',
  ).length;
  const mediumCount = risks.filter((risk) => risk.level === 'Medium').length;
  const resolvedCount = risks.filter((risk) => risk.level === 'Resolved').length;
  const riskScore = risks.reduce((score, risk) => Math.max(score, risk.score), 0);
  return (
    <div className="feature-surface">
      <SurfaceHeader
        actions={
          <button className="secondary-action" disabled type="button">
            <Download size={15} /> Export unavailable
          </button>
        }
        description="Display bounded runtime findings in Electron; scores, history, and browser rows are samples."
        icon={<ShieldAlert size={20} />}
        onBack={onBack}
        previewLabel="Visual preview · runtime rows can be real"
        title="Risk Center"
      />
      <div className="risk-overview">
        <div className="risk-score">
          <ShieldAlert size={24} />
          <span>
            <strong>{riskScore}</strong>
            <small>Display score</small>
          </span>
          <b>
            {desktop
              ? risks.length === 0
                ? 'No runtime findings in snapshot'
                : 'Runtime findings'
              : 'Sample findings'}
          </b>
        </div>
        <div className="severity-stat high">
          <span>{highCount}</span>
          <small>High</small>
        </div>
        <div className="severity-stat medium">
          <span>{mediumCount}</span>
          <small>Medium</small>
        </div>
        <div className="severity-stat resolved">
          <span>{resolvedCount}</span>
          <small>Resolved</small>
        </div>
        <div className="risk-sparkline" aria-label="Risk score trend">
          <span style={{ height: '30%' }} />
          <span style={{ height: '44%' }} />
          <span style={{ height: '37%' }} />
          <span style={{ height: '65%' }} />
          <span style={{ height: '54%' }} />
          <span style={{ height: '72%' }} />
          <small>Sample trend · no run history</small>
        </div>
      </div>
      <div className="risk-toolbar">
        <div className="filter-tabs">
          {(['All', 'High', 'Medium', 'Resolved'] as const).map((item) => (
            <button
              className={filter === item ? 'active' : ''}
              key={item}
              onClick={() => setFilter(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
        <label className="surface-search">
          <Search size={14} />
          <input aria-label="Search risks" disabled placeholder="Search unavailable" />
        </label>
      </div>
      <main className="risk-table" aria-label="Risk findings">
        <div className="risk-table-row header">
          <span>Finding</span>
          <span>Category</span>
          <span>Evidence</span>
          <span>Score</span>
          <span />
        </div>
        {visible.length === 0 && (
          <div className="risk-table-empty">No runtime findings in the current snapshot.</div>
        )}
        {visible.map((risk) => (
          <div className="risk-table-row" key={risk.id}>
            <span>
              <i className={risk.level.toLowerCase()}>
                {risk.level === 'Resolved' ? <Check size={14} /> : <TriangleAlert size={14} />}
              </i>
              <span>
                <strong>{risk.id}</strong>
                <small>{risk.title}</small>
              </span>
            </span>
            <span>{risk.category}</span>
            <span>
              <code>{risk.evidence}</code>
            </span>
            <span>
              <b>{risk.score}</b>/100
            </span>
            <button aria-label={`Open ${risk.id}`} disabled type="button">
              <ChevronRight size={16} />
            </button>
          </div>
        ))}
      </main>
    </div>
  );
}

interface ToggleSettingProps {
  readonly label: string;
  readonly description: string;
  readonly initial?: boolean;
  readonly locked?: boolean;
}

function ToggleSetting({
  label,
  description,
  initial = false,
  locked = false,
}: ToggleSettingProps) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <div className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <button
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`}
        aria-pressed={enabled}
        className={`switch ${enabled ? 'enabled' : ''}`}
        disabled={locked}
        onClick={() => setEnabled((value) => !value)}
        type="button"
      >
        <span />
      </button>
    </div>
  );
}

function SettingsSurface({
  onBack,
  onSelectProject,
  runtime,
}: Pick<FeatureSurfaceProps, 'onBack' | 'onSelectProject' | 'runtime'>) {
  const [section, setSection] = useState('Security');
  const desktop = window.disrunnerDesktop !== undefined;
  const projectPath =
    runtime.project?.root ??
    (desktop
      ? 'No validated project selected'
      : 'Browser preview · folder picker available in Electron');
  const runtimeActive = ['starting', 'running', 'stopping'].includes(runtime.phase);
  const projectConfigured = runtime.project !== null && runtime.error === null;
  const sections = [
    'Appearance',
    'Runtime paths',
    'Editors',
    'Storage',
    'Retention',
    'Security',
    'Plugins',
    'Updates',
    'Diagnostics',
  ];
  return (
    <div className="feature-surface">
      <SurfaceHeader
        actions={
          <button className="primary-action" disabled type="button">
            <Save size={15} /> Persistence unavailable
          </button>
        }
        description="Inspect enforced runtime boundaries and select a project; other settings are visual previews and are not persisted."
        icon={<Settings2 size={20} />}
        onBack={onBack}
        previewLabel="Visual preview · runtime paths are real"
        title="Settings"
      />
      <div className="settings-workspace">
        <aside className="settings-nav">
          {sections.map((item) => (
            <button
              className={section === item ? 'active' : ''}
              key={item}
              onClick={() => setSection(item)}
              type="button"
            >
              {item === 'Security' ? (
                <Shield size={15} />
              ) : item === 'Runtime paths' ? (
                <FolderOpen size={15} />
              ) : item === 'Diagnostics' ? (
                <Activity size={15} />
              ) : (
                <Settings2 size={15} />
              )}
              {item}
            </button>
          ))}
        </aside>
        <main className="settings-content">
          <div className="settings-heading">
            <h2>{section}</h2>
            <p>
              {section === 'Security'
                ? 'Renderer requests and simulator endpoints are loopback-only; bot child processes remain trusted local code.'
                : section === 'Runtime paths'
                  ? 'Select the local bot project used by the real Desktop runtime.'
                  : `${section} is a visual preview; controls are disabled and changes are not persisted.`}
            </p>
          </div>
          <div
            className={`config-diagnostic ${runtime.error !== null ? 'invalid' : projectConfigured ? 'valid' : 'neutral'}`}
            role="status"
          >
            {runtime.error !== null ? (
              <TriangleAlert size={15} />
            ) : projectConfigured ? (
              <Check size={15} />
            ) : (
              <Info size={15} />
            )}
            <span>
              <strong>
                {runtime.project === null
                  ? 'Project configuration not loaded'
                  : `Configuration ${runtime.phase}`}
              </strong>
              <small>
                {runtime.error ??
                  runtime.project?.configPath ??
                  'Select a folder containing discord-simulator.config.json.'}
              </small>
            </span>
          </div>
          {section === 'Security' ? (
            <>
              <div className={`security-banner ${desktop ? '' : 'preview'}`}>
                <Shield size={22} />
                <div>
                  <strong>
                    {desktop
                      ? 'Renderer offline policy is enforced'
                      : 'Electron renderer policy preview'}
                  </strong>
                  <span>
                    {desktop
                      ? 'Electron navigation and requests are denied except for app files and the exact active loopback endpoints.'
                      : 'These controls are enforced by the packaged Electron shell, not by this browser preview.'}
                  </span>
                </div>
                <b>{desktop ? 'ENFORCED' : 'PREVIEW'}</b>
              </div>
              <div className="child-boundary-warning">
                <TriangleAlert size={17} />
                <span>
                  <strong>Child process boundary</strong>
                  <small>
                    The selected bot is not OS-sandboxed. Run only trusted local code; the runner
                    constrains configuration and workspace paths but cannot contain arbitrary
                    child-process filesystem or network access.
                  </small>
                </span>
              </div>
              <div className="child-boundary-warning">
                <Info size={17} />
                <span>
                  <strong>Current REST coverage</strong>
                  <small>
                    The live Desktop runtime emulates supported REST resources and a representative
                    shared message-create rate limit. Permission enforcement,
                    REST-mutation-to-Gateway dispatch, and observing a deferred callback&apos;s
                    later REST follow-up in the composer are not yet implemented; permission and
                    event panels remain fixture previews.
                  </small>
                </span>
              </div>
              <section className="settings-section">
                <h3>Network policy</h3>
                <ToggleSetting
                  description="Deny renderer traffic unless the exact app resource or active loopback endpoint is allowlisted."
                  initial={desktop}
                  label="Deny renderer by default"
                  locked
                />
                <ToggleSetting
                  description="Reject Discord domains in the Electron renderer; child-process isolation requires an OS sandbox outside this app."
                  initial={desktop}
                  label="Block renderer Discord traffic"
                  locked
                />
                <ToggleSetting
                  description="Visual preview only; denied renderer requests are not recorded as audit evidence."
                  label="Audit blocked requests"
                  locked
                />
              </section>
              <section className="settings-section">
                <h3>Renderer isolation</h3>
                <ToggleSetting
                  description="Renderer code cannot import Node.js modules."
                  initial={desktop}
                  label="Disable Node integration"
                  locked
                />
                <ToggleSetting
                  description="Expose only the typed DisRunner preload bridge."
                  initial={desktop}
                  label="Context isolation"
                  locked
                />
                <ToggleSetting
                  description="Run renderer processes in the Chromium sandbox."
                  initial={desktop}
                  label="Sandbox renderer"
                  locked
                />
              </section>
            </>
          ) : (
            <>
              <section className="settings-section">
                <h3>Workspace</h3>
                <div className="path-field">
                  <label>
                    <span>Bot project path</span>
                    <input readOnly value={projectPath} />
                  </label>
                  <button
                    disabled={!desktop || runtimeActive || section !== 'Runtime paths'}
                    onClick={() => {
                      void onSelectProject();
                    }}
                    type="button"
                  >
                    <FolderOpen size={14} /> Browse
                  </button>
                </div>
                <div className="runtime-details">
                  <span>
                    <small>Executable</small>
                    <code>{runtime.project?.executable ?? '—'}</code>
                  </span>
                  <span>
                    <small>Arguments</small>
                    <code>{runtime.project?.args.join(' ') || '—'}</code>
                  </span>
                  <span>
                    <small>Working directory</small>
                    <code>{runtime.project?.cwd ?? '—'}</code>
                  </span>
                  <span>
                    <small>Adapter / profile</small>
                    <code>
                      {runtime.project === null
                        ? '—'
                        : `${runtime.project.adapter} · ${runtime.project.mode} · seed ${runtime.project.seed}`}
                    </code>
                  </span>
                  <span>
                    <small>Environment</small>
                    <code>
                      {runtime.project?.environmentNames.join(', ') || 'No explicit names'}
                    </code>
                  </span>
                </div>
                <ToggleSetting
                  description="Visual preview only; session restore is not implemented or persisted."
                  label="Restore deterministic session"
                  locked
                />
              </section>
              <section className="settings-section">
                <h3>Preferences</h3>
                <ToggleSetting
                  description="Visual preview only; this preference is not implemented or persisted."
                  label="Autosave local traces"
                  locked
                />
                <ToggleSetting
                  description="Visual preview only; this preference is not implemented or persisted."
                  label="Extended diagnostics"
                  locked
                />
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function FeatureSurface({
  surface,
  guild,
  onBack,
  onInvoke,
  onSelectProject,
  runtime,
}: FeatureSurfaceProps) {
  switch (surface) {
    case 'guild-editor':
      return <GuildEditor guild={guild} onBack={onBack} />;
    case 'scenario-lab':
      return <ScenarioLab onBack={onBack} />;
    case 'command-explorer':
      return <CommandExplorer onBack={onBack} onInvoke={onInvoke} runtime={runtime} />;
    case 'risk-center':
      return <RiskCenter onBack={onBack} runtime={runtime} />;
    case 'settings':
      return (
        <SettingsSurface onBack={onBack} onSelectProject={onSelectProject} runtime={runtime} />
      );
  }
}
