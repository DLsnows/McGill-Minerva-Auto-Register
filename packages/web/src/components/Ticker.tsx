import { useTranslation } from 'react-i18next';
import type { BudgetCount, SessionStatus } from '../lib/api';

interface Props {
  watching: number;
  intervalMinutes: number;
  jitterMinutes: number;
  /** Atomic daily-budget snapshot from `GET /api/budget`. `undefined` until the
   * first fetch lands — rendered as a placeholder, never as a made-up default. */
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

function Counter({ count }: { count?: BudgetCount }) {
  const { t } = useTranslation();
  if (!count) return <span className="mono">{t('ticker.notLoaded')}</span>;
  return (
    <span className="mono">
      {clampUsed(count)} / {count.limit}
    </span>
  );
}

export function Ticker(p: Props) {
  const { t } = useTranslation();
  const s = SESSION_KEY[p.sessionStatus];
  return (
    <div className="ticker glass">
      <div className="cell">
        <div className="k">{t('ticker.watching')}</div>
        <div className="v">{p.watching}</div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.interval')}</div>
        <div className="v">
          {p.intervalMinutes} <small>{t('ticker.minSuffix', { j: p.jitterMinutes })}</small>
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.todayQuery')}</div>
        <div className="v">
          <Counter count={p.budget?.query} />
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.todayRegister')}</div>
        <div className="v">
          <Counter count={p.budget?.register} />
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
