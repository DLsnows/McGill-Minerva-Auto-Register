import type { WatchMode } from '@autoregister/shared';

export function ModeToggle({ mode, onToggle }: { mode: WatchMode; onToggle: (next: WatchMode) => void }) {
  const auto = mode === 'auto';
  return (
    <div className="toggle">
      Notify
      <button
        type="button"
        aria-label="toggle mode"
        aria-pressed={auto}
        className={`sw ${auto ? 'sw-on' : ''}`}
        onClick={() => onToggle(auto ? 'notify' : 'auto')}
      >
        <i />
      </button>
      Auto
    </div>
  );
}
