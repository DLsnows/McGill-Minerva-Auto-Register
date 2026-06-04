import { useTranslation } from 'react-i18next';

interface Props {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  busy?: boolean;
  /** When false, the "Start all" action is blocked (e.g. not logged in). Stopping
   * is always allowed. */
  canStart?: boolean;
}

export function SchedulerToggle({ running, onStart, onStop, busy, canStart = true }: Props) {
  const { t } = useTranslation();
  return (
    <div className="toggle" style={{ gap: 12 }}>
      <span>
        <span className={`dot ${running ? 'dot-ok' : ''}`} />
        {running ? t('scheduler.running') : t('scheduler.stopped')}
      </span>
      <button
        type="button"
        className={`btn ${running ? '' : 'btn-accent'}`}
        onClick={running ? onStop : onStart}
        disabled={busy || (!running && !canStart)}
        title={!running && !canStart ? t('scheduler.loginFirst') : undefined}
      >
        {running ? t('scheduler.stop') : t('scheduler.start')}
      </button>
    </div>
  );
}
