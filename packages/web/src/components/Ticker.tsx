import { useTranslation } from 'react-i18next';
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

const SESSION_KEY: Record<SessionStatus, { key: string; dot: string }> = {
  authenticated: { key: 'ticker.sessActive', dot: 'dot-ok' },
  'logging-in': { key: 'ticker.sessLoggingIn', dot: 'dot-warn' },
  'logged-out': { key: 'ticker.sessLoggedOut', dot: '' },
  unknown: { key: 'ticker.sessUnknown', dot: '' },
};

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
        <div className="v mono">
          {p.queryUsed} / {p.queryBudget}
        </div>
      </div>
      <div className="cell">
        <div className="k">{t('ticker.todayRegister')}</div>
        <div className="v mono">
          {p.registerUsed} / {p.registerBudget}
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
