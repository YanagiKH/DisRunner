import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

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

  it('submits real non-first project IDs and keeps a delayed reply in its captured channel', async () => {
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
    expect(within(screen.getByRole('main')).getByText('Observed callback')).toBeInTheDocument();
    expect(screen.queryByText('Pong!  ·  123ms')).not.toBeInTheDocument();
  });

  it('shows rejected runtime calls without fabricating preview responses', async () => {
    installBridge(() => Promise.reject(new Error('Authenticated peer failed')));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole('textbox', { name: 'Message #2000' }), '/ping{Enter}');
    expect(
      await within(screen.getByRole('main')).findByText('Authenticated peer failed'),
    ).toBeInTheDocument();
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
