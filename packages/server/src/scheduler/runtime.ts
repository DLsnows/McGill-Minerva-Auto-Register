import type { LogEvent } from '@autoregister/shared';
import { QueryClient } from '../minerva/query-client';
import { RegisterClient } from '../minerva/register-client';
import { Notifier } from '../notifier/notifier';
import { SessionManager } from '../session/session-manager';
import { Budget } from '../budget/budget';
import { Store } from '../store/store';
import { createKeepAwake, type KeepAwakeManagerHandle } from '../system/keep-awake';
import { applyPacingSettings } from '../util/pacing';
import { Scheduler } from './scheduler';

export interface Runtime {
  store: Store;
  budget: Budget;
  session: SessionManager;
  notifier: Notifier;
  scheduler: Scheduler;
  /** The manager handle (not the bare `KeepAwake` interface) so process-teardown code
   * can call the synchronous `killChildSync()` from an `exit` handler. */
  keepAwake: KeepAwakeManagerHandle;
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
 * Normalizes the sunset email channel (see `enforceEmailSunset`) and applies the
 * persisted operation speed on the way in.
 * The caller (P6 API) does `session.launch()` + `ensureLoggedIn()` before
 * `scheduler.start()`.
 */
export function createRuntime(onEvent?: (e: LogEvent) => void): Runtime {
  const session = new SessionManager();
  const store = new Store();
  enforceEmailSunset(store);
  // Apply the persisted operation speed before anything can poll: `humanPause()`
  // reads this module-level config on every call. Later settings saves re-apply it.
  applyPacingSettings(store.getSettings());
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
  // Windows-only keep-awake: report state changes to the live console so the
  // user can see when a laptop switches to battery and the hold is released.
  const keepAwake = createKeepAwake({
    onEvent: (message, level) => {
      const event = store.appendEvent({ level, message });
      onEvent?.(event);
    },
  });
  // Resume the persisted preference on startup (it is opt-in and off by default).
  // Fire-and-forget: the first tick awaits an async PowerShell probe, and startup must
  // not block on it. Errors are swallowed by the probe itself (it degrades to
  // 'unknown'), and a rejection here would otherwise be an unhandled rejection.
  if (store.getSettings().keepAwake === true) {
    void keepAwake.start().catch((err: unknown) => {
      console.error(
        '[keep-awake] failed to resume on startup:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }
  return { store, budget, session, notifier, scheduler, keepAwake };
}
