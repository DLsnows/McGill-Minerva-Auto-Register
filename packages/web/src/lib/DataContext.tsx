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
