import type { LogEvent } from '@autoregister/shared';
import { QueryClient } from '../minerva/query-client';
import { RegisterClient } from '../minerva/register-client';
import { SessionManager } from '../session/session-manager';
import { Budget } from '../budget/budget';
import { Store } from '../store/store';
import { Scheduler } from './scheduler';

export interface Runtime {
  store: Store;
  budget: Budget;
  session: SessionManager;
  scheduler: Scheduler;
}

/**
 * Wire the full scheduler runtime with real Minerva adapters. The caller (P6
 * API) is responsible for `session.launch()` + `ensureLoggedIn()` before
 * `scheduler.start()`.
 */
export function createRuntime(onEvent?: (e: LogEvent) => void): Runtime {
  const session = new SessionManager();
  const store = new Store();
  const budget = new Budget(store);
  const scheduler = new Scheduler({
    store,
    budget,
    session,
    watcher: new QueryClient(session),
    actor: new RegisterClient(session),
    onEvent,
  });
  return { store, budget, session, scheduler };
}
