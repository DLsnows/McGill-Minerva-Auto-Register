import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchStatus, WatchTarget } from '@autoregister/shared';
import { StatGrid } from './StatGrid';
import { StatusBadge } from './StatusBadge';
import { ModeToggle } from './ModeToggle';
import { fmtRelative } from '../lib/format';
import { useNow } from '../lib/useNow';
import { cooldownRemainingMs, MANUAL_RUN_COOLDOWN_MS } from '../lib/api';

interface Props {
  target: WatchTarget;
  onToggleMode: (id: string, next: WatchMode) => void;
  onRun: (id: string) => void;
  onTogglePolling: (id: string, next: WatchStatus) => void;
  running?: boolean;
  /** Verdict of the last manual-run request that was *dropped* ("in progress",
   * a failure, …), so it is visible instead of the button silently flashing
   * (Q16/Q60). The cooldown verdict is derived below instead of being frozen
   * here, so it can count down and disappear. */
  runNotice?: string;
  /** Epoch ms until which the manual-run cooldown is active, when the client has
   * to fall back to its own clock (a cooldown rejection reports `retryAfterMs`,
   * not a start time). The server's `target.lastForcedRunAt` — echoed by the
   * `/run` response — takes precedence; the server always re-checks anyway. */
  coolingUntil?: number;
  /** When false (not logged in), resuming and one-click run are blocked. */
  loggedIn?: boolean;
}

// Only an actively-watching course can be paused, and only a paused course can
// be resumed. 'error' and the completed states (registered / waitlisted) are
// terminal — they cannot be resumed from here.
const PAUSABLE: WatchStatus[] = ['watching'];
const RESUMABLE: WatchStatus[] = ['paused'];

export function CourseCard({
  target,
  onToggleMode,
  onRun,
  onTogglePolling,
  running,
  runNotice,
  coolingUntil,
  loggedIn = true,
}: Props) {
  const { t } = useTranslation();
  // Tick fast only while a cooldown is counting down: every tick re-renders this
  // card, so a permanent per-second interval on every idle card is wasted work
  // (review finding). The interval relaxes back to 30s at the same render that
  // drops the notice.
  const coolingByResponse = Date.now() < (coolingUntil ?? 0);
  const coolingByTarget = Date.now() < (target.lastForcedRunAt ?? 0) + MANUAL_RUN_COOLDOWN_MS;
  const now = useNow(coolingByResponse || coolingByTarget ? 1_000 : 30_000);
  const title = target.label ?? `${target.subject} ${target.courseNumber}`;
  const canRun = target.status === 'watching';
  const canPause = PAUSABLE.includes(target.status);
  const canResume = RESUMABLE.includes(target.status);
  // Derived, not stored: recomputed on every tick, so the button re-enables and
  // the notice disappears the moment the window really ends (review finding —
  // a frozen "Try again in 45s" outlived the cooldown and sat next to an
  // enabled button).
  const cooldownSecs = Math.ceil(cooldownRemainingMs(target.lastForcedRunAt, coolingUntil, now) / 1000);
  const cooling = cooldownSecs > 0;
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
              {canPause ? t('card.pause') : t('card.resume')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-accent"
            disabled={!canRun || running || cooling || !loggedIn}
            title={canRun && !loggedIn ? t('scheduler.loginFirst') : undefined}
            onClick={() => onRun(target.id)}
          >
            {running ? t('card.running') : t('card.registerNow')}
          </button>
        </div>
      </div>

      {cooling ? (
        <div className="meta" role="status" data-testid="run-notice">
          {t('run.cooldown', { s: cooldownSecs })}
        </div>
      ) : (
        runNotice && (
          <div className="meta" role="status" data-testid="run-notice">
            {runNotice}
          </div>
        )
      )}

      <div className="meta">
        {target.lastPolledAt
          ? t('card.lastPoll', { rel: fmtRelative(target.lastPolledAt, now) })
          : t('card.notPolled')}
      </div>
    </div>
  );
}
