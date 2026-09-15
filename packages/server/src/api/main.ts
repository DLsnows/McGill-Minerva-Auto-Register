import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import type { LogLevel } from '@autoregister/shared';
import { createRuntime, type Runtime } from '../scheduler/runtime';
import { broadcast, buildServer } from './server';

const PORT = Number(process.env.PORT ?? 4575);

/** Render an untrusted thrown value for a log line. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** True when `err` is Node's EADDRINUSE (the port is already taken). */
function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/**
 * Surface a process-level (or startup-level) fault in the app's own event log —
 * and therefore in the web console — instead of only on the server's stdout.
 *
 * `Runtime.store` is injected rather than imported so this stays testable, and every
 * store call is guarded: this runs while the process is already in trouble, and a
 * store that is itself the failing component must not turn the reporter into a
 * second, louder failure. Returns whether the event reached the persisted log.
 */
export function recordFatal(
  rt: Runtime,
  message: string,
  level: LogLevel = 'error',
  data?: unknown,
): boolean {
  try {
    const ev = rt.store.appendEvent({ level, message, data });
    try {
      rt.onEvent?.(ev);
    } catch (relayErr) {
      console.error(`[fatal] event relay failed: ${describeError(relayErr)}`);
    }
    return true;
  } catch (storeErr) {
    console.error(`[fatal] ${message} (event log unavailable: ${describeError(storeErr)})`);
    return false;
  }
}

/**
 * Tell the user why their courses stopped polling on startup (Q11).
 *
 * On boot every persisted `watching` target is reset to `paused` — deliberate, so
 * the app never resumes polling by itself — but it used to happen silently: state
 * changed on disk, no event was written, and the UI showed a row of paused cards
 * with an empty console. A crash makes this worse, because the user is looking at
 * exactly this symptom to explain why monitoring stopped. The design intent is
 * unchanged; only its visibility is.
 */
export function announceStartupPause(rt: Runtime, pausedCount: number): void {
  if (pausedCount <= 0) return;
  const message =
    `Startup: reset ${pausedCount} course(s) from watching to paused — the app never ` +
    `resumes polling by itself. Press "Start all" (or Resume on a card) to watch them again.`;
  console.log(message);
  recordFatal(rt, message, 'warn', { pausedCount });
}

/** Remove the handlers `installProcessGuards` registered (used by tests). */
export type ProcessGuardTeardown = () => void;

/** The two handlers, exposed so tests can invoke the real logic instead of
 * re-declaring it (and instead of `process.emit`, which is not typed for these
 * events). */
export interface ProcessGuardHandlers {
  onRejection: (reason: unknown) => void;
  onException: (err: unknown) => void;
}

/**
 * Build the two last-resort handlers for anything that still escapes a callback:
 * a stray `void promise` that rejects (the historical Q1 crash), a throw from a
 * synchronous callback with no try/catch, an `EventEmitter` 'error'.
 *
 * They log an error event and **keep running**. Rationale (the brief asks for one):
 * this is a single-user local automation whose only job is to catch a course
 * opening, and a registration attempt is not idempotent — exiting means the
 * monitoring silently disappears until the user notices, which is the very
 * symptom Q1 reported. Staying alive in a degraded state keeps the API, the
 * WebSocket and the event log available so the user can see what happened and
 * recover in-app.
 *
 * The one exception is `EADDRINUSE` — a fault we provably cannot serve through.
 * Without the port there is no API and no UI, so a silent "alive but useless"
 * process would be worse than the loud exit it replaced.
 */
export function buildProcessGuardHandlers(rt: Runtime): ProcessGuardHandlers {
  return {
    onRejection: (reason: unknown): void => {
      recordFatal(rt, `Unhandled promise rejection: ${describeError(reason)}`);
    },
    onException: (err: unknown): void => {
      recordFatal(rt, `Uncaught exception: ${describeError(err)}`);
      if (isAddressInUse(err)) {
        console.error('[fatal] Port already in use — exiting.');
        process.exit(1);
      }
    },
  };
}

/** Install the handlers above on the real `process`. Returns a teardown function
 * so tests can add and remove them without leaking listeners. */
export function installProcessGuards(rt: Runtime): ProcessGuardTeardown {
  const { onRejection, onException } = buildProcessGuardHandlers(rt);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}

async function main() {
  const clients = new Set<WebSocket>();
  const runtime = createRuntime((event) => broadcast(clients, event));
  // On startup nothing should be polling — reset any persisted 'watching'
  // targets to 'paused' so the user starts them manually (per-course or Start all).
  const paused = runtime.store.pauseAllWatching();
  announceStartupPause(runtime, paused);
  // Armed before the server starts listening, so a fault during startup is
  // reported too rather than crashing with no explanation.
  installProcessGuards(runtime);
  const app = buildServer(runtime, clients);
  // A cycle that finds the session gone is the earliest reliable evidence that
  // it is gone. Feed it back into the status the API reports, otherwise
  // `GET /api/session` keeps answering 'authenticated' while the scheduler has
  // paused every target — the UI then shows a green "Active" over a stopped
  // engine. The status change broadcasts a warn event, so the UI learns without
  // polling (which would mean really navigating to Minerva on a timer).
  runtime.scheduler.setSessionLostHandler((reason) => {
    if (app.sessions.markLoggedOut()) console.log(`Session lost: ${reason}`);
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`AutoRegister API listening on http://127.0.0.1:${PORT}`);
}

// Guarded so the unit tests can import the helpers above without booting a server
// (importing this module must not have the side effect of binding a port).
// `pathToFileURL` rather than string-building the URL: on Windows `import.meta.url`
// is `file:///C:/...` while a hand-built `file://C:\...` never compares equal.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}
