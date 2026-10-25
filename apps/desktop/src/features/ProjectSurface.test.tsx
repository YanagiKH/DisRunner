import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSurface } from './ProjectSurface';
import type { WorkspaceView } from '../state/project-workspace';

const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const snapshot: DisRunnerRuntimeState = {
  schemaVersion: 1,
  sessionId: 'session',
  runId: 'run',
  revision: 1,
  disposed: false,
  contexts: [context],
  phase: 'ready',
  project: {
    root: '/bots/project',
    configPath: '/bots/project/discord-simulator.config.json',
    botName: 'Example Bot',
    executable: 'node',
    args: ['bot.mjs'],
    cwd: '/bots/project',
    adapter: 'discord.js',
    mode: 'strict',
    seed: 42,
    environmentNames: [],
  },
  error: null,
  pid: null,
  endpoints: null,
  output: [],
  traces: [],
  risks: [],
};
const workspace: WorkspaceView = {
  status: 'ready',
  path: '/bots/project/.disrunner/workspace.json',
  hash: 'original-hash',
  version: 1,
  backupAvailable: true,
  error: null,
  document: {
    version: 1,
    resources: [{ id: '1000', resourceType: 'guild', name: 'My guild' }],
    scenarios: [],
    options: { seed: 42, mode: 'strict' },
  },
};
function bridge(overrides: Partial<DisRunnerDesktopBridge> = {}) {
  const value: DisRunnerDesktopBridge = {
    getRuntimeInfo: () =>
      Promise.resolve({ platform: 'linux', version: '1.0.0', packaged: true, offline: true }),
    getRuntimeState: () => Promise.resolve(snapshot),
    selectProject: () => Promise.resolve(snapshot),
    startRuntime: () => Promise.resolve(snapshot),
    stopRuntime: () => Promise.resolve({ ok: true, errors: [], snapshot }),
    invokeCommand: vi.fn(),
    onRuntimeState: () => () => undefined,
    controlWindow: () => Promise.resolve(true),
    getWorkspace: () => Promise.resolve(workspace),
    exportScenario: () => Promise.resolve(true),
    ...overrides,
  };
  Object.defineProperty(window, 'disrunnerDesktop', { value, configurable: true });
  return value;
}
const props = {
  hidden: false,
  runtime: snapshot,
  canInvoke: false,
  canSelect: true,
  context,
  onBack: vi.fn(),
  onOpenProject: vi.fn(),
  onAction: vi.fn(() => Promise.resolve(null)),
};
afterEach(() => {
  Reflect.deleteProperty(window, 'disrunnerDesktop');
  vi.restoreAllMocks();
});

describe('project workspace workflow', () => {
  it('saves fixture edits with the loaded hash and keeps writes disabled during a run', async () => {
    const saved = vi.fn<NonNullable<DisRunnerDesktopBridge['saveWorkspace']>>((document) =>
      Promise.resolve({
        ...workspace,
        hash: 'next-hash',
        document,
      }),
    );
    bridge({ saveWorkspace: saved });
    const user = userEvent.setup();
    const { rerender } = render(<ProjectSurface {...props} surface="guild-editor" />);
    const editor = await screen.findByRole('textbox', { name: 'Fixture resources JSON' });
    await waitFor(() =>
      expect(editor).toHaveValue(JSON.stringify(workspace.document?.resources, null, 2)),
    );
    fireEvent.change(editor, {
      target: { value: '[{"id":"1000","resourceType":"guild","name":"Changed"}]' },
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    rerender(
      <ProjectSurface
        {...props}
        runtime={{ ...snapshot, phase: 'running' }}
        surface="guild-editor"
      />,
    );
    expect(screen.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
    rerender(<ProjectSurface {...props} surface="guild-editor" />);
    await user.click(screen.getByRole('button', { name: 'Save workspace' }));
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [{ id: '1000', resourceType: 'guild', name: 'Changed' }],
      }),
      'original-hash',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace saved.');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
  it('preserves the draft and exposes an external change conflict instead of reporting a successful save', async () => {
    bridge({
      saveWorkspace: vi.fn(() =>
        Promise.reject(new Error('Workspace changed on disk. Reload before saving.')),
      ),
    });
    const user = userEvent.setup();
    render(<ProjectSurface {...props} surface="guild-editor" />);
    const editor = await screen.findByRole('textbox', { name: 'Fixture resources JSON' });
    await waitFor(() => expect(editor).not.toBeDisabled());
    fireEvent.change(editor, { target: { value: '[]' } });
    await user.click(screen.getByRole('button', { name: 'Save workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace changed on disk.');
    expect(editor).toHaveValue('[]');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText(/Workspace saved/)).not.toBeInTheDocument();
  });
  it('builds typed nested command options and invokes the actual selected registry command', async () => {
    bridge();
    const onAction = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    render(
      <ProjectSurface
        {...props}
        canInvoke
        runtime={{
          ...snapshot,
          commands: [
            {
              id: '1',
              name: 'admin',
              type: 1,
              options: [
                {
                  type: 2,
                  name: 'users',
                  options: [
                    {
                      type: 1,
                      name: 'set',
                      options: [
                        { type: 4, name: 'count', required: true },
                        { type: 5, name: 'enabled', required: true },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        onAction={onAction}
        surface="command-explorer"
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'count' }), { target: { value: '17' } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'enabled' }), 'true');
    await user.click(screen.getByRole('button', { name: 'Invoke command' }));
    expect(onAction).toHaveBeenCalledWith({
      type: 'command',
      name: 'admin',
      commandType: 1,
      options: [
        {
          name: 'users',
          type: 2,
          options: [
            {
              name: 'set',
              type: 1,
              options: [
                { name: 'count', type: 4, value: 17 },
                { name: 'enabled', type: 5, value: true },
              ],
            },
          ],
        },
      ],
    });
  });
  it('does not convert cancellation into a completed scenario before cleanup finishes', async () => {
    let finish!: (value: {
      status: string;
      exitCode: number;
      name: string;
      runId: null;
      assertions: never[];
      issues: never[];
    }) => void;
    const runScenario = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<DisRunnerDesktopBridge['runScenario']>>>>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const cancelScenario = vi.fn(() => Promise.resolve(true));
    bridge({ runScenario, cancelScenario });
    const user = userEvent.setup();
    render(<ProjectSurface {...props} surface="scenario-lab" />);
    await act(async () => {
      await Promise.resolve();
    });
    const editor = screen.getByRole('textbox', { name: 'Scenario source' });
    fireEvent.change(editor, { target: { value: '{"version":2}' } });
    await user.click(screen.getByRole('button', { name: 'Run scenario' }));
    expect(screen.getByRole('status')).toHaveTextContent('Scenario running…');
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel scenario' }));
    expect(cancelScenario).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region', { name: 'Scenario result' })).not.toBeInTheDocument();
    await act(async () => {
      finish({
        status: 'cancelled',
        exitCode: 130,
        name: 'Example',
        runId: null,
        assertions: [],
        issues: [],
      });
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'cancelled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeEnabled();
  });
  it('imports a project attachment and sends its local ID as the typed command option', async () => {
    const pickAttachment = vi.fn(() =>
      Promise.resolve({
        id: '8001',
        filename: 'example.txt',
        size: 12,
        content_type: 'text/plain',
        url: 'http://127.0.0.1:1234/attachments/8001',
        proxy_url: 'http://127.0.0.1:1234/attachments/8001',
        sha256: 'a'.repeat(64),
      }),
    );
    bridge({ pickAttachment });
    const onAction = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    render(
      <ProjectSurface
        {...props}
        canInvoke
        onAction={onAction}
        runtime={{
          ...snapshot,
          commands: [
            { name: 'upload', type: 1, options: [{ name: 'file', type: 11, required: true }] },
          ],
        }}
        surface="command-explorer"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Choose local file' }));
    expect(pickAttachment).toHaveBeenCalledExactlyOnceWith(context);
    expect(await screen.findByText('example.txt (12 bytes)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invoke command' }));
    expect(onAction).toHaveBeenCalledWith({
      type: 'command',
      name: 'upload',
      commandType: 1,
      options: [{ name: 'file', type: 11, value: '8001' }],
    });
  });
});
