import { useTranslation } from 'react-i18next';
import type { WatchMode } from '@autoregister/shared';

export function ModeToggle({ mode, onToggle }: { mode: WatchMode; onToggle: (next: WatchMode) => void }) {
  const { t } = useTranslation();
  const auto = mode === 'auto';
  return (
    <div className="toggle">
      {t('mode.notify')}
      <button
        type="button"
        aria-label={t('mode.toggleAria')}
        aria-pressed={auto}
        className={`sw ${auto ? 'sw-on' : ''}`}
        onClick={() => onToggle(auto ? 'notify' : 'auto')}
      >
        <i />
      </button>
      {t('mode.auto')}
    </div>
  );
}
