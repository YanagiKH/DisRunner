import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleGauge,
  Clock3,
  Copy,
  Database,
  FileJson,
  GitCompareArrows,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { INSPECTOR_TABS } from '../data';
import type { InspectorTab, InteractionTrace, TraceStep } from '../types';

interface InspectorProps {
  readonly activeTab: InspectorTab;
  readonly trace: InteractionTrace;
  readonly onSelectTab: (tab: InspectorTab) => void;
}

function TraceDetails({
  trace,
  onOpenPayload,
}: {
  readonly trace: InteractionTrace;
  readonly onOpenPayload: () => void;
}) {
  return (
    <div className="trace-details">
      <div className="inspector-eyebrow">Selected interaction · sample projection</div>
      <dl>
        <dt>Command</dt>
        <dd>{trace.command}</dd>
        <dt>User</dt>
        <dd>{trace.user}</dd>
        <dt>Channel</dt>
        <dd>{trace.channel}</dd>
        <dt>Message ID</dt>
        <dd>{trace.outcome === 'Timed out' ? '(not yet created)' : `msg-${trace.id.slice(-4)}`}</dd>
        <dt>Interaction ID</dt>
        <dd>{trace.interactionId}</dd>
        <dt>Created at</dt>
        <dd>{trace.createdAt}</dd>
      </dl>
      <button className="secondary-button" onClick={onOpenPayload} type="button">
        <FileJson size={14} /> Open in Payload
      </button>
    </div>
  );
}

function StepMarker({ step }: { readonly step: TraceStep }) {
  const left = Math.max(0, Math.min(100, (step.startMs / 4000) * 100));
  const width = Math.max(1.5, Math.min(100 - left, (step.durationMs / 4000) * 100));
  return (
    <div
      className={`waterfall-step ${step.tone}`}
      style={{ '--step-left': `${left}%`, '--step-width': `${width}%` } as React.CSSProperties}
    >
      <span className="step-line" />
      <span className="step-start" />
      <span className="step-end" />
      <span className="step-name">{step.label}</span>
      <span className="step-duration">{step.durationMs}ms</span>
    </div>
  );
}

function Waterfall({ trace }: { readonly trace: InteractionTrace }) {
  const ticks = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
  return (
    <div className="waterfall" aria-label="Sample interaction timing waterfall">
      <div className="waterfall-axis">
        {ticks.map((tick) => (
          <span
            key={tick}
            style={{ '--tick-position': `${(tick / 4000) * 100}%` } as React.CSSProperties}
          >
            {tick === 0 ? '0' : tick < 1000 ? `${tick}ms` : `${(tick / 1000).toFixed(3)}s`}
          </span>
        ))}
      </div>
      <div className="deadline-label">
        <TriangleAlert size={12} /> 3.000 s deadline
      </div>
      <div className="deadline-line" />
      <div className="waterfall-grid">
        {ticks.map((tick) => (
          <span
            key={tick}
            style={{ '--tick-position': `${(tick / 4000) * 100}%` } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="waterfall-rows">
        {trace.steps.map((step) => (
          <StepMarker key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
}

function Outcome({ trace }: { readonly trace: InteractionTrace }) {
  const failed = trace.severity === 'high';
  const warning = trace.severity === 'medium';
  return (
    <div className="outcome-panel">
      <div className="outcome-title-row">
        <strong>Projected outcome</strong>
        <span className={`outcome-badge ${failed ? 'danger' : warning ? 'warning' : 'success'}`}>
          {trace.outcome}
        </span>
      </div>
      <section>
        <h3>Details</h3>
        <p>{trace.details}</p>
      </section>
      <section>
        <h3>Impact</h3>
        <p className={failed ? 'danger-text' : warning ? 'warning-text' : 'success-text'}>
          {failed ? (
            <>
              <TriangleAlert size={13} /> High
            </>
          ) : warning ? (
            <>
              <AlertCircle size={13} /> Medium
            </>
          ) : (
            <>
              <Check size={13} /> No user-visible failure
            </>
          )}
        </p>
      </section>
      <section>
        <h3>Recommendation</h3>
        <p>{trace.recommendation}</p>
      </section>
    </div>
  );
}

function PayloadView({ trace }: { readonly trace: InteractionTrace }) {
  return (
    <div className="inspector-content payload-view">
      <div className="payload-toolbar">
        <div>
          <FileJson size={16} />
          <strong>INTERACTION_CREATE</strong>
          <span>Sample projection · application/json</span>
        </div>
        <button disabled type="button">
          <Copy size={14} /> Copy redacted payload
        </button>
      </div>
      <pre>
        <code>{JSON.stringify(trace.payload, null, 2)}</code>
      </pre>
      <aside className="payload-note">
        <ShieldCheck size={17} />
        <div>
          <strong>Redacted preview</strong>
          <span>
            This projected model excludes raw interaction tokens; it is not a complete request
            capture.
          </span>
        </div>
      </aside>
    </div>
  );
}

function StateDiffView() {
  return (
    <div className="inspector-content state-diff-view">
      <div className="diff-summary">
        <GitCompareArrows size={18} />
        <div>
          <strong>Sample · 3 mutations</strong>
          <span>Illustrative callback state transition</span>
        </div>
        <button className="secondary-button" disabled type="button">
          <RotateCcw size={14} /> Roll back
        </button>
      </div>
      <div className="diff-columns">
        <section>
          <h3>Before</h3>
          <pre>{`message: null\ninteraction.ack: false\nqueue.depth: 0`}</pre>
        </section>
        <ArrowRight className="diff-arrow" size={18} />
        <section className="after">
          <h3>After</h3>
          <pre>{`message: "msg-local-01"\ninteraction.ack: true\nqueue.depth: 1`}</pre>
        </section>
      </div>
    </div>
  );
}

function PermissionsView() {
  const decisions = [
    ['Guild base · @everyone', 'View Channel', 'allow'],
    ['Role · TestBot', 'Send Messages', 'allow'],
    ['Role · Automation', 'Manage Messages', 'allow'],
    ['#bot-testing overwrite', 'Manage Messages', 'deny'],
    ['Effective result', 'Manage Messages', 'deny'],
  ] as const;
  return (
    <div className="inspector-content permission-view">
      <div className="permission-heading">
        <KeyRound size={17} />
        <div>
          <strong>Permission decision tree</strong>
          <span>Sample decision · requested bit 0x0000000000002000</span>
        </div>
      </div>
      <div className="permission-tree">
        {decisions.map(([source, permission, effect], index) => (
          <div className={`permission-node ${effect}`} key={source}>
            <span className="tree-index">{index + 1}</span>
            <span>
              <strong>{source}</strong>
              <small>{permission}</small>
            </span>
            <span className="permission-result">
              {effect === 'allow' ? <Check size={14} /> : <X size={14} />}
              {effect}
            </span>
            {index < decisions.length - 1 && <ChevronRight className="tree-chevron" size={15} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function RateLimitsView() {
  return (
    <div className="inspector-content rate-limit-view">
      <div className="rate-summary">
        <CircleGauge size={18} />
        <strong>Sample · 3 buckets</strong>
        <span>Illustrative virtual reset clock</span>
      </div>
      <div className="bucket-table" role="table" aria-label="Sample rate limit buckets">
        <div className="bucket-row header" role="row">
          <span>Bucket</span>
          <span>Scope</span>
          <span>Remaining</span>
          <span>Reset after</span>
          <span>Status</span>
        </div>
        {[
          ['msg:create:bot-testing', 'channel', 0, '1.250s', 'Hot'],
          ['interaction:follow-up', 'webhook', 4, '0.420s', 'Healthy'],
          ['global:bot', 'global', 48, '0.880s', 'Healthy'],
        ].map(([bucket, scope, remaining, reset, status]) => (
          <div className="bucket-row" key={String(bucket)} role="row">
            <span>
              <Database size={13} />
              {bucket}
            </span>
            <span>{scope}</span>
            <span>
              <i
                style={
                  {
                    '--bucket-width': `${Math.min(100, Number(remaining) * 10)}%`,
                  } as React.CSSProperties
                }
              />
              {remaining}
            </span>
            <span>{reset}</span>
            <span className={status === 'Hot' ? 'danger-text' : 'success-text'}>{status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RisksView({ trace }: { readonly trace: InteractionTrace }) {
  const timeout = trace.outcome === 'Timed out';
  return (
    <div className="inspector-content risks-view">
      <div className="inspector-eyebrow">Sample findings · not runtime scan results</div>
      <div className={`risk-finding ${timeout ? 'high' : 'resolved'}`}>
        {timeout ? <TriangleAlert size={20} /> : <ShieldCheck size={20} />}
        <div>
          <strong>
            {timeout ? 'INTERACTION_TIMEOUT · SAMPLE' : 'Interaction deadline healthy · SAMPLE'}
          </strong>
          <span>
            {timeout ? trace.details : 'Initial response completed inside 3.000 seconds.'}
          </span>
        </div>
        <b>SAMPLE</b>
      </div>
      <div className="risk-finding medium">
        <AlertCircle size={20} />
        <div>
          <strong>BOT_TOKEN_IN_LOG · SAMPLE</strong>
          <span>Illustrative redaction state; this panel did not run a complete log scan.</span>
        </div>
        <b>SAMPLE</b>
      </div>
      <div className="risk-finding medium">
        <Clock3 size={20} />
        <div>
          <strong>BLOCKING_HANDLER · SAMPLE</strong>
          <span>Illustrative 460ms database span; this is not measured runtime evidence.</span>
        </div>
        <b>SAMPLE</b>
      </div>
    </div>
  );
}

export function Inspector({ activeTab, trace, onSelectTab }: InspectorProps) {
  return (
    <section className="inspector" aria-label="Interaction inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
        {INSPECTOR_TABS.map((tab) => (
          <button
            aria-selected={activeTab === tab}
            className={activeTab === tab ? 'active' : ''}
            key={tab}
            onClick={() => onSelectTab(tab)}
            role="tab"
            type="button"
          >
            {tab}
          </button>
        ))}
        <div className="inspector-tab-spacer" />
        <span className="inspector-preview">Visual preview · sample panels</span>
      </div>
      {activeTab === 'Trace' && (
        <div className="trace-view" role="tabpanel">
          <TraceDetails trace={trace} onOpenPayload={() => onSelectTab('Payload')} />
          <Waterfall trace={trace} />
          <Outcome trace={trace} />
        </div>
      )}
      {activeTab === 'Payload' && <PayloadView trace={trace} />}
      {activeTab === 'State Diff' && <StateDiffView />}
      {activeTab === 'Permissions' && <PermissionsView />}
      {activeTab === 'Rate Limits' && <RateLimitsView />}
      {activeTab === 'Risks' && <RisksView trace={trace} />}
    </section>
  );
}
