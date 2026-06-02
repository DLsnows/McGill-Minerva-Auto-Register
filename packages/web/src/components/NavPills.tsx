import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/courses', label: 'Courses' },
  { to: '/session', label: 'Session' },
  { to: '/settings', label: 'Settings' },
];

export function NavPills() {
  return (
    <div className="nav glass">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => `pill ${isActive ? 'pill-on' : ''}`}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
