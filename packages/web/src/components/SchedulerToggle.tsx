interface Props {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function SchedulerToggle({ running, onStart, onStop }: Props) {
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
      >
        {running ? '■ Stop' : '▶ Start'}
      </button>
    </div>
  );
}
