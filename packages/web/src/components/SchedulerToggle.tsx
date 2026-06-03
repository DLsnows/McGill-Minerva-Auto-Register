import { useTranslation } from 'react-i18next';

interface Props {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  busy?: boolean;
}

export function SchedulerToggle({ running, onStart, onStop, busy }: Props) {
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
        disabled={busy}
      >
        {running ? t('scheduler.stop') : t('scheduler.start')}
      </button>
    </div>
  );
}
