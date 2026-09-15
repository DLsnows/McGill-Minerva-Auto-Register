import { useTranslation } from 'react-i18next';
import type { BudgetCount, SessionStatus } from '../lib/api';

interface Props {
  /** `undefined` while `/api/targets` is still in flight — or after it failed.
   * Either way there is no honest number to show, so the cell renders a
   * placeholder rather than a "0" that reads as "nothing is being watched". */
  watching?: number;
  /** `undefined` until `GET /api/settings` lands. Rendering the 30/±3 fallback
   * here would advertise a poll cadence the server may not be using. */
  intervalMinutes?: number;
  jitterMinutes?: number;
  /** Atomic daily-budget snapshot from `GET /api/budget`. `undefined` until the
   * first fetch lands (or if it failed) — rendered as a placeholder, never as a
   * made-up default. */
  budget?: { query: BudgetCount; register: BudgetCount };
  sessionStatus: SessionStatus;
}

const SESSION_KEY: Record<SessionStatus, { key: string; dot: string }> = {
  authenticated: { key: 'ticker.sessActive', dot: 'dot-ok' },
  'logging-in': { key: 'ticker.sessLoggingIn', dot: 'dot-warn' },
  'logged-out': { key: 'ticker.sessLoggedOut', dot: '' },
  unknown: { key: 'ticker.sessUnknown', dot: '' },
};

/**
 * Defensive clamp at the presentation boundary: the numerator is pinned into
 * `[0, denominator]` so a `9000 / 1000`-style ratio is unrepresentable here no
 * matter what the API sends. The server already guarantees consistency (see
 * `Budget.snapshot()`), so this only ever bites on genuinely broken data — in
 * which case `limit` is the honest ceiling to show.
 */
function clampUsed(count: BudgetCount): number {
  return Math.max(0, Math.min(count.used, count.limit));
}

function Counter({ count, testId }: { count?: BudgetCount; testId: string }) {
  const { t } = useTranslation();
  if (!count) {
    return (
      <span className="mono" data-testid={testId}>
        {t('ticker.notLoaded')}
      </span>
    );
  }
  return (
    <span className="mono" data-testid={testId}>
      {clampUsed(count)} / {count.limit}
    </span>
  );
}

export function Ticker(p: Props) {
  const { t } = useTranslation();
  const s = SESSION_KEY[p.sessionStatus];
  const hasCadence = p.intervalMinutes !== undefined;
  return (
    <div className="ticker glass">
      <div className="cell">
        <div className="k">{t('ticker.watching')}</div>
        {/* Same placeholder as the budget cells when the target list could not be
            read: "0" would claim "nothing is being watched" while the count is
            simply unknown. */}
        <div className="v">{p.watching ?? t('ticker.notLoaded')}</div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.interval')}</div>
        <div className="v">
          {hasCadence ? (
            <>
              {p.intervalMinutes} <small>{t('ticker.minSuffix', { j: p.jitterMinutes })}</small>
            </>
          ) : (
            <span className="mono">{t('ticker.notLoaded')}</span>
          )}
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.todayQuery')}</div>
        <div className="v">
          <Counter count={p.budget?.query} testId="ticker-query" />
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.todayRegister')}</div>
        <div className="v">
          <Counter count={p.budget?.register} testId="ticker-register" />
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.session')}</div>
        <div className="v">
          <span className={`dot ${s.dot}`} />
          {t(s.key)}
        </div>
      </div>
    </div>
  );
}
