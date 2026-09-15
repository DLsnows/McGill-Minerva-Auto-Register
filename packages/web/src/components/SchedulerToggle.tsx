import { useTranslation } from 'react-i18next';

interface Props {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  busy?: boolean;
  /** When false, the "Start all" action is blocked (e.g. not logged in). Stopping
   * is always allowed. */
  canStart?: boolean;
  /** The engine's real state has not been read yet, so `running: false` means "unknown"
   * rather than "stopped". The control refuses to act instead of guessing. */
  loading?: boolean;
}

export function SchedulerToggle({
  running,
  onStart,
  onStop,
  busy,
  canStart = true,
  loading = false,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="toggle" style={{ gap: 12 }}>
      <span>
        <span className={`dot ${running ? 'dot-ok' : ''}`} />
        {loading
          ? t('scheduler.loading')
          : running
            ? t('scheduler.running')
            : t('scheduler.stopped')}
      </span>
      <button
        type="button"
        className={`btn ${running ? '' : 'btn-accent'}`}
        onClick={running ? onStop : onStart}
        disabled={busy || loading || (!running && !canStart)}
        title={!running && !canStart ? t('scheduler.loginFirst') : undefined}
      >
        {running ? t('scheduler.stop') : t('scheduler.start')}
      </button>
    </div>
  );
}
