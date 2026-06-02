# P7b — Courses / Session / Settings pages + shared data provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Synapse web UI — a shared data context, a Dashboard scheduler Start/Stop toggle, and the three remaining pages (Courses config, Session, Settings incl. email config).

**Architecture:** Lift the four shared resources (targets/session/budget/settings) plus scheduler status into a `DataProvider` React context consumed by the app shell and every page (removes P7a's double-fetch). Pages call the typed `api` client for mutations then refetch the relevant resource. The server gains a read-only scheduler-status endpoint so the Dashboard toggle reflects reality after reload.

**Tech Stack:** React 19, react-router-dom 7, Vitest + @testing-library/react (jsdom), Fastify.

**Reference:** Design spec `docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md` (§4 file structure, §8 P7b breakdown). Builds on P7a (merged PR #9). Decision: scheduler Start/Stop toggle lives at the **top of the Dashboard**.

---

## File Structure

```
Server:
  packages/server/src/scheduler/scheduler.ts        # MODIFY: isRunning()
  packages/server/src/scheduler/scheduler.test.ts   # MODIFY: isRunning test
  packages/server/src/api/server.ts                 # MODIFY: ApiScheduler.isRunning + GET /api/scheduler
  packages/server/src/api/server.test.ts            # MODIFY: stubs + GET test

Web:
  packages/web/src/lib/api.ts                        # MODIFY: getScheduler()
  packages/web/src/lib/api.test.ts                   # MODIFY: getScheduler test
  packages/web/src/lib/DataContext.tsx               # CREATE: DataProvider + useData
  packages/web/src/lib/DataContext.test.tsx          # CREATE
  packages/web/src/main.tsx                           # MODIFY: wrap in DataProvider
  packages/web/src/App.tsx                            # MODIFY: Shell consumes useData
  packages/web/src/pages/Dashboard.tsx                # MODIFY: consume useData + scheduler toggle
  packages/web/src/pages/Dashboard.test.tsx           # MODIFY: wrap in DataProvider
  packages/web/src/components/SchedulerToggle.tsx     # CREATE
  packages/web/src/components/SchedulerToggle.test.tsx# CREATE
  packages/web/src/components/CourseForm.tsx          # CREATE (shared add/edit form)
  packages/web/src/components/CourseForm.test.tsx     # CREATE
  packages/web/src/pages/Courses.tsx                  # REPLACE stub
  packages/web/src/pages/Courses.test.tsx             # CREATE
  packages/web/src/pages/Settings.tsx                 # REPLACE stub
  packages/web/src/pages/Settings.test.tsx            # CREATE
  packages/web/src/pages/Session.tsx                  # REPLACE stub
  packages/web/src/pages/Session.test.tsx             # CREATE
```

---

## Task 1: Server — scheduler status (`isRunning` + `GET /api/scheduler`)

**Files:**
- Modify: `packages/server/src/scheduler/scheduler.ts`, `packages/server/src/scheduler/scheduler.test.ts`
- Modify: `packages/server/src/api/server.ts`, `packages/server/src/api/server.test.ts`

- [ ] **Step 1: Add a failing test to `scheduler.test.ts`** (append inside `describe('Scheduler.runOnce', ...)` is wrong scope — add a new top-level `describe` at the end of the file, before the final newline):

```ts
describe('Scheduler.isRunning', () => {
  it('reflects start/stop', () => {
    const { scheduler } = setup({ decision: { action: 'NOOP', reason: 'x' } });
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: FAIL — `scheduler.isRunning is not a function`.

- [ ] **Step 3: Add `isRunning` to `Scheduler` in `scheduler.ts`** (place just after `stop()`)

```ts
  isRunning(): boolean {
    return this.timer !== null;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `isRunning` to the `ApiScheduler` interface in `server.ts`**

```ts
export interface ApiScheduler {
  start(tickMs?: number): void;
  stop(): void;
  runTarget(id: string): void;
  isRunning(): boolean;
}
```

- [ ] **Step 6: Add the GET route in `server.ts`** (place next to the scheduler start/stop routes)

```ts
  app.get('/api/scheduler', () => ({ running: deps.scheduler.isRunning() }));
```

- [ ] **Step 7: Update every scheduler stub in `server.test.ts`** — each `scheduler: { start: ..., stop: ..., runTarget: ... }` gains `isRunning: () => false`. There are several (the `makeDeps` helper plus inline ones in the lazy-check, login-timeout, run-endpoint, and non-watching tests). Find them with:

Run: `grep -rn "stop: () => undefined" packages/server/src/api/server.test.ts`

Edit each matched stub to read:

```ts
scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
```

(For the run-endpoint tests that use a `runTarget` spy, keep the spy and add `isRunning: () => false`.)

- [ ] **Step 8: Add a GET test to `server.test.ts`** (append inside `describe('API', ...)`)

```ts
  it('GET /api/scheduler reports running state', async () => {
    const store = new Store(dir);
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => true },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/scheduler' })).json()).toEqual({ running: true });
    await app2.close();
  });
```

- [ ] **Step 9: Run server tests + typecheck**

Run: `npx vitest run packages/server/src/api/server.test.ts && npm run typecheck -w @autoregister/server`
Expected: all pass; no type errors.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/scheduler/scheduler.ts packages/server/src/scheduler/scheduler.test.ts packages/server/src/api/server.ts packages/server/src/api/server.test.ts
git commit -m "feat(server): scheduler isRunning() + GET /api/scheduler"
```

---

## Task 2: Web — `api.getScheduler` + `DataProvider` context

**Files:**
- Modify: `packages/web/src/lib/api.ts`, `packages/web/src/lib/api.test.ts`
- Create: `packages/web/src/lib/DataContext.tsx`, `packages/web/src/lib/DataContext.test.tsx`

- [ ] **Step 1: Add a failing test for `getScheduler` in `api.test.ts`** (append inside `describe('api', ...)`)

```ts
  it('getScheduler GETs /api/scheduler', async () => {
    const f = mockFetch({ running: true });
    vi.stubGlobal('fetch', f);
    const out = await api.getScheduler();
    expect(f).toHaveBeenCalledWith('/api/scheduler', undefined);
    expect(out).toEqual({ running: true });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/api.test.ts`
Expected: FAIL — `api.getScheduler is not a function`.

- [ ] **Step 3: Add `getScheduler` to `api.ts`** (add an interface + method)

Add near `BudgetRemaining`:

```ts
export interface SchedulerState {
  running: boolean;
}
```

Add inside the `api` object (next to `startScheduler`):

```ts
  getScheduler: () => req<SchedulerState>('/api/scheduler'),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test `packages/web/src/lib/DataContext.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataProvider, useData } from './DataContext';
import { api } from './api';

function Probe() {
  const { targets, scheduler } = useData();
  return (
    <div>
      <span>targets:{targets.data?.length ?? '-'}</span>
      <span>running:{String(scheduler.data?.running ?? '-')}</span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('DataProvider', () => {
  it('loads and exposes the shared resources', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      { id: 't1', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: true });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(screen.getByText('targets:1')).toBeInTheDocument());
    expect(screen.getByText('running:true')).toBeInTheDocument();
  });

  it('throws if useData is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useData/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/DataContext.test.tsx`
Expected: FAIL — cannot find module `./DataContext`.

- [ ] **Step 7: Implement `packages/web/src/lib/DataContext.tsx`**

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { Settings, WatchTarget } from '@autoregister/shared';
import { api, type BudgetRemaining, type SchedulerState, type SessionInfo } from './api';
import { useResource, type Resource } from './useResource';

export interface DataContextValue {
  targets: Resource<WatchTarget[]>;
  session: Resource<SessionInfo>;
  budget: Resource<BudgetRemaining>;
  settings: Resource<Settings>;
  scheduler: Resource<SchedulerState>;
}

const DataContext = createContext<DataContextValue | null>(null);

/** Loads the shared app resources once and shares them with every page. */
export function DataProvider({ children }: { children: ReactNode }) {
  const value: DataContextValue = {
    targets: useResource(() => api.getTargets()),
    session: useResource(() => api.getSession()),
    budget: useResource(() => api.getBudget()),
    settings: useResource(() => api.getSettings()),
    scheduler: useResource(() => api.getScheduler()),
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
}
```

> Note: `useResource` (P7a) reads its fetcher through a ref, so passing inline `() => api.x()` is safe and won't loop.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/DataContext.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/api.test.ts packages/web/src/lib/DataContext.tsx packages/web/src/lib/DataContext.test.tsx
git commit -m "feat(web): api.getScheduler + DataProvider shared context"
```

---

## Task 3: Web — wire `DataProvider`, refactor Shell + Dashboard onto it

**Files:**
- Modify: `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/pages/Dashboard.tsx`, `packages/web/src/pages/Dashboard.test.tsx`

- [ ] **Step 1: Wrap the app in `DataProvider` — replace `packages/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './theme/theme.css';
import { DataProvider } from './lib/DataContext';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <DataProvider>
        <App />
      </DataProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 2: Refactor `Shell` in `App.tsx` to consume `useData`** — replace the `Shell` function (keep the `App` function with the `<Routes>` unchanged):

```tsx
function Shell() {
  const { targets, budget, session, settings } = useData();
  const s = settings.data;
  const queryBudget = s?.queryBudget ?? 100;
  const registerBudget = s?.registerBudget ?? 20;

  return (
    <div className="app-shell">
      <div
        className="top"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}
      >
        <h1 className="serif" style={{ fontSize: 30, margin: 0 }}>
          Synapse
        </h1>
        <NavPills />
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
```

- [ ] **Step 3: Update `App.tsx` imports** — replace the top import block so `useData` is imported and `useResource`/`api`/`useCallback` are no longer referenced by `Shell`:

```tsx
import { Outlet, Route, Routes } from 'react-router-dom';
import { useData } from './lib/DataContext';
import { NavPills } from './components/NavPills';
import { Ticker } from './components/Ticker';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Session from './pages/Session';
import Settings from './pages/Settings';
```

- [ ] **Step 4: Refactor `Dashboard.tsx` to consume `useData`** — replace the resource declarations (Ticker is in the Shell; Dashboard reads shared `targets`/`session` and keeps its own event stream + running state):

```tsx
import { useCallback, useState } from 'react';
import type { WatchMode } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { useEventStream } from '../lib/useEventStream';
import { CourseCard } from '../components/CourseCard';
import { Console } from '../components/Console';

export default function Dashboard() {
  const { targets, session } = useData();
  const { events, connected } = useEventStream();
  const [running, setRunning] = useState<Set<string>>(new Set());

  const onToggleMode = useCallback(
    async (id: string, next: WatchMode) => {
      await api.updateTarget(id, { mode: next });
      await targets.refetch();
    },
    [targets],
  );

  const onRun = useCallback(async (id: string) => {
    setRunning((s) => new Set(s).add(id));
    try {
      await api.runTarget(id);
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const list = targets.data ?? [];
  const sessionStatus = session.data?.status ?? 'unknown';
  const sessionDown = sessionStatus === 'logged-out' || sessionStatus === 'unknown';
```

(The JSX body below — banner, grid, cards, console — is unchanged from P7a.)

- [ ] **Step 5: Update `Dashboard.test.tsx` to render within `DataProvider`** — the Dashboard now calls `useData`, so wrap it and mock all five `api` getters. Replace the file with:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataProvider } from '../lib/DataContext';
import Dashboard from './Dashboard';
import { api } from '../lib/api';

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({ events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }], connected: true }),
}));

function mockApi(targets: Awaited<ReturnType<typeof api.getTargets>>, sessionStatus: 'authenticated' | 'logged-out') {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: sessionStatus });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderDashboard = () =>
  render(
    <DataProvider>
      <Dashboard />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Dashboard', () => {
  it('loads targets and renders a card + console', async () => {
    mockApi(
      [{ id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.getByText('hello-console')).toBeInTheDocument();
    expect(screen.getByText('Watched Courses')).toBeInTheDocument();
  });

  it('shows the empty state when there are no targets', async () => {
    mockApi([], 'logged-out');
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 6: Run the affected web tests**

Run: `npx vitest run packages/web/src/pages/Dashboard.test.tsx packages/web/src/lib/DataContext.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck + build web**

Run: `npm run typecheck -w @autoregister/web && npm run build -w @autoregister/web`
Expected: no type errors; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src
git commit -m "refactor(web): consume DataProvider in Shell + Dashboard (removes double-fetch)"
```

---

## Task 4: Web — `SchedulerToggle` on the Dashboard top

**Files:**
- Create: `packages/web/src/components/SchedulerToggle.tsx`, `packages/web/src/components/SchedulerToggle.test.tsx`
- Modify: `packages/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Write the failing test `packages/web/src/components/SchedulerToggle.test.tsx`**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulerToggle } from './SchedulerToggle';

describe('SchedulerToggle', () => {
  it('shows Start when stopped and calls onStart', async () => {
    const onStart = vi.fn();
    render(<SchedulerToggle running={false} onStart={onStart} onStop={() => {}} />);
    expect(screen.getByText(/stopped/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it('shows Stop when running and calls onStop', async () => {
    const onStop = vi.fn();
    render(<SchedulerToggle running={true} onStart={() => {}} onStop={onStop} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/components/SchedulerToggle.test.tsx`
Expected: FAIL — cannot find module `./SchedulerToggle`.

- [ ] **Step 3: Implement `packages/web/src/components/SchedulerToggle.tsx`**

```tsx
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
      <button type="button" className={`btn ${running ? '' : 'btn-accent'}`} onClick={running ? onStop : onStart}>
        {running ? '■ Stop' : '▶ Start'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/components/SchedulerToggle.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the toggle into `Dashboard.tsx`** — add `scheduler` to the `useData()` destructure and an `onToggleScheduler` handler, and render `SchedulerToggle` in the "Watched Courses" column header.

Change the destructure + add the handler (near `onRun`):

```tsx
  const { targets, session, scheduler } = useData();
```

```tsx
  const onToggleScheduler = useCallback(async () => {
    if (scheduler.data?.running) await api.stopScheduler();
    else await api.startScheduler();
    await scheduler.refetch();
  }, [scheduler]);
```

Add the import at the top of `Dashboard.tsx`:

```tsx
import { SchedulerToggle } from '../components/SchedulerToggle';
```

Replace the "Watched Courses" `col-h` block:

```tsx
          <div className="col-h">
            <h2 className="serif">Watched Courses</h2>
            <SchedulerToggle
              running={scheduler.data?.running ?? false}
              onStart={onToggleScheduler}
              onStop={onToggleScheduler}
            />
          </div>
```

- [ ] **Step 6: Run Dashboard test + typecheck**

Run: `npx vitest run packages/web/src/pages/Dashboard.test.tsx && npm run typecheck -w @autoregister/web`
Expected: PASS; no type errors. (Dashboard test already mocks `getScheduler`.)

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/SchedulerToggle.tsx packages/web/src/components/SchedulerToggle.test.tsx packages/web/src/pages/Dashboard.tsx
git commit -m "feat(web): scheduler Start/Stop toggle on the Dashboard"
```

---

## Task 5: Web — `CourseForm` (shared add/edit form)

**Files:**
- Create: `packages/web/src/components/CourseForm.tsx`, `packages/web/src/components/CourseForm.test.tsx`

- [ ] **Step 1: Write the failing test `packages/web/src/components/CourseForm.test.tsx`**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CourseForm } from './CourseForm';

describe('CourseForm', () => {
  it('blocks submit until required fields are filled', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/required/i)).toBeInTheDocument();
  });

  it('submits trimmed values when valid', async () => {
    const onSubmit = vi.fn();
    render(<CourseForm onSubmit={onSubmit} submitLabel="Add" />);
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith({
      term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', faculty: '', label: '', mode: 'auto',
    });
  });

  it('prefills from initial values for editing', () => {
    render(
      <CourseForm
        submitLabel="Save"
        initial={{ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '1814', faculty: '', label: 'COMP 551', mode: 'notify' }}
        onSubmit={() => {}}
      />,
    );
    expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe('1814');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('notify');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/components/CourseForm.test.tsx`
Expected: FAIL — cannot find module `./CourseForm`.

- [ ] **Step 3: Implement `packages/web/src/components/CourseForm.tsx`**

```tsx
import { useState } from 'react';
import type { WatchMode } from '@autoregister/shared';

export interface CourseFormValues {
  term: string;
  subject: string;
  courseNumber: string;
  targetCrn: string;
  faculty: string;
  label: string;
  mode: WatchMode;
}

const EMPTY: CourseFormValues = {
  term: '', subject: '', courseNumber: '', targetCrn: '', faculty: '', label: '', mode: 'auto',
};

interface Props {
  onSubmit: (v: CourseFormValues) => void;
  submitLabel: string;
  initial?: CourseFormValues;
  onCancel?: () => void;
}

const FIELDS: { key: keyof CourseFormValues; label: string; required?: boolean }[] = [
  { key: 'term', label: 'Term', required: true },
  { key: 'subject', label: 'Subject', required: true },
  { key: 'courseNumber', label: 'Course #', required: true },
  { key: 'targetCrn', label: 'Target CRN', required: true },
  { key: 'faculty', label: 'Faculty' },
  { key: 'label', label: 'Label' },
];

export function CourseForm({ onSubmit, submitLabel, initial, onCancel }: Props) {
  const [v, setV] = useState<CourseFormValues>(initial ?? EMPTY);
  const [err, setErr] = useState<string>();

  const submit = () => {
    const trimmed: CourseFormValues = {
      ...v,
      term: v.term.trim(),
      subject: v.subject.trim(),
      courseNumber: v.courseNumber.trim(),
      targetCrn: v.targetCrn.trim(),
      faculty: v.faculty.trim(),
      label: v.label.trim(),
    };
    if (!trimmed.term || !trimmed.subject || !trimmed.courseNumber || !trimmed.targetCrn) {
      setErr('Term, Subject, Course # and Target CRN are required.');
      return;
    }
    setErr(undefined);
    onSubmit(trimmed);
  };

  return (
    <div className="card glass">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            {f.label}
            <input
              aria-label={f.label}
              className="mock-input"
              style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }}
              value={v[f.key] as string}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          Mode
          <select
            aria-label="Mode"
            style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }}
            value={v.mode}
            onChange={(e) => setV({ ...v, mode: e.target.value as WatchMode })}
          >
            <option value="auto">auto</option>
            <option value="notify">notify</option>
          </select>
        </label>
      </div>
      {err && <div className="errbar">{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-accent" onClick={submit}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/components/CourseForm.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/CourseForm.tsx packages/web/src/components/CourseForm.test.tsx
git commit -m "feat(web): CourseForm (shared add/edit form)"
```

---

## Task 6: Web — Courses page (list + add + edit + delete)

**Files:**
- Replace: `packages/web/src/pages/Courses.tsx`
- Create: `packages/web/src/pages/Courses.test.tsx`

- [ ] **Step 1: Write the failing test `packages/web/src/pages/Courses.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Courses from './Courses';
import { api } from '../lib/api';

function mockAll(targets: Awaited<ReturnType<typeof api.getTargets>>) {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderCourses = () =>
  render(
    <DataProvider>
      <Courses />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Courses', () => {
  it('lists existing targets', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    renderCourses();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
  });

  it('adds a course via the form', async () => {
    mockAll([]);
    const add = vi.spyOn(api, 'addTarget').mockResolvedValue({
      id: 'new', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0,
    });
    renderCourses();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add course' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ subject: 'COMP', targetCrn: '2347' })));
  });

  it('deletes a target', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(del).toHaveBeenCalledWith('t1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/pages/Courses.test.tsx`
Expected: FAIL — `Courses` is still the stub (no form/list).

- [ ] **Step 3: Implement `packages/web/src/pages/Courses.tsx`**

```tsx
import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { CourseForm, type CourseFormValues } from '../components/CourseForm';
import { StatusBadge } from '../components/StatusBadge';

export default function Courses() {
  const { targets } = useData();
  const [editing, setEditing] = useState<string | null>(null);
  const list = targets.data ?? [];

  const add = async (v: CourseFormValues) => {
    await api.addTarget({
      term: v.term, subject: v.subject, courseNumber: v.courseNumber, targetCrn: v.targetCrn,
      faculty: v.faculty || undefined, label: v.label || undefined, mode: v.mode,
    });
    await targets.refetch();
  };

  const saveEdit = async (id: string, v: CourseFormValues) => {
    await api.updateTarget(id, {
      term: v.term, subject: v.subject, courseNumber: v.courseNumber, targetCrn: v.targetCrn,
      faculty: v.faculty || undefined, label: v.label || undefined, mode: v.mode,
    });
    setEditing(null);
    await targets.refetch();
  };

  const remove = async (id: string) => {
    await api.removeTarget(id);
    await targets.refetch();
  };

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Add a course</h2>
      </div>
      <CourseForm submitLabel="Add course" onSubmit={add} />

      <div className="col-h" style={{ marginTop: 22 }}>
        <h2 className="serif">Managed courses</h2>
      </div>
      {list.length === 0 ? (
        <div className="empty glass">No courses yet.</div>
      ) : (
        <div className="cards">
          {list.map((t) =>
            editing === t.id ? (
              <CourseForm
                key={t.id}
                submitLabel="Save"
                initial={{
                  term: t.term, subject: t.subject, courseNumber: t.courseNumber, targetCrn: t.targetCrn,
                  faculty: t.faculty ?? '', label: t.label ?? '', mode: t.mode,
                }}
                onSubmit={(v) => saveEdit(t.id, v)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div key={t.id} className="card glass">
                <div className="row1">
                  <div>
                    <div className="title">{t.label ?? `${t.subject} ${t.courseNumber}`}</div>
                    <div className="crn">
                      CRN {t.targetCrn} · {t.term} · {t.mode}
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn" onClick={() => setEditing(t.id)}>
                    Edit
                  </button>
                  <button type="button" className="btn" onClick={() => remove(t.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/pages/Courses.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/Courses.tsx packages/web/src/pages/Courses.test.tsx
git commit -m "feat(web): Courses page (list / add / edit / delete)"
```

---

## Task 7: Web — Settings page (settings + email config + doc link)

**Files:**
- Replace: `packages/web/src/pages/Settings.tsx`
- Create: `packages/web/src/pages/Settings.test.tsx`

- [ ] **Step 1: Write the failing test `packages/web/src/pages/Settings.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import SettingsPage from './Settings';
import { api } from '../lib/api';

function mockAll() {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderSettings = () =>
  render(
    <DataProvider>
      <SettingsPage />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Settings', () => {
  it('prefills and saves general settings', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 45, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() => expect((screen.getByLabelText('Poll interval (min)') as HTMLInputElement).value).toBe('30'));
    await userEvent.clear(screen.getByLabelText('Poll interval (min)'));
    await userEvent.type(screen.getByLabelText('Poll interval (min)'), '45');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMinutes: 45 })));
  });

  it('blocks save when email notify is on but email fields are incomplete', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    await waitFor(() => screen.getByLabelText('Email notifications'));
    await userEvent.click(screen.getByLabelText('Email notifications'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/email .*required/i)).toBeInTheDocument();
  });

  it('links to the email setup guide', async () => {
    mockAll();
    renderSettings();
    await waitFor(() => screen.getByLabelText('Email notifications'));
    const link = screen.getByRole('link', { name: /setup guide/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('EMAIL_SETUP.md'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/pages/Settings.test.tsx`
Expected: FAIL — `Settings` is still the stub.

- [ ] **Step 3: Implement `packages/web/src/pages/Settings.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { EmailConfig, Settings } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';

const DOC_URL = 'https://github.com/DLsnows/McGill-Minerva-Auto-Register/blob/dev/docs/EMAIL_SETUP.md';
const EMPTY_EMAIL: EmailConfig = { host: '', port: 587, user: '', pass: '', to: '' };

const numField = (
  label: string,
  value: number,
  onChange: (n: number) => void,
) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
    {label}
    <input
      aria-label={label}
      type="number"
      className="mock-input"
      style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </label>
);

export default function SettingsPage() {
  const { settings } = useData();
  const [form, setForm] = useState<Settings | null>(null);
  const [email, setEmail] = useState<EmailConfig>(EMPTY_EMAIL);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
      setEmail(settings.data.email ?? EMPTY_EMAIL);
    }
  }, [settings.data, form]);

  if (!form) return <div className="empty">Loading settings…</div>;

  const emailComplete = Boolean(email.host && email.user && email.pass && email.to && email.port);

  const save = async () => {
    if (form.notify.email && !emailComplete) {
      setErr('All email fields are required when email notifications are enabled.');
      return;
    }
    setErr(undefined);
    await api.putSettings({ ...form, email: form.notify.email || emailComplete ? email : undefined });
    await settings.refetch();
    setSaved(true);
  };

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Settings</h2>
      </div>

      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {numField('Poll interval (min)', form.pollIntervalMinutes, (n) => setForm({ ...form, pollIntervalMinutes: n }))}
          {numField('Jitter (min)', form.jitterMinutes, (n) => setForm({ ...form, jitterMinutes: n }))}
          {numField('Query budget / day', form.queryBudget, (n) => setForm({ ...form, queryBudget: n }))}
          {numField('Register budget / day', form.registerBudget, (n) => setForm({ ...form, registerBudget: n }))}
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
          <label><input type="checkbox" checked={form.notify.desktop} onChange={(e) => setForm({ ...form, notify: { ...form.notify, desktop: e.target.checked } })} aria-label="Desktop notifications" /> Desktop</label>
          <label><input type="checkbox" checked={form.notify.sound} onChange={(e) => setForm({ ...form, notify: { ...form.notify, sound: e.target.checked } })} aria-label="Sound" /> Sound</label>
          <label><input type="checkbox" checked={form.notify.email} onChange={(e) => setForm({ ...form, notify: { ...form.notify, email: e.target.checked } })} aria-label="Email notifications" /> Email</label>
        </div>
      </div>

      <div className="col-h" style={{ marginTop: 22 }}>
        <h2 className="serif">Email (SMTP)</h2>
        <a className="btn" href={DOC_URL} target="_blank" rel="noreferrer">Setup guide ↗</a>
      </div>
      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>SMTP host
            <input aria-label="SMTP host" className="mock-input" style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }} value={email.host} onChange={(e) => setEmail({ ...email, host: e.target.value })} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>Port
            <input aria-label="SMTP port" type="number" className="mock-input" style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }} value={email.port} onChange={(e) => setEmail({ ...email, port: Number(e.target.value) })} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>User
            <input aria-label="SMTP user" className="mock-input" style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }} value={email.user} onChange={(e) => setEmail({ ...email, user: e.target.value })} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>Password / app key
            <input aria-label="SMTP pass" type="password" className="mock-input" style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }} value={email.pass} onChange={(e) => setEmail({ ...email, pass: e.target.value })} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>Send to
            <input aria-label="Email to" className="mock-input" style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)' }} value={email.to} onChange={(e) => setEmail({ ...email, to: e.target.value })} /></label>
        </div>
      </div>

      {err && <div className="errbar">{err}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button type="button" className="btn btn-accent" onClick={save}>Save settings</button>
        {saved && <span style={{ color: 'var(--color-green)', fontSize: 12 }}>Saved ✓</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/pages/Settings.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/Settings.tsx packages/web/src/pages/Settings.test.tsx
git commit -m "feat(web): Settings page (intervals/budgets/notify + email config + doc link)"
```

---

## Task 8: Web — Session page (status + login)

**Files:**
- Replace: `packages/web/src/pages/Session.tsx`
- Create: `packages/web/src/pages/Session.test.tsx`

- [ ] **Step 1: Write the failing test `packages/web/src/pages/Session.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Session from './Session';
import { api } from '../lib/api';

function mockAll(status: 'authenticated' | 'logged-out') {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderSession = () =>
  render(
    <DataProvider>
      <Session />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Session', () => {
  it('shows the current status', async () => {
    mockAll('authenticated');
    renderSession();
    await waitFor(() => expect(screen.getByText(/authenticated/i)).toBeInTheDocument());
  });

  it('triggers login on button click', async () => {
    mockAll('logged-out');
    const login = vi.spyOn(api, 'login').mockResolvedValue({ started: true });
    renderSession();
    await waitFor(() => screen.getByRole('button', { name: /log in/i }));
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(login).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/pages/Session.test.tsx`
Expected: FAIL — `Session` is still the stub.

- [ ] **Step 3: Implement `packages/web/src/pages/Session.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { api, type SessionStatus } from '../lib/api';
import { useData } from '../lib/DataContext';

const LABEL: Record<SessionStatus, string> = {
  authenticated: 'Authenticated — automation can run.',
  'logging-in': 'Logging in… a browser window should be open.',
  'logged-out': 'Logged out — log in to let polling run.',
  unknown: 'Unknown — log in to establish a session.',
};

export default function Session() {
  const { session } = useData();
  const status = session.data?.status ?? 'unknown';
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // While logging in, poll the status until it resolves.
  useEffect(() => {
    if (status === 'logging-in' && !pollRef.current) {
      let n = 0;
      pollRef.current = setInterval(() => {
        n += 1;
        void session.refetch();
        if (n >= 12 && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 3000);
    }
    if (status !== 'logging-in' && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status, session]);

  const login = async () => {
    setBusy(true);
    try {
      await api.login();
      await session.refetch();
    } finally {
      setBusy(false);
    }
  };

  const dot = status === 'authenticated' ? 'dot-ok' : status === 'logging-in' ? 'dot-warn' : '';

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Session</h2>
      </div>
      <div className="card glass">
        <div style={{ fontSize: 16, marginBottom: 8 }}>
          <span className={`dot ${dot}`} />
          {status}
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, marginBottom: 14 }}>{LABEL[status]}</div>
        <button type="button" className="btn btn-accent" onClick={login} disabled={busy}>
          {busy ? 'Opening browser…' : 'Open browser & log in'}
        </button>
        <div style={{ color: 'var(--tx-3)', fontSize: 12, marginTop: 14 }}>
          McGill allows one active session — logging in elsewhere will evict the automation.
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/pages/Session.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/Session.tsx packages/web/src/pages/Session.test.tsx
git commit -m "feat(web): Session page (status + login)"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all node + web tests pass.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Build web**

Run: `npm run build:web`
Expected: builds.

- [ ] **Step 4: Runtime smoke (flag to user; not automated).** `npm run serve`, open http://127.0.0.1:4575 — verify Courses add/edit/delete, Settings save (incl. email validation + guide link), Session login button, and the Dashboard scheduler Start/Stop toggle. Live data needs a logged-in session.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: P7b final verification"
```

---

## Self-Review notes (resolved during planning)

- **Spec coverage:** Courses config (Task 6), Session page (Task 8), Settings incl. email + doc link (Task 7) — the three P7b pages from spec §8. Plus the deferred-from-P7a shared data provider (Tasks 2-3) and the scheduler Start/Stop control decided for the Dashboard top (Tasks 1, 4).
- **Type consistency:** `api.getScheduler(): SchedulerState` matches `ApiScheduler.isRunning(): boolean` + `GET /api/scheduler` shape `{ running }`. `DataContextValue` resources match `useData()` consumers in Shell/Dashboard/Courses/Settings/Session. `CourseFormValues` is shared by CourseForm and Courses add/edit. `EmailConfig` fields (host/port/user/pass/to) match the server `emailSchema`.
- **Placeholder scan:** no TBD/TODO; every component/page has full code + tests.
- **Test env:** all page tests wrap the component in `DataProvider` and mock the five `api` getters (incl. `getScheduler`), since pages now consume the shared context.
