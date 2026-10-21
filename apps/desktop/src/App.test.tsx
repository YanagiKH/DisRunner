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
