import 'dotenv/config';
import type { LogEvent } from '@autoregister/shared';
import { QueryClient } from '../minerva/query-client';
import { RegisterClient } from '../minerva/register-client';
import { Notifier } from '../notifier/notifier';
import { SessionManager } from '../session/session-manager';
import { Budget } from '../budget/budget';
import { Store } from '../store/store';
import { Scheduler } from './scheduler';

export interface Runtime {
  store: Store;
  budget: Budget;
  session: SessionManager;
  notifier: Notifier;
  scheduler: Scheduler;
}

/**
 * Wire the full scheduler runtime with real Minerva adapters + the notifier.
 * Loads `.env` for SMTP. The caller (P6 API) does `session.launch()` +
 * `ensureLoggedIn()` before `scheduler.start()`.
 */
export function createRuntime(onEvent?: (e: LogEvent) => void): Runtime {
  const session = new SessionManager();
  const store = new Store();
  const budget = new Budget(store);
  const notifier = new Notifier(() => store.getSettings());
  const scheduler = new Scheduler({
    store,
    budget,
    session,
    watcher: new QueryClient(session),
    actor: new RegisterClient(session),
    onEvent: (e) => {
      void notifier.notify(e);
      onEvent?.(e);
    },
  });
  return { store, budget, session, notifier, scheduler };
}
