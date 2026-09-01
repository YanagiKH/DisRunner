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
import './styles.css';

const EMPTY_RUNTIME_STATE: DisRunnerRuntimeState = {
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
  const [state, dispatch] = useReducer(simulationReducer, createInitialState());
  const [runtimeState, setRuntimeState] = useState<DisRunnerRuntimeState>(EMPTY_RUNTIME_STATE);
  const pendingTimers = useRef<Set<number>>(new Set());
  const desktopBridge = window.disrunnerDesktop;
  const desktop = desktopBridge !== undefined;
  const displayedBotStatus = desktop ? runtimeState.phase : state.botStatus;
  const guild = useMemo(() => findGuild(state.guildId), [state.guildId]);
  const channel = useMemo(() => findChannel(guild, state.channelId), [guild, state.channelId]);
  const messages = state.messages[channel.id] ?? [];
  const detailMode = state.surface !== 'simulator';

  useEffect(() => {
    if (desktopBridge === undefined) return undefined;
    let active = true;
    const unsubscribe = desktopBridge.onRuntimeState((nextState) => {
      if (active) setRuntimeState(nextState);
    });
    void desktopBridge
      .getRuntimeState()
      .then((nextState) => {
        if (active) setRuntimeState(nextState);
      })
      .catch((error: unknown) => {
        if (active)
          setRuntimeState({
            ...EMPTY_RUNTIME_STATE,
            phase: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!desktop) return;
    const simulatedStatus = runtimeState.phase === 'running' ? 'running' : 'stopped';
    if (state.botStatus !== simulatedStatus) dispatch({ type: 'set-bot', status: simulatedStatus });
  }, [desktop, runtimeState.phase, state.botStatus]);

  const startBot = useCallback(() => {
    if (desktopBridge === undefined) {
      dispatch({ type: 'set-bot', status: 'running' });
      return;
    }
    void desktopBridge
      .startRuntime()
      .then(setRuntimeState)
      .catch((error: unknown) => {
        setRuntimeState((current) => ({
          ...current,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }, [desktopBridge]);

  const stopBot = useCallback(() => {
    if (desktopBridge === undefined) {
      dispatch({ type: 'set-bot', status: 'stopped' });
      return;
    }
    void desktopBridge
      .stopRuntime()
      .then(setRuntimeState)
      .catch((error: unknown) => {
        setRuntimeState((current) => ({
          ...current,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }, [desktopBridge]);

  const selectProject = async (): Promise<void> => {
    if (desktopBridge === undefined) return;
    const selected = await desktopBridge.selectProject();
    if (selected !== null) setRuntimeState(selected);
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
        if (displayedBotStatus === 'running') stopBot();
        else startBot();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>('.composer input');
        input?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [displayedBotStatus, startBot, stopBot]);

  const scheduleFollowUp = (executionId: number, channelId: string) => {
    const timer = window.setTimeout(() => {
      dispatch({ type: 'complete-deferred', executionId, channelId });
      pendingTimers.current.delete(timer);
    }, 900);
    pendingTimers.current.add(timer);
  };

  const submitComposer = (input: string) => {
    if (desktopBridge !== undefined) {
      void desktopBridge
        .invokeCommand(input)
        .then((result) => {
          dispatch({ type: 'execute-runtime', input, result });
        })
        .catch((error: unknown) => {
          const command = input.trim().split(/\s+/u)[0]?.replace(/^\//u, '') ?? '';
          dispatch({
            type: 'execute-runtime',
            input,
            result: {
              ok: false,
              command,
              interactionId: null,
              durationMs: 0,
              response: null,
              error: error instanceof Error ? error.message : String(error),
            },
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
      void desktopBridge.invokeCommand(commandName).then((result) => {
        dispatch({ type: 'execute-runtime', input: commandName, result });
      });
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
      />
      <RuntimeStrip desktop={desktop} runtime={runtimeState} />
      <div className={`app-main ${detailMode ? 'detail-mode' : ''}`}>
        <WorkspaceRail
          active={state.surface}
          onNavigate={(surface) => dispatch({ type: 'navigate', surface })}
        />
        <GuildSidebar
          guilds={GUILDS}
          onChannelSelect={(channelId) => dispatch({ type: 'select-channel', channelId })}
          onGuildSelect={(guildId) => dispatch({ type: 'select-guild', guildId })}
          selectedChannelId={channel.id}
          selectedGuild={guild}
        />
        {!detailMode ? (
          <>
            <Conversation
              botRunning={displayedBotStatus === 'running'}
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
