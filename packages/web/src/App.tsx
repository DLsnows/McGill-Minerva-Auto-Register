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
  const queryBudget = s?.queryBudget ?? 100;
  const registerBudget = s?.registerBudget ?? 20;

  return (
    <div className="app-shell">
      <div
        className="top"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 12 }}
      >
        <h1 className="serif" style={{ fontSize: 30, margin: 0 }}>
          Synapse
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <NavPills />
          <LanguageSwitcher />
        </div>
      </div>
      <Ticker
        watching={(targets.data ?? []).filter((t) => t.status === 'watching').length}
        intervalMinutes={s?.pollIntervalMinutes ?? 30}
        jitterMinutes={s?.jitterMinutes ?? 3}
        queryUsed={queryBudget - (budget.data?.query ?? queryBudget)}
        queryBudget={queryBudget}
        registerUsed={registerBudget - (budget.data?.register ?? registerBudget)}
        registerBudget={registerBudget}
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
