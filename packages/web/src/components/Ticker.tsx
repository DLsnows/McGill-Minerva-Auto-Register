import type { SessionStatus } from '../lib/api';

interface Props {
  watching: number;
  intervalMinutes: number;
  jitterMinutes: number;
  queryUsed: number;
  queryBudget: number;
  registerUsed: number;
  registerBudget: number;
  sessionStatus: SessionStatus;
}

const SESSION_LABEL: Record<SessionStatus, { text: string; dot: string }> = {
  authenticated: { text: 'Active', dot: 'dot-ok' },
  'logging-in': { text: 'Logging in', dot: 'dot-warn' },
  'logged-out': { text: 'Logged out', dot: '' },
  unknown: { text: 'Unknown', dot: '' },
};

export function Ticker(p: Props) {
  const s = SESSION_LABEL[p.sessionStatus];
  return (
    <div className="ticker glass">
      <div className="cell">
        <div className="k">Watching</div>
        <div className="v">{p.watching}</div>
      </div>
      <div className="cell">
        <div className="k">Interval</div>
        <div className="v">
          {p.intervalMinutes} <small>± {p.jitterMinutes} min</small>
        </div>
      </div>
      <div className="cell">
        <div className="k">Today · Query</div>
        <div className="v mono">
          {p.queryUsed} / {p.queryBudget}
        </div>
      </div>
      <div className="cell">
        <div className="k">Today · Register</div>
        <div className="v mono">
          {p.registerUsed} / {p.registerBudget}
        </div>
      </div>
      <div className="cell">
        <div className="k">Session</div>
        <div className="v">
          <span className={`dot ${s.dot}`} />
          {s.text}
        </div>
      </div>
    </div>
  );
}
