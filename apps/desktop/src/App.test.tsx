import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import stylesheet from './styles.css?raw';

describe('DisRunner desktop shell', () => {
  it('starts the bot and executes an ephemeral slash command from the composer', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Start bot' }));
    expect(screen.getByText('Running')).toBeInTheDocument();

    const composer = screen.getByRole('textbox', { name: 'Message #bot-testing' });
    await user.type(composer, '/secret{Enter}');

    expect(screen.getAllByText('Only you can see this.').length).toBeGreaterThan(1);
    expect(screen.getByRole('tab', { name: 'Payload' })).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates to a full workspace surface and back to the simulator', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Risk Center' }));
    expect(screen.getByRole('heading', { name: 'Risk Center' })).toBeInTheDocument();
    expect(screen.getByText('INTERACTION_TIMEOUT')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to simulator' }));
    expect(screen.getByRole('main', { name: 'Virtual channel bot-testing' })).toBeInTheDocument();
  });

  it('labels sample evidence and disables controls that cannot persist or execute', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText('Visual preview shell')).toBeInTheDocument();
    expect(screen.getByText('Visual preview · sample panels')).toBeInTheDocument();
    expect(screen.queryByText('Live', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile preview · Strict' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Virtual time playback unavailable' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Guild Editor' }));
    expect(screen.getByRole('button', { name: 'Save unavailable' })).toBeDisabled();
    expect(screen.getByText('Sample data')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Scenario Lab' }));
    expect(screen.getByRole('button', { name: 'Run unavailable' })).toBeDisabled();
    expect(screen.getByText('No scenario has run in this screen')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Command Explorer' }));
    expect(screen.getByRole('button', { name: 'Invoke selected name' })).toBeDisabled();
    expect(screen.getByText('Sample · Guild · v4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Risk Center' }));
    expect(screen.getByRole('button', { name: 'Export unavailable' })).toBeDisabled();
    expect(screen.getByText('Sample findings')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Persistence unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable Audit blocked requests' })).toBeDisabled();
  });
});

const context = { actorId: '3000', guildId: '1000', channelId: '2000' };
const snapshot: DisRunnerRuntimeState = {
  schemaVersion: 1,
  sessionId: 'session-1',
  runId: 'run-1',
  revision: 1,
  disposed: false,
  contexts: [context, { ...context, channelId: '2100' }],
  phase: 'running',
  project: null,
  error: null,
  pid: 123,
  endpoints: null,
  output: [],
  traces: [],
  risks: [],
};

function installBridge(
  invokeCommand: DisRunnerDesktopBridge['invokeCommand'],
  overrides: Partial<DisRunnerDesktopBridge> = {},
) {
  const bridge: DisRunnerDesktopBridge = {
    getRuntimeInfo: () =>
      Promise.resolve({
        platform: 'linux',
        version: 'test',
        packaged: false,
        offline: true,
      }),
    getRuntimeState: () => Promise.resolve(structuredClone(snapshot)),
    selectProject: () => Promise.resolve(structuredClone(snapshot)),
    startRuntime: () => Promise.resolve(structuredClone(snapshot)),
    stopRuntime: () =>
      Promise.resolve({ ok: true, errors: [], snapshot: { ...snapshot, phase: 'ready' } }),
    invokeCommand,
    onRuntimeState: () => () => {},
    controlWindow: () => Promise.resolve(true),
    ...overrides,
  };
  Object.defineProperty(window, 'disrunnerDesktop', { configurable: true, value: bridge });
}

describe('captured project runtime context', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
  });

  it('submits real non-first project IDs and keeps callbacks diagnostic, never feed rows', async () => {
    let finish!: (result: DisRunnerInvocationResult) => void;
    const invoke = vi.fn(
      (_request: DisRunnerInvocationRequest) =>
        new Promise<DisRunnerInvocationResult>((resolve) => {
          expect(_request.input).toBe('/ping');
          finish = resolve;
        }),
    );
    installBridge(invoke);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Message #2000' });
    await user.click(screen.getByRole('button', { name: '2100' }));
    await user.type(screen.getByRole('textbox', { name: 'Message #2100' }), '/ping{Enter}');
    const request = invoke.mock.calls[0]?.[0] as unknown as DisRunnerInvocationRequest;
    expect(request).toMatchObject({
      runId: 'run-1',
      input: '/ping',
      context: { ...context, channelId: '2100' },
    });
    await user.click(screen.getByRole('button', { name: '2000' }));
    await act(async () => {
      finish({
        ...request,
        ok: true,
        command: 'ping',
        interactionId: 'interaction-1',
        durationMs: 4,
        response: { type: 'message', data: { content: 'Observed callback' } },
        error: null,
      });
      await Promise.resolve();
    });
    expect(
      within(screen.getByRole('main')).queryByText('Observed callback'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '2100' }));
    expect(
      within(screen.getByRole('main')).queryByText('Observed callback'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Pong!  ·  123ms')).not.toBeInTheDocument();
  });

  it('shows rejected runtime calls without fabricating preview responses', async () => {
    installBridge(() => Promise.reject(new Error('Authenticated peer failed')));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    expect(await screen.findByText('Authenticated peer failed')).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).queryByText('Authenticated peer failed'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Pong!  ·  123ms')).not.toBeInTheDocument();
  });
  it('rejects an old reply while a new-run snapshot is still being recovered', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    let finish!: (result: DisRunnerInvocationResult) => void;
    let request!: DisRunnerInvocationRequest;
    const getState = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockImplementation(() => new Promise(() => {}));
    installBridge(
      (value) => {
        request = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      {
        getRuntimeState: getState,
        onRuntimeState: (callback) => {
          listener = callback;
          return () => {};
        },
      },
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    await act(async () => {
      listener({
        schemaVersion: 1,
        sessionId: 'session-1',
        runId: 'run-2',
        sequence: 4,
        kind: 'snapshot',
        snapshot: { ...snapshot, runId: 'run-2', revision: 4 },
      });
      finish({
        ...request,
        ok: true,
        command: 'ping',
        interactionId: 'old',
        durationMs: 1,
        response: { type: 'message', data: { content: 'Stale callback' } },
        error: null,
      });
      await Promise.resolve();
    });
    expect(getState).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Stale callback')).not.toBeInTheDocument();
  });

  it('uses distinct request IDs after remounting the renderer in the same run', async () => {
    const requests: DisRunnerInvocationRequest[] = [];
    installBridge((request) => {
      requests.push(request);
      return Promise.reject(new Error('No callback'));
    });
    const user = userEvent.setup();
    const first = render(<App />);
    await user.type(await screen.findByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    first.unmount();
    render(<App />);
    await user.type(await screen.findByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    expect(requests[1]?.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
  });
});

const project: DisRunnerProjectSummary = {
  root: '/project',
  configPath: '/project/config.json',
  botName: 'TestBot',
  executable: 'node',
  args: [],
  cwd: '/project',
  adapter: 'raw',
  mode: 'strict',
  seed: 1,
  environmentNames: [],
};

describe('runtime cleanup recovery', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
  });

  function recoveryBridge(initial: DisRunnerRuntimeState = { ...snapshot, project }) {
    let current = initial;
    let listener!: (event: DisRunnerSessionEvent) => void;
    const start = vi.fn(() => Promise.resolve(current));
    const stop = vi.fn<DisRunnerDesktopBridge['stopRuntime']>();
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve(current),
      startRuntime: start,
      stopRuntime: stop,
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    return {
      start,
      stop,
      emit: async (next: DisRunnerRuntimeState) => {
        current = next;
        await act(async () => {
          await Promise.resolve();
          listener({
            schemaVersion: 1,
            sessionId: next.sessionId,
            runId: next.runId,
            sequence: next.revision,
            kind: 'snapshot',
            snapshot: next,
          });
        });
      },
    };
  }

  it('never announces stopped on failure, blocks duplicate stop/keyboard start, and permits verified recovery', async () => {
    const bridge = recoveryBridge();
    let finish!: (result: Awaited<ReturnType<DisRunnerDesktopBridge['stopRuntime']>>) => void;
    bridge.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    await bridge.emit({ ...snapshot, project, revision: 2, phase: 'stopping' });
    await user.keyboard('{Control>}b{/Control}');
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('TestBot stopped')).not.toBeInTheDocument();
    const failed = {
      ...snapshot,
      project,
      revision: 3,
      phase: 'error' as const,
      pid: null,
      error: 'Runtime shutdown failed.',
    };
    await bridge.emit(failed);
    await act(async () => {
      await Promise.resolve();
      finish({
        ok: false,
        errors: [{ code: 'cleanup', message: 'REST closure could not be confirmed.' }],
        snapshot: failed,
      });
    });
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('REST closure could not be confirmed.');
    expect(screen.queryByText('TestBot stopped')).not.toBeInTheDocument();
    bridge.stop.mockResolvedValueOnce({ ok: false, errors: [], snapshot: failed });
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Session cleanup did not confirm success.');
    bridge.stop.mockResolvedValueOnce({
      ok: true,
      errors: [],
      snapshot: { ...failed, revision: 4, phase: 'ready', error: null },
    });
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Runtime cleanup completed.')).toBeInTheDocument();
  });

  it('preserves uncertainty after IPC rejection and labels loaded configuration separately', async () => {
    const bridge = recoveryBridge();
    bridge.stop.mockRejectedValueOnce(new Error('private transport detail'));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Runtime shutdown could not be confirmed.');
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Project configuration loaded')).toBeInTheDocument();
    expect(screen.queryByText('Configuration error')).not.toBeInTheDocument();
  });

  it('does not apply an old stop result to a replaced run', async () => {
    const bridge = recoveryBridge();
    let finish!: (result: Awaited<ReturnType<DisRunnerDesktopBridge['stopRuntime']>>) => void;
    bridge.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    await bridge.emit({
      ...snapshot,
      project,
      runId: 'new-run',
      revision: 5,
      phase: 'error',
      error: 'New run failed.',
    });
    await act(async () => {
      await Promise.resolve();
      finish({
        ok: true,
        errors: [],
        snapshot: { ...snapshot, project, phase: 'ready', revision: 4 },
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('New run failed.');
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(screen.queryByText('Runtime cleanup completed.')).not.toBeInTheDocument();
  });

  it('keeps disposed sessions disabled after child-exited-only cleanup', async () => {
    const bridge = recoveryBridge({ ...snapshot, project, disposed: true, phase: 'error' });
    bridge.stop.mockResolvedValueOnce({
      ok: false,
      errors: [{ code: 'child-exited', message: 'Bot process exited unexpectedly.' }],
      snapshot: { ...snapshot, project, disposed: true, phase: 'ready', revision: 2 },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Retry cleanup' }));
    expect(
      screen.getByText('Runtime cleanup completed. The bot had exited unexpectedly.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    await user.keyboard('{Control>}b{/Control}');
    expect(bridge.start).not.toHaveBeenCalled();
  });
  it('blocks Send, Enter, explorer and Browse while cleanup is unconfirmed', async () => {
    const invoke = vi.fn();
    installBridge(invoke, {
      getRuntimeState: () => Promise.resolve({ ...snapshot, project }),
      stopRuntime: () => Promise.reject(new Error('IPC failure')),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    await user.type(screen.getByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message #2000' })).toHaveValue('/ping');
    expect(screen.getByRole('button', { name: 'Send local event' })).toBeDisabled();
    expect(
      screen.getByText('Complete runtime recovery before invoking commands.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Command Explorer' }));
    expect(screen.getByRole('button', { name: 'Invoke selected name' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Runtime paths' }));
    expect(screen.getByRole('button', { name: 'Browse' })).toBeDisabled();
  });

  it('offers explicit refresh after failed resync and then permits safe startup cancellation', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    let rejectStart!: (reason: Error) => void;
    const starting = {
      ...snapshot,
      project,
      runId: 'new-run',
      revision: 2,
      phase: 'starting' as const,
    };
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot, project, runId: null, phase: 'ready' })
      .mockRejectedValueOnce(new Error('Refresh failed'))
      .mockResolvedValueOnce(starting);
    const stop = vi.fn<DisRunnerDesktopBridge['stopRuntime']>().mockResolvedValueOnce({
      ok: true,
      errors: [],
      snapshot: { ...starting, revision: 4, phase: 'ready' },
    });
    const start = vi.fn(
      () =>
        new Promise<DisRunnerRuntimeState>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    installBridge(vi.fn(), {
      getRuntimeState: getState,
      startRuntime: start,
      stopRuntime: stop,
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start bot' }));
    await act(async () => {
      await Promise.resolve();
      listener({
        schemaVersion: 1,
        sessionId: starting.sessionId,
        runId: starting.runId,
        sequence: 2,
        kind: 'snapshot',
        snapshot: starting,
      });
    });
    expect(await screen.findByRole('button', { name: 'Refresh runtime status' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(stop).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Refresh runtime status' }));
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    await act(async () => {
      await Promise.resolve();
      rejectStart(new Error('Startup cancelled'));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  });

  it('does not strand initial status failure behind an unknown session identity', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce({ ...snapshot, project, phase: 'ready' });
    installBridge(vi.fn(), { getRuntimeState: getState });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Refresh runtime status' }));
    expect(getState).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  });
  it.each(['before', 'after'] as const)(
    'retains primary startup failure %s overlapping cleanup succeeds without blocking restart',
    async (order) => {
      let listener!: (event: DisRunnerSessionEvent) => void;
      let rejectStart!: (reason: Error) => void;
      let finishStop!: (value: Awaited<ReturnType<DisRunnerDesktopBridge['stopRuntime']>>) => void;
      const ready = { ...snapshot, project, runId: null, phase: 'ready' as const };
      const starting = {
        ...snapshot,
        project,
        runId: 'failing-run',
        revision: 2,
        phase: 'starting' as const,
      };
      let current: DisRunnerRuntimeState = ready;
      installBridge(vi.fn(), {
        getRuntimeState: () => Promise.resolve(current),
        startRuntime: () =>
          new Promise((_resolve, reject) => {
            rejectStart = reject;
          }),
        stopRuntime: () =>
          new Promise((resolve) => {
            finishStop = resolve;
          }),
        onRuntimeState: (value) => {
          listener = value;
          return () => {};
        },
      });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: 'Start bot' }));
      await act(async () => {
        current = starting;
        listener({
          schemaVersion: 1,
          sessionId: starting.sessionId,
          runId: starting.runId,
          sequence: 2,
          kind: 'snapshot',
          snapshot: starting,
        });
        await Promise.resolve();
      });
      await user.click(screen.getByRole('button', { name: 'Stop bot' }));
      if (order === 'before')
        await act(async () => {
          rejectStart(new Error('Primary startup transport failure.'));
          await Promise.resolve();
        });
      await act(async () => {
        finishStop({
          ok: true,
          errors: [],
          snapshot: { ...starting, revision: 4, phase: 'ready' },
        });
        await Promise.resolve();
      });
      if (order === 'after')
        await act(async () => {
          rejectStart(new Error('Primary startup transport failure.'));
          await Promise.resolve();
        });
      expect(screen.getByRole('status', { name: 'Startup outcome' })).toHaveTextContent(
        'Primary startup transport failure.',
      );
      expect(screen.getByText('Runtime cleanup completed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('never attributes a superseded startup failure to a replacement run', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    let rejectStart!: (reason: Error) => void;
    const starting = {
      ...snapshot,
      project,
      runId: 'old-start',
      revision: 2,
      phase: 'starting' as const,
    };
    let current: DisRunnerRuntimeState = { ...snapshot, project, runId: null, phase: 'ready' };
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve(current),
      startRuntime: () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
      stopRuntime: () =>
        Promise.resolve({
          ok: true,
          errors: [],
          snapshot: { ...starting, phase: 'ready', revision: 3 },
        }),
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start bot' }));
    await act(async () => {
      current = starting;
      listener({
        schemaVersion: 1,
        sessionId: current.sessionId,
        runId: current.runId,
        sequence: current.revision,
        kind: 'snapshot',
        snapshot: current,
      });
      await Promise.resolve();
    });
    await user.click(screen.getByRole('button', { name: 'Stop bot' }));
    await act(async () => {
      current = { ...starting, runId: 'replacement', phase: 'running', revision: 5 };
      listener({
        schemaVersion: 1,
        sessionId: current.sessionId,
        runId: current.runId,
        sequence: current.revision,
        kind: 'snapshot',
        snapshot: current,
      });
      await Promise.resolve();
    });
    await act(async () => {
      rejectStart(new Error('Old primary startup failure.'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('status', { name: 'Startup outcome' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Old primary startup failure/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop bot' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
  });
  it('preserves an already observed startup failure after later cleanup succeeds', async () => {
    const ready = { ...snapshot, project, phase: 'ready' as const };
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve(ready),
      startRuntime: () => Promise.reject(new Error('Observed primary startup failure.')),
      stopRuntime: () =>
        Promise.resolve({ ok: true, errors: [], snapshot: { ...ready, revision: 2 } }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start bot' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Observed primary startup failure.');
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(screen.getByRole('status', { name: 'Startup outcome' })).toHaveTextContent(
      'Observed primary startup failure.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  });
  it.each([
    ['run', false],
    ['run', true],
    ['session', false],
    ['session', true],
  ] as const)(
    'rejects old startup history when replacement %s arrives before rejection (stop=%s)',
    async (replacement, stopAfterReplacement) => {
      let listener!: (event: DisRunnerSessionEvent) => void;
      let rejectStart!: (reason: Error) => void;
      const starting = {
        ...snapshot,
        project,
        runId: 'original-start',
        revision: 2,
        phase: 'starting' as const,
      };
      let current: DisRunnerRuntimeState = { ...snapshot, project, runId: null, phase: 'ready' };
      installBridge(vi.fn(), {
        getRuntimeState: () => Promise.resolve(current),
        startRuntime: () =>
          new Promise((_resolve, reject) => {
            rejectStart = reject;
          }),
        stopRuntime: () =>
          Promise.resolve({
            ok: true,
            errors: [],
            snapshot: { ...current, phase: 'ready', revision: current.revision + 1 },
          }),
        onRuntimeState: (value) => {
          listener = value;
          return () => {};
        },
      });
      const emit = async (next: DisRunnerRuntimeState) => {
        current = next;
        await act(async () => {
          listener({
            schemaVersion: 1,
            sessionId: next.sessionId,
            runId: next.runId,
            sequence: next.revision,
            kind: 'snapshot',
            snapshot: next,
          });
          await Promise.resolve();
        });
      };
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: 'Start bot' }));
      await emit(starting);
      await emit({
        ...starting,
        sessionId: replacement === 'session' ? 'replacement-session' : starting.sessionId,
        runId: 'replacement-run',
        revision: 5,
        phase: 'running',
      });
      if (stopAfterReplacement) await user.click(screen.getByRole('button', { name: 'Stop bot' }));
      await act(async () => {
        rejectStart(new Error('Failure from original start.'));
        await Promise.resolve();
      });
      expect(screen.queryByRole('status', { name: 'Startup outcome' })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Failure from original start/u)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start bot' }))[
        stopAfterReplacement ? 'toBeEnabled' : 'toBeDisabled'
      ]();
    },
  );
  it('retains primary failure while its observed startup snapshot is still resynchronizing', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    let rejectStart!: (reason: Error) => void;
    let finishRefresh!: (value: DisRunnerRuntimeState) => void;
    const starting = {
      ...snapshot,
      project,
      runId: 'fast-failure',
      revision: 2,
      phase: 'starting' as const,
    };
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot, project, runId: null, phase: 'ready' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
    installBridge(vi.fn(), {
      getRuntimeState: getState,
      startRuntime: () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
      stopRuntime: () =>
        Promise.resolve({
          ok: true,
          errors: [],
          snapshot: { ...starting, phase: 'ready', revision: 4 },
        }),
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start bot' }));
    await act(async () => {
      listener({
        schemaVersion: 1,
        sessionId: starting.sessionId,
        runId: starting.runId,
        sequence: 2,
        kind: 'snapshot',
        snapshot: starting,
      });
      await Promise.resolve();
    });
    await act(async () => {
      rejectStart(new Error('Fast primary startup failure.'));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    await act(async () => {
      finishRefresh({
        ...starting,
        phase: 'error',
        revision: 3,
        error: 'Startup and cleanup failed.',
      });
      await Promise.resolve();
    });
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(screen.getByRole('status', { name: 'Startup outcome' })).toHaveTextContent(
      'Fast primary startup failure.',
    );
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  });
});

describe('runtime panel presentation regressions', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
  });

  it('groups strip and context before main and hides empty recovery instead of assigning it a grid row', async () => {
    installBridge(vi.fn());
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Message #2000' });
    const panel = screen.getByRole('region', { name: 'Runtime status and controls' });
    expect(panel).toContainElement(
      screen.getByRole('region', { name: 'Local bot runtime status' }),
    );
    expect(panel).toContainElement(
      screen.getByRole('region', { name: 'Runtime invocation context' }),
    );
    const recovery = container.querySelector('#runtime-recovery');
    expect(recovery).toHaveAttribute('hidden');
    expect(recovery).not.toBeVisible();
    expect(panel.nextElementSibling).toHaveClass('app-main');
    expect(
      [...container.querySelector('.app-shell')!.children].map((element) => element.className),
    ).toEqual(['top-bar', 'runtime-panel', 'app-main ']);
    const actor = screen.getByRole('combobox', { name: 'Invocation actor' });
    expect(actor.closest('label')).toHaveClass('runtime-actor');
    expect(actor).toBeEnabled();
  });

  it('retains the three-region browser-preview layout without desktop context', () => {
    const { container } = render(<App />);
    const panel = screen.getByRole('region', { name: 'Runtime status and controls' });
    expect(panel.children).toHaveLength(1);
    expect(container.querySelector('#runtime-recovery')).not.toBeInTheDocument();
    expect(panel.nextElementSibling).toHaveClass('app-main');
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeEnabled();
  });

  it('clears prior cleanup success as soon as new selection starts and keeps the new error readable', async () => {
    let rejectSelection!: (reason: Error) => void;
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve({ ...snapshot, project }),
      stopRuntime: () =>
        Promise.resolve({
          ok: true,
          errors: [],
          snapshot: { ...snapshot, project, phase: 'ready', revision: 2 },
        }),
      selectProject: () =>
        new Promise((_resolve, reject) => {
          rejectSelection = reject;
        }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    expect(screen.getByText('Runtime cleanup completed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Runtime paths' }));
    await user.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.queryByText('Runtime cleanup completed.')).not.toBeInTheDocument();
    await act(async () => {
      rejectSelection(new Error('Missing executable'));
      await Promise.resolve();
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('runtime-recovery-alert');
    expect(alert.querySelector('strong')).toHaveTextContent('Runtime recovery required.');
    expect(alert.querySelector('.runtime-diagnostic')).toHaveTextContent(
      'Project selection failed.',
    );
    expect(alert.querySelectorAll('p')).toHaveLength(2);
    expect(screen.queryByText('Runtime cleanup completed.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeEnabled();
  });

  it('removes old cleanup success on a later error snapshot without changing recovery controls', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve({ ...snapshot, project }),
      stopRuntime: () =>
        Promise.resolve({
          ok: true,
          errors: [],
          snapshot: { ...snapshot, project, phase: 'ready', revision: 2 },
        }),
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop bot' }));
    expect(screen.getByText('Runtime cleanup completed.')).toBeInTheDocument();
    await act(async () => {
      listener({
        schemaVersion: 1,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        sequence: 3,
        kind: 'snapshot',
        snapshot: {
          ...snapshot,
          project,
          phase: 'error',
          revision: 3,
          error: 'New runtime failure.',
        },
      });
      await Promise.resolve();
    });
    expect(screen.queryByText('Runtime cleanup completed.')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('New runtime failure.');
    expect(screen.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry cleanup' })).toBeEnabled();
  });
});

// DOM tests assert ownership and focus() attempts, not native disabled-button blur
// or rendered geometry. Those observations belong to the packaged G1 harness.
describe('responsive recovery ownership', () => {
  const originalWidth = window.innerWidth;
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    vi.restoreAllMocks();
  });
  async function resize(width: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    await act(() => window.dispatchEvent(new Event('resize')));
  }
  async function recovery(phase: 'error' | 'running' = 'error', shortcut = false) {
    let current: DisRunnerRuntimeState = {
      ...snapshot,
      project,
      phase,
      error: phase === 'error' ? 'Owned child exited' : null,
    };
    let resolve!: (result: Awaited<ReturnType<DisRunnerDesktopBridge['stopRuntime']>>) => void;
    let reject!: (error: Error) => void;
    let listener!: (event: DisRunnerSessionEvent) => void;
    let stopPromise!: Promise<Awaited<ReturnType<DisRunnerDesktopBridge['stopRuntime']>>>;
    const stateReads: Promise<DisRunnerRuntimeState>[] = [];
    const stop = vi.fn(() => {
      stopPromise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return stopPromise;
    });
    const invoke = vi.fn();
    installBridge(invoke, {
      getRuntimeState: () => {
        const read = Promise.resolve(current);
        stateReads.push(read);
        return read;
      },
      stopRuntime: stop,
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    render(<App />);
    const button = await screen.findByRole('button', {
      name: phase === 'error' ? 'Retry cleanup' : 'Stop bot',
    });
    const user = userEvent.setup();
    if (shortcut) {
      screen.getByRole('textbox', { name: 'Message #2000' }).focus();
      await user.keyboard('{Control>}b{/Control}');
    } else await user.click(button);
    const start = screen.getByRole('button', { name: 'Start bot' });
    const close = screen.getByRole('button', { name: 'Close window' });
    const startFocus = vi.spyOn(start, 'focus');
    const retryFocus = vi.spyOn(button, 'focus');
    const closeFocus = vi.spyOn(close, 'focus');
    return {
      user,
      button,
      start,
      close,
      stop,
      invoke,
      startFocus,
      retryFocus,
      closeFocus,
      noRestore() {
        expect(startFocus).not.toHaveBeenCalled();
        expect(retryFocus).not.toHaveBeenCalled();
        expect(closeFocus).not.toHaveBeenCalled();
      },
      async finish(ok = true, changes: Partial<DisRunnerRuntimeState> = {}) {
        await act(async () => {
          resolve({
            ok,
            errors: [],
            snapshot: {
              ...current,
              phase: ok ? 'ready' : 'error',
              error: ok ? null : 'Still owned',
              revision: 2,
              ...changes,
            },
          });
          await stopPromise;
        });
      },
      async reject() {
        await act(async () => {
          reject(new Error('IPC rejected'));
          await stopPromise.catch(() => undefined);
        });
      },
      async emit(changes: Partial<DisRunnerRuntimeState>, sequence = 2) {
        current = { ...current, ...changes };
        await act(async () => {
          const previousReads = stateReads.length;
          listener({
            schemaVersion: 1,
            kind: 'snapshot',
            sessionId: current.sessionId,
            runId: current.runId,
            sequence,
            snapshot: current,
          });
          for (const read of stateReads.slice(previousReads)) await read;
        });
      },
    };
  }
  it('collapses compact inspector and keeps explicit expansion through runtime updates', async () => {
    await resize(720);
    const r = await recovery();
    const disclosure = screen.getByRole('button', { name: 'Expand inspector' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById(disclosure.getAttribute('aria-controls')!);
    expect(panel).toHaveAttribute('hidden');
    expect(screen.queryByRole('tab', { name: 'Trace' })).not.toBeInTheDocument();
    await r.user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    await r.emit({ revision: 2 });
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message #2000' })).toBeInTheDocument();
  });
  it('preserves focused inspector on entry to compact and hands disclosure focus back on widening', async () => {
    await resize(1400);
    render(<App />);
    const trace = screen.getByRole('tab', { name: 'Trace' });
    trace.focus();
    await resize(720);
    expect(trace).toHaveFocus();
    const disclosure = screen.getByRole('button', { name: 'Collapse inspector' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    disclosure.focus();
    await resize(1400);
    expect(trace).toHaveFocus();
    expect(screen.queryByRole('button', { name: /inspector$/ })).not.toBeInTheDocument();
  });
  it('exposes one persistent atomic phase status without announcing output tails', async () => {
    const r = await recovery();
    const region = screen.getByRole('status', { name: 'Runtime phase' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    for (const [index, phase] of (
      ['idle', 'ready', 'starting', 'running', 'stopping', 'error'] as const
    ).entries()) {
      await r.emit(
        {
          phase,
          revision: index + 2,
          output: [{ stream: 'stdout', text: 'DISTINCTIVE_PRIVATE_OUTPUT', atMs: 1 }],
        },
        index + 2,
      );
      expect(screen.getByRole('status', { name: 'Runtime phase' })).toBe(region);
      expect(region).toHaveTextContent(phase);
      expect(region).not.toHaveTextContent('DISTINCTIVE_PRIVATE_OUTPUT');
    }
    expect(document.querySelector('.run-indicator')).not.toHaveAttribute('aria-live');
  });
  it.each(['success', 'failure', 'rejection'] as const)(
    'restores focused accepted Retry after %s',
    async (outcome) => {
      const r = await recovery();
      expect(r.button).toBeDisabled();
      expect(r.start).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send local event' })).toBeDisabled();
      expect(screen.getByText('Checking runtime cleanup…')).toHaveAttribute('role', 'status');
      await r.user.click(r.button);
      expect(r.stop).toHaveBeenCalledTimes(1);
      if (outcome === 'rejection') await r.reject();
      else await r.finish(outcome === 'success');
      expect(outcome === 'success' ? r.startFocus : r.retryFocus).toHaveBeenCalledTimes(1);
      expect(outcome === 'success' ? r.start : r.button).toBeEnabled();
    },
  );
  it.each(['pointermove', 'body-focus'] as const)(
    'retains owned intent across incidental %s',
    async (kind) => {
      const r = await recovery();
      if (kind === 'pointermove')
        document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
      else document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await r.finish();
      expect(r.startFocus).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['tab', 'pointer', 'body-pointer', 'away-body', 'blur'] as const)(
    'never restores after deliberate %s',
    async (kind) => {
      const r = await recovery();
      if (kind === 'tab') await r.user.tab();
      if (kind === 'pointer') r.close.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      if (kind === 'body-pointer')
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      if (kind === 'away-body') {
        r.close.focus();
        r.close.blur();
        expect(document.activeElement).toBe(document.body);
        r.closeFocus.mockClear();
        document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      }
      if (kind === 'blur') window.dispatchEvent(new Event('blur'));
      // Exclude the user's own native movement from attempted-restoration counts.
      r.startFocus.mockClear();
      r.retryFocus.mockClear();
      r.closeFocus.mockClear();
      await r.finish();
      r.noRestore();
    },
  );
  it('does not attach Retry focus recovery to ordinary Stop', async () => {
    const r = await recovery('running');
    await r.finish();
    r.noRestore();
  });
  it('does not restore for a shortcut invoked in the composer', async () => {
    const r = await recovery('error', true);
    await r.finish();
    r.noRestore();
  });
  it.each(['session', 'run', 'revision', 'resync'] as const)(
    'rejects focus restoration after %s invalidation',
    async (kind) => {
      const r = await recovery();
      if (kind === 'session') await r.emit({ sessionId: 'session-new', revision: 4 }, 4);
      if (kind === 'run') await r.emit({ runId: 'run-new', revision: 4 }, 4);
      if (kind === 'revision') await r.emit({ revision: 3, error: 'New failure' }, 2);
      if (kind === 'resync') await r.emit({ revision: 4 }, 4);
      await r.finish(true, {
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        ...(kind === 'resync' ? { revision: 5 } : {}),
      });
      r.noRestore();
    },
  );
  it('does not restore on rejected IPC after newer same-run terminal evidence', async () => {
    const r = await recovery();
    await r.emit({ revision: 2, phase: 'error', error: 'Newer terminal diagnostic' }, 2);
    await r.reject();
    r.noRestore();
    expect(screen.getByText('Newer terminal diagnostic')).toBeInTheDocument();
    expect(r.start).toBeDisabled();
  });
  it.each(['disposed', 'no-project'] as const)(
    'uses enabled Close fallback after %s cleanup',
    async (kind) => {
      const r = await recovery();
      await r.finish(true, kind === 'disposed' ? { disposed: true } : { project: null });
      expect(r.start).toBeDisabled();
      expect(r.close).toBeEnabled();
      expect(r.closeFocus).toHaveBeenCalledTimes(1);
      expect(r.startFocus).not.toHaveBeenCalled();
    },
  );
  it('scopes enabled runner gradients to contrast-safe endpoints without changing disabled opacity', () => {
    function luminance(hex: string) {
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    }
    for (const button of ['start', 'stop']) {
      for (const suffix of ['', ':not(:disabled):hover']) {
        const selector = `.runner-controls .${button}-button${suffix}`;
        const start = stylesheet.indexOf(`${selector} {`);
        expect(start, selector).toBeGreaterThanOrEqual(0);
        const rule = stylesheet.slice(start, stylesheet.indexOf('}', start));
        const colors = rule.match(/#[0-9a-f]{6}/giu) ?? [];
        expect(colors).toHaveLength(2);
        for (const color of colors)
          expect(1.05 / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(stylesheet).toMatch(/button:disabled\s*\{[^}]*opacity:\s*0\.44/u);
  });
  it('keeps Enter invocation blocked during pending cleanup', async () => {
    const r = await recovery();
    await r.user.type(screen.getByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    expect(r.invoke).not.toHaveBeenCalled();
    expect(r.start).toBeDisabled();
    await r.finish();
  });
});

function liveSnapshot(content = 'Retained public message'): DisRunnerRuntimeState {
  return {
    ...snapshot,
    contexts: [context, { ...context, actorId: '3001' }],
    coreState: {
      schemaVersion: 1,
      runId: 'run-1',
      stateRevision: 100,
      revisioned: true,
      clock: { domain: 'bot', mode: 'realtime', nowMs: 1 },
      totalResources: 1,
      truncated: false,
      resources: [
        {
          id: 'message-1',
          resourceType: 'message',
          visibility: 'channel',
          guild_id: '1000',
          channel_id: '2000',
          type: 0,
          flags: 0,
          content,
          author: { id: 'author', username: 'Runtime author' },
        },
      ],
    },
  };
}

describe('live retained Desktop message feed', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
  });

  it('renders accepted edits, rejects stale publications, labels truncation and clears unavailable/stopped state', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    const initial = liveSnapshot();
    installBridge(vi.fn(), {
      getRuntimeState: () => Promise.resolve(initial),
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    render(<App />);
    expect(
      await within(screen.getByRole('main')).findByText('Retained public message'),
    ).toBeVisible();
    async function publish(value: DisRunnerRuntimeState) {
      await act(async () => {
        await Promise.resolve();
        listener({
          schemaVersion: 1,
          sessionId: value.sessionId,
          runId: value.runId,
          sequence: value.revision,
          kind: 'snapshot',
          snapshot: value,
        });
      });
    }
    const edited = { ...liveSnapshot('Edited retained message'), revision: 2 };
    await publish(edited);
    expect(within(screen.getByRole('main')).getByText('Edited retained message')).toBeVisible();
    await publish(initial);
    expect(screen.queryByText('Retained public message')).not.toBeInTheDocument();
    await publish({
      ...edited,
      revision: 3,
      coreState: { ...edited.coreState!, resources: [], truncated: true },
    });
    expect(screen.getByLabelText('Live message feed status')).toHaveTextContent(
      'truncated retained snapshot. Missing messages are not evidence of deletion.',
    );
    expect(screen.queryByText('Edited retained message')).not.toBeInTheDocument();
    await publish({ ...edited, revision: 4, coreState: null });
    expect(screen.getByLabelText('Live message feed status')).toHaveTextContent(
      'Live messages unavailable',
    );
    await publish({ ...edited, revision: 5, phase: 'ready' });
    expect(screen.queryByText('Edited retained message')).not.toBeInTheDocument();
  });

  it('clears old rows during a new-run resync and rejects an old-run core projection', async () => {
    let listener!: (event: DisRunnerSessionEvent) => void;
    let resolve!: (value: DisRunnerRuntimeState) => void;
    const getState = vi
      .fn()
      .mockResolvedValueOnce(liveSnapshot())
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    installBridge(vi.fn(), {
      getRuntimeState: getState,
      onRuntimeState: (value) => {
        listener = value;
        return () => {};
      },
    });
    render(<App />);
    await screen.findByText('Retained public message');
    await act(async () => {
      await Promise.resolve();
      listener({
        schemaVersion: 1,
        sessionId: 'session-1',
        runId: 'run-2',
        sequence: 2,
        kind: 'snapshot',
        snapshot: { ...liveSnapshot(), runId: 'run-2', revision: 2 },
      });
    });
    expect(screen.queryByText('Retained public message')).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      resolve({ ...liveSnapshot(), runId: 'run-2', revision: 2 });
    });
    expect(screen.queryByText('Retained public message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Live message feed status')).toHaveTextContent(
      'Live messages unavailable',
    );
  });

  it('never exposes a late actor A callback in actor B feed or diagnostics', async () => {
    let finish!: (value: DisRunnerInvocationResult) => void;
    let request!: DisRunnerInvocationRequest;
    installBridge(
      (value) => {
        request = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { getRuntimeState: () => Promise.resolve(liveSnapshot()) },
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole('textbox', { name: 'Message #2000' }),
      '/secret{Enter}',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Invocation actor' }), '3001');
    await act(async () => {
      await Promise.resolve();
      finish({
        ...request,
        ok: true,
        command: 'secret',
        interactionId: 'private',
        durationMs: 1,
        response: { type: 'message', data: { content: 'Actor A private callback', flags: 64 } },
        error: null,
      });
    });
    expect(screen.queryByText('Actor A private callback')).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText('Retained public message')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Invocation actor' }), '3000');
    await user.click(screen.getByRole('tab', { name: 'Trace' }));
    expect(screen.queryByText('Actor A private callback')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message #2000' }), '/secret{Enter}');
    await act(async () => {
      await Promise.resolve();
      finish({
        ...request,
        ok: true,
        command: 'secret',
        interactionId: 'current-private',
        durationMs: 1,
        response: { type: 'message', data: { content: 'Actor A private callback', flags: 64 } },
        error: null,
      });
    });
    await user.click(screen.getByRole('tab', { name: 'Trace' }));
    expect(screen.getByText('Actor A private callback')).toBeVisible();
    expect(
      within(screen.getByRole('main')).queryByText('Actor A private callback'),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Invocation actor' }), '3001');
    expect(screen.queryByText('Actor A private callback')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Invocation actor' }), '3000');
    expect(screen.queryByText('Actor A private callback')).not.toBeInTheDocument();
    expect(screen.getByText('No invocation diagnostics for this context.')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Interaction inspector' })).queryByText('Passed'),
    ).not.toBeInTheDocument();
  });
  it('drops late actor A invocation failures before they can replace actor B diagnostics', async () => {
    let reject!: (reason: Error) => void;
    installBridge(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      {
        getRuntimeState: () => Promise.resolve(liveSnapshot()),
      },
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole('textbox', { name: 'Message #2000' }),
      '/secret{Enter}',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Invocation actor' }), '3001');
    await act(async () => {
      reject(new Error('Actor A failure detail'));
      await Promise.resolve();
    });
    expect(screen.queryByText('Actor A failure detail')).not.toBeInTheDocument();
    expect(screen.queryByText('/secret failed locally')).not.toBeInTheDocument();
  });
});

describe('interaction responses in the live feed', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'disrunnerDesktop');
  });

  function responseSnapshot(): DisRunnerRuntimeState {
    const base = liveSnapshot();
    return {
      ...base,
      coreState: {
        ...base.coreState!,
        resources: [
          {
            id: 'original-1',
            resourceType: 'message',
            visibility: 'channel',
            guild_id: '1000',
            channel_id: '2000',
            type: 20,
            flags: 0,
            content: 'Original public.',
            timestamp: '2015-01-01T00:01:40.000Z',
            author: { id: '333333333333333333', username: 'fixture-bot', bot: true },
          },
        ],
      },
    };
  }

  it('explains which interaction responses appear in the feed', async () => {
    installBridge(vi.fn(), { getRuntimeState: () => Promise.resolve(liveSnapshot()) });
    render(<App />);
    const status = await screen.findByRole('status', { name: 'Live message feed status' });
    expect(status).toHaveTextContent(
      'Public interaction responses appear once posted; raw callback data, responses still loading and ephemeral responses are not shown.',
    );
    expect(status).not.toHaveTextContent(
      'Interaction callbacks remain diagnostic evidence, not channel messages.',
    );
  });

  it('renders a retained public response once and still keeps callback data out of the feed', async () => {
    let finish!: (result: DisRunnerInvocationResult) => void;
    const invoke = vi.fn(
      (request: DisRunnerInvocationRequest) =>
        new Promise<DisRunnerInvocationResult>((resolve) => {
          expect(request.input).toBe('/ping');
          finish = resolve;
        }),
    );
    installBridge(invoke, { getRuntimeState: () => Promise.resolve(responseSnapshot()) });
    const user = userEvent.setup();
    render(<App />);
    const main = screen.getByRole('main');
    expect(await within(main).findByText('Original public.')).toBeVisible();
    expect(within(main).getAllByText('Original public.')).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    const request = invoke.mock.calls[0]?.[0] as unknown as DisRunnerInvocationRequest;
    await act(async () => {
      finish({
        ...request,
        ok: true,
        command: 'ping',
        interactionId: 'interaction-2',
        durationMs: 3,
        response: { type: 'message', data: { content: 'Raw callback only' } },
        error: null,
      });
      await Promise.resolve();
    });
    expect(
      within(screen.getByRole('main')).queryByText('Raw callback only'),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).getAllByText('Original public.')).toHaveLength(1);
  });
});
