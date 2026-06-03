import { useTranslation } from 'react-i18next';
import { setLang, type Lang } from '../i18n';

const OPTIONS: { lng: Lang; label: string }[] = [
  { lng: 'zh', label: '中文' },
  { lng: 'en', label: 'EN' },
  { lng: 'fr', label: 'FR' },
];

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language.slice(0, 2);
  return (
    <div className="nav glass" role="group" aria-label="language">
      {OPTIONS.map((o) => (
        <button
          key={o.lng}
          type="button"
          className={`pill ${current === o.lng ? 'pill-on' : ''}`}
          onClick={() => setLang(o.lng)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
