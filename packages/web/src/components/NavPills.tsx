import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const TABS = [
  { to: '/', key: 'nav.dashboard', end: true },
  { to: '/courses', key: 'nav.courses' },
  { to: '/session', key: 'nav.session' },
  { to: '/settings', key: 'nav.settings' },
];

export function NavPills() {
  const { t } = useTranslation();
  return (
    <div className="nav glass">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `pill ${isActive ? 'pill-on' : ''}`}
        >
          {t(tab.key)}
        </NavLink>
      ))}
    </div>
  );
}
