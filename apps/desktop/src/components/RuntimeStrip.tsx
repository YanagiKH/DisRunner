import { Activity, AlertTriangle, TerminalSquare } from 'lucide-react';

interface RuntimeStripProps {
  readonly runtime: DisRunnerRuntimeState;
  readonly desktop: boolean;
}

function commandLabel(project: DisRunnerProjectSummary | null): string {
  if (project === null) return 'No validated project selected';
  return [project.executable, ...project.args]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

export function RuntimeStrip({ runtime, desktop }: RuntimeStripProps) {
  const lastOutput = runtime.output.at(-1);
  return (
    <section className={`runtime-strip ${runtime.phase}`} aria-label="Local bot runtime status">
      <span className="runtime-phase">
        <Activity size={13} />
        {desktop ? runtime.phase : 'browser preview'}
      </span>
      <span className="runtime-command" title={commandLabel(runtime.project)}>
        <TerminalSquare size={13} />
        <code>{desktop ? commandLabel(runtime.project) : 'Electron bridge not present'}</code>
      </span>
      <span className="runtime-metric">PID {runtime.pid ?? '—'}</span>
      <span className="runtime-metric">Trace {runtime.traces.length}</span>
      <span className="runtime-metric">Risk {runtime.risks.length}</span>
      <span
        className={`runtime-tail ${lastOutput?.stream ?? ''}`}
        title={runtime.error ?? lastOutput?.text ?? ''}
      >
        {runtime.error !== null && <AlertTriangle size={12} />}
        {runtime.error ??
          lastOutput?.text.trim() ??
          (desktop ? 'Runtime output will appear here' : 'Visual simulator only')}
      </span>
    </section>
  );
}
