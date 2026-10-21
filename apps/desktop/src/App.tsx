import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { GUILDS } from './data';
import { Conversation } from './components/Conversation';
import { GuildSidebar } from './components/GuildSidebar';
import { Inspector } from './components/Inspector';
import { MemberList } from './components/MemberList';
import { RuntimeStrip } from './components/RuntimeStrip';
import { TopBar } from './components/TopBar';
import { WorkspaceRail } from './components/WorkspaceRail';
import { FeatureSurface } from './features/FeatureSurface';
import { createInitialState, simulationReducer } from './state/simulation';
import type { Channel, Guild, Surface } from './types';
import {
  confirmsCleanup,
  currentStopResult,
  runtimeControls,
  shutdownDetails,
} from './state/runtime-controls';
import './styles.css';

const EMPTY_RUNTIME_STATE: DisRunnerRuntimeState = {
  schemaVersion: 1,
  sessionId: '',
  runId: null,
  revision: 0,
  disposed: false,
  contexts: [],
  phase: 'idle',
  project: null,
  error: null,
  pid: null,
  endpoints: null,
  output: [],
  traces: [],
  risks: [],
};

function findGuild(guildId: string): Guild {
  return GUILDS.find((guild) => guild.id === guildId) ?? GUILDS[0]!;
}

function findChannel(guild: Guild, channelId: string): Channel {
  return (
    guild.groups.flatMap((group) => group.channels).find((channel) => channel.id === channelId) ??
    guild.groups[0]!.channels[0]!
  );
}

export default function App() {
  const desktopBridge = window.disrunnerDesktop;
  const desktop = desktopBridge !== undefined;
  const [state, dispatch] = useReducer(simulationReducer, createInitialState(!desktop));
  const [actorId, setActorId] = useState('');
  const [invocationError, setInvocationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shutdownError, setShutdownError] = useState<string | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [operationPending, setOperationPending] = useState<'start' | 'stop' | 'select' | null>(
    null,
  );
  const operation = useRef<'start' | 'stop' | 'select' | null>(null);
  const operationSequence = useRef(0);
  const pendingStart = useRef<{
    sessionId: string;
    previousRunId: string | null;
    runId: string | null;
    invalidated: boolean;
    stopped: boolean;
  } | null>(null);
  const [startupHistory, setStartupHistory] = useState<{
    sessionId: string;
    runId: string | null;
    message: string;
  } | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const requestSequence = useRef(0);
  const requestPrefix = useRef(crypto.randomUUID());
  const responseEpoch = useRef(0);
  const resyncPending = useRef(false);
  const latestRuntime = useRef(EMPTY_RUNTIME_STATE);
  const [runtimeState, setRuntimeState] = useState<DisRunnerRuntimeState>(EMPTY_RUNTIME_STATE);
  const controls = runtimeControls(
    runtimeState,
    resyncing ? 'sync' : operationPending,
    shutdownError !== null || actionError !== null,
  );
  const pendingTimers = useRef<Set<number>>(new Set());
  const displayedBotStatus = desktop ? runtimeState.phase : state.botStatus;
  const runtimeContext =
    runtimeState.contexts.find(
      (context) =>
        context.guildId === state.guildId &&
        context.channelId === state.channelId &&
        context.actorId === actorId,
    ) ??
    runtimeState.contexts.find(
      (context) => context.channelId === state.channelId && context.actorId === actorId,
    ) ??
    runtimeState.contexts.find((context) => context.channelId === state.channelId) ??
    runtimeState.contexts.find((context) => context.actorId === actorId) ??
    runtimeState.contexts[0];
  const canInvoke =
    runtimeState.phase === 'running' &&
    !runtimeState.disposed &&
    runtimeState.runId !== null &&
    runtimeContext !== undefined &&
    !operationPending &&
    !resyncing &&
    shutdownError === null &&
    actionError === null;
  const guilds = useMemo<readonly Guild[]>(
    () =>
      desktop
        ? [...new Set(runtimeState.contexts.map((context) => context.guildId))].map((guildId) => ({
            id: guildId,
            name: `Project guild ${guildId}`,
            accent: '#5865f2',
            mark: 'P',
            members: [],
            groups: [
              {
                id: `project-${guildId}`,
                name: 'Validated project channels',
                channels: [
                  ...new Set(
                    runtimeState.contexts
                      .filter((context) => context.guildId === guildId)
                      .map((context) => context.channelId),
                  ),
                ].map((id) => ({ id, name: id, description: 'Validated project text channel' })),
              },
            ],
          }))
        : GUILDS,
    [desktop, runtimeState.contexts],
  );
  const emptyGuild: Guild = {
    id: '',
    name: 'Select a project',
    accent: '#5865f2',
    mark: 'P',
    members: [],
    groups: [],
  };
  const guild = desktop
    ? (guilds.find((item) => item.id === runtimeContext?.guildId) ?? emptyGuild)
    : findGuild(state.guildId);
  const channel = desktop
    ? (guild.groups
        .flatMap((group) => group.channels)
        .find((item) => item.id === runtimeContext?.channelId) ?? {
        id: '',
        name: 'no-project',
        description: 'Select a validated project before invoking commands.',
      })
    : findChannel(guild, state.channelId);
  const observeStartupIdentity = useCallback((next: DisRunnerRuntimeState) => {
    const attempt = pendingStart.current;
    if (attempt === null || attempt.invalidated) return;
    if (next.sessionId !== attempt.sessionId) {
      attempt.invalidated = true;
      return;
    }
    if (attempt.runId !== null) {
      if (next.runId !== attempt.runId) attempt.invalidated = true;
    } else if (next.runId !== attempt.previousRunId) {
      // Bind only the observed startup transition, never whichever run is current
      // when a delayed promise rejects or the user clicks Stop.
      if (next.phase === 'starting') attempt.runId = next.runId;
      else attempt.invalidated = true;
    }
  }, []);
  const applyRuntimeState = useCallback(
    (next: DisRunnerRuntimeState) => {
      const previous = latestRuntime.current;
      if (next.sessionId === previous.sessionId && next.revision < previous.revision) return;
      observeStartupIdentity(next);
      resyncPending.current = false;
      setResyncing(false);
      setSyncFailed(false);
      if (next.sessionId !== previous.sessionId) {
        setShutdownError(null);
        setActionError(null);
        setRuntimeNotice(null);
      }
      latestRuntime.current = next;
      setRuntimeState(next);
    },
    [observeStartupIdentity],
  );
  const messages = state.messages[channel.id] ?? [];
  const detailMode = state.surface !== 'simulator';

  useEffect(() => {
    if (desktopBridge === undefined) return undefined;
    let active = true;
    const unsubscribe = desktopBridge.onRuntimeState((event) => {
      if (!active) return;
      const previous = latestRuntime.current;
      if (event.sessionId !== previous.sessionId || event.snapshot.revision >= previous.revision)
        observeStartupIdentity(event.snapshot);
      if (
        event.sessionId !== previous.sessionId ||
        event.runId !== previous.runId ||
        event.sequence > previous.revision + 1
      ) {
        const epoch = ++responseEpoch.current;
        resyncPending.current = true;
        setResyncing(true);
        void desktopBridge
          .getRuntimeState()
          .then((snapshot) => {
            if (active && epoch === responseEpoch.current) applyRuntimeState(snapshot);
          })
          .catch(() => {
            if (!active || epoch !== responseEpoch.current) return;
            setSyncFailed(true);
            setActionError(
              'Runtime status could not be refreshed. Refresh its status before continuing.',
            );
          });
      } else applyRuntimeState(event.snapshot);
    });
    const initialEpoch = responseEpoch.current;
    void desktopBridge
      .getRuntimeState()
      .then((nextState) => {
        if (active && initialEpoch === responseEpoch.current) applyRuntimeState(nextState);
      })
      .catch(() => {
        if (active && initialEpoch === responseEpoch.current) {
          applyRuntimeState({
            ...EMPTY_RUNTIME_STATE,
            phase: 'error',
            error: 'Runtime status could not be loaded.',
          });
          resyncPending.current = true;
          setResyncing(true);
          setSyncFailed(true);
          setActionError(
            'Runtime status could not be loaded. Refresh its status before continuing.',
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktopBridge, applyRuntimeState, observeStartupIdentity]);

  const refreshRuntime = () => {
    if (desktopBridge === undefined || !syncFailed) return;
    const epoch = ++responseEpoch.current;
    setSyncFailed(false);
    void desktopBridge
      .getRuntimeState()
      .then((next) => {
        if (epoch === responseEpoch.current) applyRuntimeState(next);
      })
      .catch(() => {
        if (epoch === responseEpoch.current) setSyncFailed(true);
      });
  };

  const startBot = useCallback(() => {
    if (desktopBridge === undefined) {
      dispatch({ type: 'set-bot', status: 'running' });
      return;
    }
    if (operation.current || resyncPending.current || !controls.canStart) return;
    const attempt = {
      sessionId: latestRuntime.current.sessionId,
      previousRunId: latestRuntime.current.runId,
      runId: null as string | null,
      invalidated: false,
      stopped: false,
    };
    pendingStart.current = attempt;
    setStartupHistory(null);
    operation.current = 'start';
    const operationId = ++operationSequence.current;
    setOperationPending('start');
    setRuntimeNotice(null);
    void desktopBridge
      .startRuntime()
      .then((next) => {
        if (operationId === operationSequence.current && !attempt.invalidated)
          applyRuntimeState(next);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Runtime start could not be confirmed.';
        const latest = latestRuntime.current;
        if (
          pendingStart.current !== attempt ||
          attempt.invalidated ||
          latest.sessionId !== attempt.sessionId
        )
          return;
        const snapshotMatches = latest.runId === (attempt.runId ?? attempt.previousRunId);
        const awaitingSnapshot = resyncPending.current && latest.runId === attempt.previousRunId;
        if (!snapshotMatches && !awaitingSnapshot) return;
        if (operationId !== operationSequence.current && !attempt.stopped) return;
        // A superseded startup result is historical only. Stop owns the controls.
        setStartupHistory({
          sessionId: attempt.sessionId,
          runId: attempt.runId ?? attempt.previousRunId,
          message,
        });
        if (operationId !== operationSequence.current || !snapshotMatches) return;
        setActionError(message);
      })
      .finally(() => {
        if (operationId === operationSequence.current) {
          operation.current = null;
          setOperationPending(null);
        }
      });
  }, [desktopBridge, applyRuntimeState, controls.canStart]);

  const stopBot = useCallback(() => {
    if (desktopBridge === undefined) {
      dispatch({ type: 'set-bot', status: 'stopped' });
      return;
    }
    if (
      (operation.current !== null && operation.current !== 'start') ||
      resyncPending.current ||
      !controls.canStop
    )
      return;
    const started = latestRuntime.current;
    if (operation.current === 'start' && pendingStart.current !== null)
      pendingStart.current.stopped = true;
    operation.current = 'stop';
    const operationId = ++operationSequence.current;
    setOperationPending('stop');
    setRuntimeNotice('Checking runtime cleanup…');
    void desktopBridge
      .stopRuntime()
      .then((result) => {
        if (!currentStopResult(started, latestRuntime.current, result)) {
          setRuntimeNotice(null);
          return;
        }
        applyRuntimeState(result.snapshot);
        if (confirmsCleanup(result)) {
          setShutdownError(null);
          setActionError(null);
          setRuntimeNotice(
            result.errors.length > 0
              ? 'Runtime cleanup completed. The bot had exited unexpectedly.'
              : 'Runtime cleanup completed.',
          );
        } else {
          setShutdownError(shutdownDetails(result));
          setRuntimeNotice(null);
        }
      })
      .catch(() => {
        if (
          latestRuntime.current.sessionId !== started.sessionId ||
          latestRuntime.current.runId !== started.runId
        )
          return;
        setShutdownError('Runtime shutdown could not be confirmed.');
        setRuntimeNotice(null);
      })
      .finally(() => {
        if (operationId === operationSequence.current) {
          operation.current = null;
          setOperationPending(null);
        }
      });
  }, [desktopBridge, applyRuntimeState, controls.canStop]);

  const selectProject = async (): Promise<void> => {
    if (
      desktopBridge === undefined ||
      operation.current ||
      resyncPending.current ||
      !controls.canSelect
    )
      return;
    operation.current = 'select';
    setOperationPending('select');
    try {
      const selected = await desktopBridge.selectProject();
      if (selected !== null) applyRuntimeState(selected);
    } catch {
      setActionError('Project selection failed. Check runtime diagnostics before continuing.');
    } finally {
      operation.current = null;
      setOperationPending(null);
    }
  };

  useEffect(
    () => () => {
      pendingTimers.current.forEach((timer) => window.clearTimeout(timer));
      pendingTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!state.toast) return undefined;
    const timer = window.setTimeout(() => dispatch({ type: 'dismiss-toast' }), 2600);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  useEffect(() => {
    const surfaces: readonly Surface[] = [
      'simulator',
      'guild-editor',
      'scenario-lab',
      'command-explorer',
      'risk-center',
      'settings',
    ];
    const handler = (event: KeyboardEvent) => {
      if (event.altKey && /^Digit[1-6]$/u.test(event.code)) {
        const index = Number(event.code.slice(-1)) - 1;
        const surface = surfaces[index];
        if (surface) {
          event.preventDefault();
          dispatch({ type: 'navigate', surface });
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (desktopBridge !== undefined) {
          if (controls.canStop) stopBot();
          else if (controls.canStart) startBot();
        } else if (displayedBotStatus === 'running') stopBot();
        else startBot();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>('.composer input');
        input?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [displayedBotStatus, startBot, stopBot, desktopBridge, controls.canStart, controls.canStop]);

  const scheduleFollowUp = (executionId: number, channelId: string) => {
    const timer = window.setTimeout(() => {
      dispatch({ type: 'complete-deferred', executionId, channelId });
      pendingTimers.current.delete(timer);
    }, 900);
    pendingTimers.current.add(timer);
  };

  const submitComposer = (input: string) => {
    if (desktopBridge !== undefined) {
      if (
        resyncPending.current ||
        operation.current ||
        runtimeState.disposed ||
        shutdownError !== null ||
        actionError !== null ||
        runtimeContext === undefined ||
        runtimeState.runId === null ||
        runtimeState.phase !== 'running'
      ) {
        setInvocationError(
          shutdownError !== null || actionError !== null || runtimeState.phase === 'error'
            ? 'Runtime recovery is required before invoking commands. Use Retry cleanup.'
            : runtimeState.disposed
              ? 'This session is closed and cannot invoke commands.'
              : 'Select a validated project and start its bot before invoking commands.',
        );
        return;
      }
      const request: DisRunnerInvocationRequest = {
        runId: runtimeState.runId,
        requestId: `${requestPrefix.current}-${++requestSequence.current}`,
        input,
        context: { ...runtimeContext },
      };
      setInvocationError(null);
      const epoch = responseEpoch.current;
      void desktopBridge
        .invokeCommand(request)
        .then((result) => {
          if (
            epoch !== responseEpoch.current ||
            latestRuntime.current.runId !== request.runId ||
            latestRuntime.current.phase !== 'running'
          )
            return;
          if (
            result.runId !== request.runId ||
            result.requestId !== request.requestId ||
            result.context.actorId !== request.context.actorId ||
            result.context.guildId !== request.context.guildId ||
            result.context.channelId !== request.context.channelId
          )
            throw new Error('Runtime response identity does not match the submitted invocation.');
          dispatch({ type: 'execute-runtime', input, result });
        })
        .catch((error: unknown) => {
          if (
            epoch !== responseEpoch.current ||
            latestRuntime.current.runId !== request.runId ||
            latestRuntime.current.phase !== 'running'
          )
            return;
          dispatch({
            type: 'runtime-failed',
            request,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    const executionId = state.executionCount + 1;
    const isSlow = input.trim().split(/\s+/u)[0] === '/slow';
    dispatch({ type: 'execute', input });
    if (isSlow && state.botStatus === 'running') scheduleFollowUp(executionId, state.channelId);
  };

  const invokeFromExplorer = (commandName: string) => {
    if (desktopBridge !== undefined) {
      dispatch({ type: 'navigate', surface: 'simulator' });
      submitComposer(commandName);
      return;
    }
    const executionId = state.executionCount + 1;
    if (displayedBotStatus !== 'running') startBot();
    dispatch({ type: 'navigate', surface: 'simulator' });
    dispatch({ type: 'execute', input: commandName });
    if (commandName === '/slow') scheduleFollowUp(executionId, state.channelId);
  };

  const toastIcon =
    state.toast?.toLowerCase().includes('offline') ||
    state.toast?.toLowerCase().includes('stopped') ? (
      <TriangleAlert size={16} />
    ) : state.toast?.toLowerCase().includes('enabled') ? (
      <Info size={16} />
    ) : (
      <CheckCircle2 size={16} />
    );

  return (
    <div className="app-shell">
      <TopBar
        botStatus={displayedBotStatus}
        guildName={guild.name}
        onStart={startBot}
        onStop={stopBot}
        controls={desktop ? controls : undefined}
      />
      <RuntimeStrip desktop={desktop} runtime={runtimeState} />
      {desktop && (
        <section aria-label="Runtime recovery" id="runtime-recovery">
          {(shutdownError !== null || actionError !== null || runtimeState.phase === 'error') && (
            <div role="alert">
              <strong>
                {shutdownError !== null
                  ? 'Runtime cleanup incomplete.'
                  : 'Runtime recovery required.'}
              </strong>{' '}
              Restart is blocked until cleanup is confirmed. Another cleanup attempt may not resolve
              this.
              <span>{shutdownError ?? actionError ?? runtimeState.error}</span>
            </div>
          )}
          {resyncing && (
            <p role="status">Runtime status is unconfirmed. Start and invocation remain blocked.</p>
          )}
          {syncFailed && (
            <button onClick={refreshRuntime} type="button">
              Refresh runtime status
            </button>
          )}
          {runtimeState.disposed && (
            <p>This session is closed and cannot restart. Cleanup may still be retried.</p>
          )}
          {runtimeNotice && <p role="status">{runtimeNotice}</p>}
          {startupHistory !== null &&
            startupHistory.sessionId === runtimeState.sessionId &&
            startupHistory.runId === runtimeState.runId &&
            (actionError === null || shutdownError !== null) && (
              <p role="status" aria-label="Startup outcome">
                Startup did not complete: {startupHistory.message}
              </p>
            )}
        </section>
      )}
      {desktop && (
        <section aria-label="Runtime invocation context">
          <span>Real project runtime · preview panels are sample data</span>
          <label>
            Actor{' '}
            <select
              aria-label="Invocation actor"
              value={runtimeContext?.actorId ?? ''}
              onChange={(event) => setActorId(event.target.value)}
            >
              {[
                ...new Set(
                  runtimeState.contexts
                    .filter((context) => context.channelId === runtimeContext?.channelId)
                    .map((context) => context.actorId),
                ),
              ].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          {invocationError && <span role="alert">{invocationError}</span>}
        </section>
      )}
      <div className={`app-main ${detailMode ? 'detail-mode' : ''}`}>
        <WorkspaceRail
          active={state.surface}
          onNavigate={(surface) => dispatch({ type: 'navigate', surface })}
        />
        <GuildSidebar
          guilds={guilds}
          onChannelSelect={(channelId) => dispatch({ type: 'select-channel', channelId })}
          onGuildSelect={(guildId) => dispatch({ type: 'select-guild', guildId })}
          selectedChannelId={channel.id}
          selectedGuild={guild}
        />
        {!detailMode ? (
          <>
            <Conversation
              botRunning={desktop ? canInvoke : displayedBotStatus === 'running'}
              invocationBlockReason={
                desktop && !canInvoke
                  ? resyncing
                    ? 'Refresh runtime status before invoking commands.'
                    : runtimeState.disposed
                      ? 'This session is closed.'
                      : controls.recovery
                        ? 'Complete runtime recovery before invoking commands.'
                        : 'Start the runtime before invoking commands.'
                  : undefined
              }
              channel={channel}
              messages={messages}
              onSubmit={submitComposer}
            />
            <MemberList members={guild.members} />
            <Inspector
              activeTab={state.inspectorTab}
              onSelectTab={(tab) => dispatch({ type: 'select-inspector-tab', tab })}
              trace={state.interaction}
            />
          </>
        ) : (
          <FeatureSurface
            guild={guild}
            onBack={() => dispatch({ type: 'navigate', surface: 'simulator' })}
            onInvoke={invokeFromExplorer}
            onSelectProject={selectProject}
            canSelectProject={controls.canSelect}
            canInvoke={canInvoke}
            runtime={runtimeState}
            surface={state.surface}
          />
        )}
      </div>
      {state.toast && (
        <div className="toast" role="status">
          {toastIcon}
          <span>{state.toast}</span>
        </div>
      )}
    </div>
  );
}
