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
   * a failure, …) plus the moment it stops being shown, so it is visible instead
   * of the button silently flashing (Q16/Q60) without outliving the cycle it
   * describes. The cooldown verdict is derived below rather than stored here, so
   * it can count down and clear itself. */
  runNotice?: { text: string; until: number };
  /** End of the manual-run cooldown on *this* clock, built by the Dashboard from
   * the `retryAfterMs` duration the server reported (never by mixing the server's
   * `lastForcedRunAt` epoch with `Date.now()`). The server enforces the window and
   * re-checks every request, so this only avoids futile clicks. */
  coolingUntil?: number;
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
//
// `error` deliberately shares the one resume button rather than getting a second
// "retry" action of its own: both would call the same `/resume` route, and two
// buttons for one behaviour is how a card ends up with contradictory affordances.
// The label is what differs (`card.resumeWatching` for the error case).
const PAUSABLE: WatchStatus[] = ['watching'];
const RESUMABLE: WatchStatus[] = ['paused', 'error'];

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
  // Tick fast while something is actually moving — a run request in flight or a
  // cooldown counting down — and relax to 30s otherwise: every tick re-renders
  // this card, so a permanent per-second interval on every idle card is wasted
  // work (review finding).
  //
  // `running` is part of that condition on purpose. `now` is otherwise up to 30s
  // stale, and the Dashboard sets `coolingUntil` from `Date.now()` the instant the
  // POST settles; without the in-flight fast tick that fresh value would be
  // compared against the stale `now`, showing an inflated countdown for a frame
  // ("Try again in 85s") — and the faster interval would not even engage, because
  // the stale `now` still reads the server fallback as expired.
  const coolingByResponse = Date.now() < (coolingUntil ?? 0);
  const coolingByTarget = Date.now() < (target.lastForcedRunAt ?? 0) + MANUAL_RUN_COOLDOWN_MS;
  // A dropped-run notice also needs the fast tick: it expires on the clock.
  const noticeLive = runNotice !== undefined && runNotice.until > Date.now();
  const now = useNow(running || coolingByResponse || coolingByTarget || noticeLive ? 1_000 : 30_000);
  const title = target.label ?? `${target.subject} ${target.courseNumber}`;
  const canRun = target.status === 'watching';
  const canPause = PAUSABLE.includes(target.status);
  const canResume = RESUMABLE.includes(target.status);
  const errored = canResume && target.status === 'error';
  // Derived, not stored: recomputed on every tick, so the button re-enables and
  // the notice disappears the moment the window really ends (review finding —
  // a frozen "Try again in 45s" outlived the cooldown and sat next to an
  // enabled button).
  //
  // Only meaningful while the course is actually being watched: once the target
  // leaves `watching` (the accepted run registered the course, the session was
  // lost, failures hit the limit) there is nothing left to retry, so "you can try
  // again in Ns" would be the same stale-claim-next-to-a-terminal-badge
  // contradiction the dropped notice is bounded to avoid (review finding).
  const cooldownSecs = Math.ceil(cooldownRemainingMs(target.lastForcedRunAt, coolingUntil, now) / 1000);
  const cooling = canRun && cooldownSecs > 0;
  // Same reasoning for the dropped-run verdict: it is shown for a bounded time and
  // then clears itself, so it cannot be left stranded next to a card that has moved
  // on (see NOTICE_TTL_MS in Dashboard.tsx).
  const droppedNotice = noticeLive ? runNotice.text : undefined;
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
        droppedNotice && (
          <div className="meta" role="status" data-testid="run-notice">
            {droppedNotice}
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
