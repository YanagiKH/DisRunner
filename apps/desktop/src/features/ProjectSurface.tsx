import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Braces,
  Download,
  FolderOpen,
  Play,
  RotateCcw,
  Save,
  Square,
} from 'lucide-react';
import type { ResourceRecord } from '@disrunner/core';
import type { Surface } from '../types';
import type {
  ProjectAction,
  ScenarioView,
  WorkspaceDocument,
  WorkspaceView,
} from '../state/project-workspace';

interface Props {
  readonly hidden: boolean;
  readonly surface: Surface;
  readonly runtime: DisRunnerRuntimeState;
  readonly canInvoke: boolean;
  readonly canSelect: boolean;
  readonly context: DisRunnerInvocationContext | undefined;
  readonly onBack: () => void;
  readonly onOpenProject: (directory?: string) => Promise<void>;
  readonly onOpenExample?: () => Promise<void>;
  readonly onAction: (action: ProjectAction) => Promise<DisRunnerInvocationResult | null>;
  readonly onScenarioActivity?: (running: boolean) => void;
}
type Command = {
  id?: string;
  name: string;
  description?: string;
  type?: number;
  options?: readonly Option[];
};
type Option = {
  name: string;
  type: number;
  description?: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: readonly { name: string; value: string | number }[];
  options?: readonly Option[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
};
type Choice = {
  label: string;
  command: Command;
  path: readonly Option[];
  options: readonly Option[];
};
function commandChoices(commands: readonly Command[]): Choice[] {
  return commands.flatMap((command) => {
    const visit = (options: readonly Option[], path: readonly Option[]): Choice[] => {
      const branches = options.filter((option) => option.type === 1 || option.type === 2);
      return branches.length
        ? branches.flatMap((branch) => visit(branch.options ?? [], [...path, branch]))
        : [
            {
              label: [
                (command.type === 2 ? 'User · ' : command.type === 3 ? 'Message · ' : '') +
                  command.name,
                ...path.map((option) => option.name),
              ].join(' '),
              command,
              path,
              options,
            },
          ];
    };
    return visit(command.options ?? [], []);
  });
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function boundedHistory(values: readonly string[]): string[] {
  const retained: string[] = [];
  let bytes = 0;
  for (let index = values.length - 1; index >= 0 && retained.length < 50; index -= 1) {
    const value = values[index]!;
    bytes += value.length * 2;
    if (bytes > 8 * 1024 * 1024) break;
    retained.push(value);
  }
  return retained.reverse();
}

export function ProjectSurface({
  hidden,
  surface,
  runtime,
  canInvoke,
  canSelect,
  context,
  onBack,
  onOpenProject,
  onOpenExample,
  onAction,
  onScenarioActivity,
}: Props) {
  const bridge = window.disrunnerDesktop;
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [resources, setResources] = useState('[]');
  const [scenarioName, setScenarioName] = useState('untitled');
  const [scenarioSource, setScenarioSource] = useState('');
  const [scenarioFormat, setScenarioFormat] = useState<'json' | 'yaml'>('json');
  const [seed, setSeed] = useState('42');
  const [mode, setMode] = useState<'strict' | 'lenient'>('strict');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<ScenarioView | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  const root = runtime.project?.root ?? '';
  const selectedRoot = useRef(root);
  selectedRoot.current = root;
  const install = (value: WorkspaceView) => {
    setWorkspace(value);
    if (value.document !== null) {
      setResources(JSON.stringify(value.document.resources, null, 2));
      setSeed(String(value.document.options.seed));
      setMode(value.document.options.mode);
      const first = value.document.scenarios[0];
      setScenarioName(first?.name ?? 'untitled');
      setScenarioSource(first?.source ?? '');
      setScenarioFormat(first?.format ?? 'json');
    }
    setDirty(false);
    setHistory([]);
    setRedo([]);
    setError(value.error);
  };
  useEffect(() => {
    setWorkspace(null);
    setError(null);
    setReport(null);
    setProjectPath(root);
    setResources('[]');
    setScenarioSource('');
    setScenarioName('untitled');
    setDirty(false);
    setHistory([]);
    setRedo([]);
    if (root === '' || bridge?.getWorkspace === undefined) return;
    let active = true;
    void bridge
      .getWorkspace()
      .then((value) => {
        if (active) install(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [root, bridge]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const stopped = runtime.phase === 'ready' && !running;
  const writable = workspace !== null && ['missing', 'ready'].includes(workspace.status);
  const save = async () => {
    if (!bridge?.saveWorkspace || !workspace || !stopped) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (seed.trim() === '') throw new TypeError('Enter a simulation seed before saving.');
      const value: unknown = JSON.parse(resources);
      if (!Array.isArray(value)) throw new TypeError('Resources must be a JSON array.');
      const nextScenarios = [...(workspace.document?.scenarios ?? [])].filter(
        (scenario) => scenario.name !== scenarioName,
      );
      if (scenarioSource.trim() !== '')
        nextScenarios.push({ name: scenarioName, format: scenarioFormat, source: scenarioSource });
      const document: WorkspaceDocument = {
        version: 1,
        resources: value as ResourceRecord[],
        scenarios: nextScenarios,
        options: { seed: Number(seed), mode },
      };
      const saved = await bridge.saveWorkspace(document, workspace.hash);
      if (selectedRoot.current !== root) return;
      install(saved);
      setNotice('Workspace saved. The next run will use these resources and options.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    if (!bridge?.getWorkspace || (dirty && !window.confirm('Discard unsaved workspace changes?')))
      return;
    setBusy(true);
    setError(null);
    try {
      install(await bridge.getWorkspace());
      setNotice('Workspace reloaded.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const changeProject = async (directory?: string) => {
    if (dirty && !window.confirm('Discard unsaved workspace changes and open another project?'))
      return;
    await onOpenProject(directory);
  };
  const openExample = async () => {
    if (dirty && !window.confirm('Discard unsaved workspace changes and open the bundled example?'))
      return;
    await onOpenExample?.();
  };
  const recover = async () => {
    if (!bridge?.recoverWorkspace || !workspace || !stopped) return;
    setBusy(true);
    setError(null);
    try {
      install(await bridge.recoverWorkspace(workspace.hash));
      setNotice('The previous saved workspace was restored.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!bridge?.runScenario || !stopped) return;
    setRunning(true);
    onScenarioActivity?.(true);
    setReport(null);
    setError(null);
    setNotice(null);
    try {
      setReport(await bridge.runScenario(scenarioSource));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRunning(false);
      onScenarioActivity?.(false);
    }
  };
  const titles: Record<Surface, string> = {
    simulator: 'Project',
    'guild-editor': 'Guild Editor',
    'scenario-lab': 'Scenario Lab',
    'command-explorer': 'Command Explorer',
    'risk-center': 'Risk Center',
    settings: 'Settings',
  };
  const [selectedCommand, setSelectedCommand] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState('');
  const [commandResult, setCommandResult] = useState<DisRunnerInvocationResult | null>(null);
  const [attachmentNames, setAttachmentNames] = useState<Record<string, string>>({});
  const [attachmentPaths, setAttachmentPaths] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues({});
    setAttachmentNames({});
    setAttachmentPaths({});
    setCommandResult(null);
    setTarget('');
  }, [runtime.runId, root, context?.actorId, context?.guildId, context?.channelId]);
  const commands =
    (runtime as DisRunnerRuntimeState & { commands?: readonly Command[] }).commands ?? [];
  const choices = commandChoices(commands);
  const choice = choices.find((item) => item.label === selectedCommand) ?? choices[0];
  const createScenario = () => {
    if (!context) {
      setError('Open a project with a valid actor and channel before creating a scenario.');
      return;
    }
    const name = `scenario-${(workspace?.document?.scenarios.length ?? 0) + 1}`;
    setScenarioName(name);
    setScenarioFormat('json');
    setScenarioSource(
      JSON.stringify(
        {
          version: 2,
          name,
          execution: { kind: 'bot', project: '.', clock: 'realtime', timeoutMs: 10000 },
          context: { actor: context.actorId, guild: context.guildId, channel: context.channelId },
          steps:
            context.guildId === undefined
              ? [
                  { action: 'send-message', content: '!ping', saveAs: 'message' },
                  { action: 'await-message', content: 'Expected reply', timeoutMs: 3000 },
                ]
              : [
                  {
                    action: 'invoke-command',
                    command: choice?.command.name ?? 'ping',
                    saveAs: 'reply',
                  },
                ],
          assertions:
            context.guildId === undefined
              ? [
                  { type: 'message-content', channel: context.channelId, equals: 'Expected reply' },
                  { type: 'no-unexpected-error' },
                ]
              : [{ type: 'message-content', interaction: '${reply.id}', equals: 'Expected reply' }],
        },
        null,
        2,
      ),
    );
    setDirty(true);
    setNotice('Set the command and expected reply before running this scenario.');
  };
  const invoke = async (autocomplete = false) => {
    if (!choice || !canInvoke || context?.guildId === undefined) return;
    setError(null);
    try {
      if ((choice.command.type ?? 1) !== 1 && !target)
        throw new TypeError('Choose a target user or message ID.');
      const focused = choice.options.find((option) => option.autocomplete);
      let options: Record<string, unknown>[] = choice.options.flatMap((option) => {
        const text = values[option.name] ?? '';
        if (text === '' && !option.required && !(autocomplete && focused === option)) return [];
        if (text === '' && option.required && !autocomplete)
          throw new TypeError(`${option.name} is required.`);
        const value =
          option.type === 4 || option.type === 10
            ? Number(text)
            : option.type === 5
              ? text === 'true'
              : text;
        if (
          (option.type === 4 || option.type === 10) &&
          (!Number.isFinite(value) || (option.type === 4 && !Number.isSafeInteger(value)))
        )
          throw new TypeError(`${option.name} requires a valid number.`);
        if (
          typeof value === 'number' &&
          ((option.min_value !== undefined && value < option.min_value) ||
            (option.max_value !== undefined && value > option.max_value))
        )
          throw new TypeError(`${option.name} is outside the allowed numeric range.`);
        if (
          option.type === 3 &&
          typeof value === 'string' &&
          ((option.min_length !== undefined && value.length < option.min_length) ||
            (option.max_length !== undefined && value.length > option.max_length))
        )
          throw new TypeError(`${option.name} is outside the allowed text length.`);
        if (
          [6, 7, 8, 9, 11].includes(option.type) &&
          (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n)
        )
          throw new TypeError(`${option.name} requires a valid local resource ID.`);
        return [
          {
            name: option.name,
            type: option.type,
            value,
            ...(autocomplete && focused === option ? { focused: true } : {}),
          },
        ];
      });
      for (const branch of [...choice.path].reverse())
        options = [{ name: branch.name, type: branch.type, options }];
      setCommandResult(
        await onAction({
          type: autocomplete ? 'autocomplete' : 'command',
          name: choice.command.name,
          commandType: choice.command.type ?? 1,
          options,
          ...(target ? { targetId: target } : {}),
        }),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  return (
    <div className="feature-surface project-surface" hidden={hidden}>
      <header className="surface-header">
        <button
          aria-label="Back to simulator"
          className="surface-back"
          type="button"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <span className="surface-title-icon">
          <Braces size={20} />
        </span>
        <div>
          <div className="surface-title-row">
            <h1>{titles[surface]}</h1>
            {dirty && <span className="preview-label">Unsaved changes</span>}
          </div>
          <p>{runtime.project?.botName ?? 'Open a local bot project to begin.'}</p>
        </div>
        <div className="surface-header-actions">
          {['guild-editor', 'scenario-lab', 'settings'].includes(surface) && (
            <button
              className="primary-action"
              type="button"
              disabled={!dirty || !stopped || !writable || busy}
              onClick={() => void save()}
            >
              <Save size={15} />
              Save workspace
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="project-feedback danger-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="project-feedback" role="status">
          {notice}
        </p>
      )}
      {root && workspace === null && error === null && (
        <p className="project-feedback" role="status">
          Loading workspace…
        </p>
      )}
      {surface === 'settings' && (
        <section className="project-editor">
          <h2>Project</h2>
          <p>Choose a folder containing discord-simulator.config.json.</p>
          {root && <p>Project configuration loaded</p>}
          <div className="project-toolbar">
            <label className="project-path">
              Project directory
              <input
                aria-label="Project directory"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={
                !canSelect ||
                !projectPath.trim() ||
                busy ||
                running ||
                ['starting', 'running', 'stopping'].includes(runtime.phase)
              }
              onClick={() =>
                void changeProject(projectPath).catch((reason: unknown) =>
                  setError(errorMessage(reason)),
                )
              }
            >
              <FolderOpen size={15} />
              Open directory
            </button>
            <button
              type="button"
              disabled={
                !canSelect ||
                busy ||
                running ||
                ['starting', 'running', 'stopping'].includes(runtime.phase)
              }
              onClick={() =>
                void changeProject().catch((reason: unknown) => setError(errorMessage(reason)))
              }
            >
              Browse folders
            </button>
            <button
              type="button"
              disabled={!canSelect || !bridge?.openExample || running}
              onClick={() =>
                void openExample().catch((reason: unknown) => setError(errorMessage(reason)))
              }
            >
              Open bundled example
            </button>
          </div>
          {root && (
            <>
              <h2>Simulation defaults</h2>
              <div className="project-toolbar">
                <label>
                  Seed
                  <input
                    aria-label="Simulation seed"
                    inputMode="numeric"
                    value={seed}
                    onChange={(event) => {
                      setSeed(event.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <label>
                  Mode
                  <select
                    aria-label="Simulation mode"
                    value={mode}
                    onChange={(event) => {
                      setMode(event.target.value as 'strict' | 'lenient');
                      setDirty(true);
                    }}
                  >
                    <option value="strict">Strict</option>
                    <option value="lenient">Lenient</option>
                  </select>
                </label>
              </div>
              <p>
                Adapter: {runtime.project?.adapter}. Bot dependencies must be installed before
                running offline.
              </p>
              <p>Workspace: {workspace?.path ?? 'Loading…'}</p>
              <button type="button" disabled={busy} onClick={() => void load()}>
                <RotateCcw size={15} />
                Reload workspace
              </button>
              {workspace?.backupAvailable && (
                <button type="button" disabled={!stopped || busy} onClick={() => void recover()}>
                  Restore previous save
                </button>
              )}
            </>
          )}
        </section>
      )}
      {surface === 'guild-editor' && (
        <section className="project-editor">
          <h2>Fixture resources</h2>
          <p>
            Edit guilds, channels, roles, users, members and messages as JSON. IDs and references
            are validated when saving. Stop the bot before saving.
          </p>
          <div className="project-toolbar">
            <button
              type="button"
              disabled={history.length === 0}
              onClick={() => {
                setRedo(boundedHistory([...redo].reverse().concat(resources)).reverse());
                setResources(history[history.length - 1]!);
                setHistory(history.slice(0, -1));
                setDirty(true);
              }}
            >
              Undo
            </button>
            <button
              type="button"
              disabled={redo.length === 0}
              onClick={() => {
                setHistory(boundedHistory([...history, resources]));
                setResources(redo[0]!);
                setRedo(redo.slice(1));
                setDirty(true);
              }}
            >
              Redo
            </button>
            <button type="button" disabled={busy} onClick={() => void load()}>
              Reload saved resources
            </button>
          </div>
          <textarea
            aria-label="Fixture resources JSON"
            className="project-code"
            spellCheck={false}
            maxLength={8 * 1024 * 1024}
            value={resources}
            disabled={!writable}
            onChange={(event) => {
              setHistory(boundedHistory([...history, resources]));
              setRedo([]);
              setResources(event.target.value);
              setDirty(true);
            }}
          />
        </section>
      )}
      {surface === 'scenario-lab' && (
        <section className="project-editor">
          <h2>Saved scenarios</h2>
          <div className="project-toolbar">
            <button type="button" disabled={!context || running} onClick={createScenario}>
              New scenario template
            </button>
            <select
              aria-label="Saved scenario"
              value={scenarioName}
              onChange={(event) => {
                const scenario = workspace?.document?.scenarios.find(
                  (item) => item.name === event.target.value,
                );
                if (scenario) {
                  setScenarioName(scenario.name);
                  setScenarioSource(scenario.source);
                  setScenarioFormat(scenario.format);
                }
              }}
            >
              <option value="untitled">New scenario</option>
              {workspace?.document?.scenarios.map((scenario) => (
                <option key={scenario.name} value={scenario.name}>
                  {scenario.name}
                </option>
              ))}
            </select>
            <label>
              Name
              <input
                aria-label="Scenario name"
                value={scenarioName}
                onChange={(event) => {
                  setScenarioName(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label>
              Format
              <select
                aria-label="Scenario format"
                value={scenarioFormat}
                onChange={(event) => {
                  setScenarioFormat(event.target.value as 'json' | 'yaml');
                  setDirty(true);
                }}
              >
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
              </select>
            </label>
          </div>
          <p>
            Version 2 scenarios execute the real bot in a fresh session. Relative project paths
            start at this project directory.
          </p>
          <textarea
            className="project-code"
            aria-label="Scenario source"
            maxLength={262144}
            spellCheck={false}
            value={scenarioSource}
            onChange={(event) => {
              setScenarioSource(event.target.value);
              setDirty(true);
            }}
          />
          <div className="project-toolbar">
            <button
              className="primary-action"
              type="button"
              disabled={!stopped || busy || !scenarioSource.trim()}
              onClick={() => void run()}
            >
              <Play size={15} />
              Run scenario
            </button>
            <button
              type="button"
              disabled={!running}
              onClick={() =>
                void bridge
                  ?.cancelScenario?.()
                  .catch((reason: unknown) => setError(errorMessage(reason)))
              }
            >
              <Square size={15} />
              Cancel scenario
            </button>
            {(['json', 'junit', 'html', 'sarif'] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={!report || running || !bridge?.exportScenario}
                onClick={() =>
                  void bridge
                    ?.exportScenario?.(format)
                    .catch((reason: unknown) => setError(errorMessage(reason)))
                }
              >
                <Download size={15} />
                {format.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              disabled={!report || running || !bridge?.exportReproduction}
              onClick={() =>
                void bridge
                  ?.exportReproduction?.()
                  .catch((reason: unknown) => setError(errorMessage(reason)))
              }
            >
              <Download size={15} />
              Reproduction bundle
            </button>
          </div>
          <p>Includes scenario, fixtures and results. Use with the original Bot project.</p>
          {running && <p role="status">Scenario running…</p>}
          {report && (
            <section aria-label="Scenario result">
              <h2>{report.status}</h2>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </section>
          )}
        </section>
      )}
      {surface === 'command-explorer' && (
        <section className="project-editor">
          <h2>Registered commands</h2>
          {context?.guildId === undefined && (
            <p>
              Application commands are registered for servers. Use a text message in a direct
              message to test prefix commands.
            </p>
          )}
          {choices.length === 0 ? (
            <p>
              No application commands are registered in this session. Start the bot and sync its
              command registry.
            </p>
          ) : (
            <>
              <label>
                Command
                <select
                  aria-label="Registered command"
                  value={choice?.label ?? ''}
                  onChange={(event) => {
                    setSelectedCommand(event.target.value);
                    setValues({});
                    setTarget('');
                    setCommandResult(null);
                    setAttachmentNames({});
                  }}
                >
                  {choices.map((item) => (
                    <option key={`${item.command.type ?? 1}:${item.label}`} value={item.label}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p>{choice?.command.description}</p>
              {choice && (choice.command.type ?? 1) !== 1 && (
                <label>
                  Target ID
                  <input
                    aria-label="Command target ID"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                </label>
              )}
              {choice?.options.map((option) => (
                <label className="project-option" key={option.name}>
                  {option.name}
                  {option.required ? ' *' : ''}
                  <small>{option.description}</small>
                  {option.choices?.length ? (
                    <select
                      aria-label={option.name}
                      value={values[option.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [option.name]: event.target.value })
                      }
                    >
                      <option value="">Select a value</option>
                      {option.choices.map((item) => (
                        <option key={String(item.value)} value={String(item.value)}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  ) : option.type === 11 ? (
                    <div className="project-toolbar">
                      <input
                        aria-label={option.name}
                        value={attachmentPaths[option.name] ?? ''}
                        placeholder="Project-relative file path"
                        onChange={(event) =>
                          setAttachmentPaths({
                            ...attachmentPaths,
                            [option.name]: event.target.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        disabled={
                          !canInvoke ||
                          !context ||
                          !bridge?.importAttachment ||
                          !attachmentPaths[option.name]
                        }
                        onClick={() => {
                          if (!context) return;
                          void bridge
                            ?.importAttachment?.(attachmentPaths[option.name] ?? '', context)
                            .then((attachment) => {
                              setValues((current) => ({
                                ...current,
                                [option.name]: attachment.id,
                              }));
                              setAttachmentNames((current) => ({
                                ...current,
                                [option.name]: `${attachment.filename} (${attachment.size} bytes)`,
                              }));
                            })
                            .catch((reason: unknown) => setError(errorMessage(reason)));
                        }}
                      >
                        Use project file
                      </button>
                      <button
                        type="button"
                        disabled={!canInvoke || !context || !bridge?.pickAttachment}
                        onClick={() => {
                          if (!context) return;
                          void bridge
                            ?.pickAttachment?.(context)
                            .then((attachment) => {
                              if (attachment) {
                                setValues((current) => ({
                                  ...current,
                                  [option.name]: attachment.id,
                                }));
                                setAttachmentNames((current) => ({
                                  ...current,
                                  [option.name]: `${attachment.filename} (${attachment.size} bytes)`,
                                }));
                              }
                            })
                            .catch((reason: unknown) => setError(errorMessage(reason)));
                        }}
                      >
                        Choose local file
                      </button>
                      <small>Choose a file inside this project, up to 2 MiB.</small>
                      {attachmentNames[option.name] && (
                        <small>{attachmentNames[option.name]}</small>
                      )}
                    </div>
                  ) : option.type === 5 ? (
                    <select
                      aria-label={option.name}
                      value={values[option.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [option.name]: event.target.value })
                      }
                    >
                      <option value="">Select a value</option>
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </select>
                  ) : (
                    <input
                      aria-label={option.name}
                      value={values[option.name] ?? ''}
                      onChange={(event) =>
                        setValues({ ...values, [option.name]: event.target.value })
                      }
                    />
                  )}
                </label>
              ))}
              <div className="project-toolbar">
                <button
                  type="button"
                  className="primary-action"
                  disabled={!canInvoke || context?.guildId === undefined}
                  onClick={() => void invoke()}
                >
                  <Play size={15} />
                  Invoke command
                </button>
                {choice?.options.some((option) => option.autocomplete) && (
                  <button
                    type="button"
                    disabled={!canInvoke || context?.guildId === undefined}
                    onClick={() => void invoke(true)}
                  >
                    Get autocomplete choices
                  </button>
                )}
              </div>
              {commandResult && <pre>{JSON.stringify(commandResult.response, null, 2)}</pre>}
            </>
          )}
          {context && (
            <p>
              Actor {context.actorId} · channel {context.channelId}
            </p>
          )}
        </section>
      )}
      {surface === 'risk-center' && (
        <section className="project-editor">
          <h2>Run findings</h2>
          {runtime.evidenceComplete === false && (
            <p role="status">Log or trace limits were reached. Results may omit earlier events.</p>
          )}
          {runtime.risks.length === 0 ? (
            <p>No findings have been recorded for this run.</p>
          ) : (
            runtime.risks.map((risk, index) => (
              <article className={`risk-finding ${risk.severity}`} key={`${risk.ruleId}:${index}`}>
                <div>
                  <strong>
                    {risk.ruleId} · {risk.title}
                  </strong>
                  <p>{risk.evidence}</p>
                </div>
                <b>{risk.severity}</b>
              </article>
            ))
          )}
          <h2>Bot output</h2>
          <pre>
            {runtime.output.map((entry) => `[${entry.stream}] ${entry.text}`).join('\n') ||
              'No process output.'}
          </pre>
        </section>
      )}
    </div>
  );
}
