import { Outlet, Route, Routes } from 'react-router-dom';
import { useData } from './lib/DataContext';
import { NavPills } from './components/NavPills';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { Ticker } from './components/Ticker';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Session from './pages/Session';
import Settings from './pages/Settings';

function Shell() {
  const { targets, budget, session, settings } = useData();
  const s = settings.data;

  return (
    <div className="app-shell">
      <div
        className="top"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 12 }}
      >
        <div>
          <h1 className="serif" style={{ fontSize: 30, margin: 0, lineHeight: 1.05 }}>
            MMAR
          </h1>
          <div style={{ fontSize: 11, color: 'var(--tx-2)', letterSpacing: '0.5px', marginTop: 2 }}>
            McGill-Minerva-Auto-Register
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <NavPills />
          <LanguageSwitcher />
        </div>
      </div>
      {/* The ticker renders the budget snapshot as-is. It must never derive a
          used-count by subtracting a remaining-count from a limit: those two
          numbers came from different reads and produced impossible ratios like
          "9000 / 1000" right after the daily limit was raised. */}
      <Ticker
        watching={(targets.data ?? []).filter((t) => t.status === 'watching').length}
        intervalMinutes={s?.pollIntervalMinutes ?? 30}
        jitterMinutes={s?.jitterMinutes ?? 3}
        budget={budget.data}
        sessionStatus={session.data?.status ?? 'unknown'}
      />
      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="courses" element={<Courses />} />
        <Route path="session" element={<Session />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
