import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchStatus, WatchTarget } from '@autoregister/shared';
import { StatGrid } from './StatGrid';
import { StatusBadge } from './StatusBadge';
import { ModeToggle } from './ModeToggle';
import { fmtRelative } from '../lib/format';
import { useNow } from '../lib/useNow';

interface Props {
  target: WatchTarget;
  onToggleMode: (id: string, next: WatchMode) => void;
  onRun: (id: string) => void;
  onTogglePolling: (id: string, next: WatchStatus) => void;
  running?: boolean;
  /** When false (not logged in), resuming and one-click run are blocked. */
  loggedIn?: boolean;
}

// Only an actively-watching course can be paused. A paused course can be resumed,
// and so can one the failure breaker stopped ('error'): without that, `error` was
// a one-way door — the card offered no action, "Register now" is disabled for
// non-watching targets, and Start all deliberately skips them, so the corrected
// CRN the error message asks for could never actually be retried (Q3/Q20).
// The completed states (registered / waitlisted) stay terminal: you already have
// the seat, and silently re-watching it would only burn budget.
const PAUSABLE: WatchStatus[] = ['watching'];
const RESUMABLE: WatchStatus[] = ['paused', 'error'];

export function CourseCard({
  target,
  onToggleMode,
  onRun,
  onTogglePolling,
  running,
  loggedIn = true,
}: Props) {
  const { t } = useTranslation();
  const now = useNow(30_000); // ticks so "last poll Nm ago" stays current
  const title = target.label ?? `${target.subject} ${target.courseNumber}`;
  const canRun = target.status === 'watching';
  const canPause = PAUSABLE.includes(target.status);
  const canResume = RESUMABLE.includes(target.status);
  const errored = canResume && target.status === 'error';
  return (
    <div className="card glass">
      <div className="row1">
        <div>
          <div className="title">{title}</div>
          <div className="crn">
            CRN {target.targetCrn} · {target.term}
          </div>
        </div>
        <StatusBadge status={target.status} />
      </div>

      <StatGrid stats={target.lastStats} />

      <div className="row3">
        <ModeToggle mode={target.mode} onToggle={(next) => onToggleMode(target.id, next)} />
        <div style={{ display: 'flex', gap: 8 }}>
          {(canPause || canResume) && (
            <button
              type="button"
              className="btn"
              disabled={canResume && !loggedIn}
              title={canResume && !loggedIn ? t('scheduler.loginFirst') : undefined}
              onClick={() => onTogglePolling(target.id, canPause ? 'paused' : 'watching')}
            >
              {canPause ? t('card.pause') : errored ? t('card.resumeWatching') : t('card.resume')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-accent"
            disabled={!canRun || running || !loggedIn}
            title={canRun && !loggedIn ? t('scheduler.loginFirst') : undefined}
            onClick={() => onRun(target.id)}
          >
            {running ? t('card.running') : t('card.registerNow')}
          </button>
        </div>
      </div>

      <div className="meta">
        {target.lastPolledAt
          ? t('card.lastPoll', { rel: fmtRelative(target.lastPolledAt, now) })
          : t('card.notPolled')}
      </div>
    </div>
  );
}
