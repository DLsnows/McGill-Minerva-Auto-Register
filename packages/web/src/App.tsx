import { Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useData } from './lib/DataContext';
import { NavPills } from './components/NavPills';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { ResourceError } from './components/ResourceError';
import { Ticker } from './components/Ticker';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Session from './pages/Session';
import Settings from './pages/Settings';

/** Routes whose page renders the target list — and therefore already reports a
 * failed `GET /api/targets` itself. Everywhere else the shell has to, or the
 * ticker's watched-count cell would be the only trace of the failure: a `— / —`
 * with no explanation and no retry.
 *
 * Normalized before matching: `/courses/` is the same route to react-router but a
 * different string to `includes`, and getting this wrong stacks the shell's bar on
 * top of the page's — one failure with two retry buttons. */
const TARGETS_OWNED_BY_PAGE = ['/', '/courses'];

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

function Shell() {
  const { t } = useTranslation();
  const { targets, budget, session, settings } = useData();
  const { pathname } = useLocation();
  const s = settings.data;
  const pageReportsTargets = TARGETS_OWNED_BY_PAGE.includes(normalizePath(pathname));

  return (
    <div className="app-shell">
      <div
        className="top"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 18,
          gap: 12,
        }}
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
      {/* The ticker is fed by `settings`, `budget` and `targets`, and it is the
          only always-visible consumer of the first two — so the shell owns their
          error bars and every route gets an explanation plus a retry:
          - `budget` → nothing else renders it, so this bar is its only home.
          - `settings` → the Settings page consumes it too, but only that one
            route could report it, and the failure is already visible on *every*
            route through the cadence cell below. Report it here alone; the
            Settings page stays quiet so one failure still yields exactly one bar
            and one retry.
          - `targets` → owned by the Dashboard / Courses pages, which render the
            list itself; on every other route the shell takes over, otherwise the
            watched-count cell below is the only trace of the failure.
          The bars sit ABOVE the ticker on purpose: that is where the Settings
          page's hint points ("use ⟳ Retry in the bar above the ticker"), and a
          bar placed under the row of cells it explains reads as belonging to the
          page content instead.
          Before this, `resource.error` was read nowhere in the app and a single
          transient failure left no visible trace at all. */}
      <ResourceError resource={settings} label={t('ticker.settingsLabel')} />
      <ResourceError resource={budget} label={t('ticker.budgetLabel')} />
      {!pageReportsTargets && (
        <ResourceError resource={targets} label={t('ticker.watchingLabel')} />
      )}
      <Ticker
        // `data === undefined` covers both "still fetching" and "fetch failed":
        // in neither case is there a number honest enough to show, and a "0"
        // would claim that nothing is being watched.
        watching={targets.data?.filter((t) => t.status === 'watching').length}
        intervalMinutes={s?.pollIntervalMinutes}
        jitterMinutes={s?.jitterMinutes}
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
