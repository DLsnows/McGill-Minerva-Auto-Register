interface Props {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  busy?: boolean;
}

export function SchedulerToggle({ running, onStart, onStop, busy }: Props) {
  return (
    <div className="toggle" style={{ gap: 12 }}>
      <span>
        <span className={`dot ${running ? 'dot-ok' : ''}`} />
        {running ? 'Watching · running' : 'Watching · stopped'}
      </span>
      <button
        type="button"
        className={`btn ${running ? '' : 'btn-accent'}`}
        onClick={running ? onStop : onStart}
        disabled={busy}
      >
        {running ? '■ Stop' : '▶ Start'}
      </button>
    </div>
  );
}
