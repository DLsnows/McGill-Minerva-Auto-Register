import { createContext, useContext, useMemo, type ReactNode } from 'react';
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
  const targets = useResource(() => api.getTargets());
  const session = useResource(() => api.getSession());
  const budget = useResource(() => api.getBudget());
  const settings = useResource(() => api.getSettings());
  const scheduler = useResource(() => api.getScheduler());
  // Each resource is referentially stable until its own data changes (see
  // useResource), so this memo only produces a new value when something changed.
  const value = useMemo<DataContextValue>(
    () => ({ targets, session, budget, settings, scheduler }),
    [targets, session, budget, settings, scheduler],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
}
