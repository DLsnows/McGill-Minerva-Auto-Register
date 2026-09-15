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
 * Email notifications are temporarily sunset: no matter what a persisted store
 * says, the channel is forced off *before* the notifier can ever see it. This
 * covers legacy `store.json` files written back when the Settings page still
 * exposed the Email toggle — they are normalized and written back to disk so a
 * manual restart can't resurrect the channel either.
 *
 * Restoring the feature = deleting this function's call + the override in
 * `PUT /api/settings`. `notifier/email.ts`, `EmailConfig` and docs/EMAIL_SETUP.md
 * are intentionally kept for that.
 *
 * Returns true when it actually changed (and persisted) something.
 */
export function enforceEmailSunset(store: Store): boolean {
  const settings = store.getSettings();
  if (!settings.notify.email) return false;
  store.setSettings({ notify: { ...settings.notify, email: false } });
  return true;
}

/**
 * Wire the full scheduler runtime with real Minerva adapters + the notifier.
 * Normalizes the sunset email channel on the way in (see `enforceEmailSunset`).
 * The caller (P6 API) does `session.launch()` + `ensureLoggedIn()` before
 * `scheduler.start()`.
 */
export function createRuntime(onEvent?: (e: LogEvent) => void): Runtime {
  const session = new SessionManager();
  const store = new Store();
  enforceEmailSunset(store);
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
