import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LogEvent, LogLevel, Settings } from '@autoregister/shared';
import type { Budget } from '../budget/budget';
import type { Store } from '../store/store';

/** Safety net for a login that hangs outside the session flow's own control
 * (e.g. `launch()` never resolving). Must exceed the SessionManager's internal
 * login wait (session/config.ts LOGIN_TIMEOUT_MS = 5 min) so a legitimately
 * slow login (first-time SSO / Duo) is never prematurely flipped to
 * 'logged-out' while still in progress — the session flow resolves first. */
const LOGIN_TIMEOUT_MS = 360_000;

export interface ApiSession {
  launch(): Promise<void>;
  ensureLoggedIn(onPrompt?: () => void): Promise<void>;
  isLoggedIn(): Promise<boolean>;
}
export interface ApiScheduler {
  start(tickMs?: number): void;
  stop(): void;
  runTarget(id: string): void;
  isRunning(): boolean;
  /** Re-apply the poll cadence to already-scheduled targets (after a settings
   * change). Optional so lightweight test doubles can omit it. */
  rescheduleWatching?(): void;
  /** Forget a target's consecutive-failure streak (explicit recovery, Q3).
   * Optional so lightweight test doubles can omit it. */
  clearFailures?(targetId: string): void;
  /** Make a target due on the next tick. Optional, as above. */
  scheduleNow?(targetId: string): void;
}
export interface ApiDeps {
  store: Store;
  budget: Budget;
  session: ApiSession;
  scheduler: ApiScheduler;
}

const targetSchema = z.object({
  term: z.string().min(1),
  subject: z.string().min(1),
  courseNumber: z.string().min(1),
  targetCrn: z.string().min(1),
  faculty: z.string().min(1),
  label: z.string().optional(),
  mode: z.enum(['auto', 'notify']),
});

const emailSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  pass: z.string().min(1),
  to: z.string().min(1),
});

const settingsSchema = z
  .object({
    pollIntervalMinutes: z.number().min(1),
    jitterMinutes: z.number().min(0),
    queryBudget: z.number().min(1),
    registerBudget: z.number().min(0),
    notify: z.object({ desktop: z.boolean(), sound: z.boolean(), email: z.boolean() }),
    email: emailSchema,
    dryRun: z.boolean(),
  })
  .partial();

const targetPatchSchema = targetSchema
  .partial()
  .extend({
    status: z
      .enum(['watching', 'paused', 'registered', 'waitlisted', 'stopped', 'error'])
      .optional(),
  })
  .strict();

/** Build the local HTTP/WebSocket API over the runtime. `clients` is the shared
 * WS client set (also used by the event broadcaster). */
export function buildServer(deps: ApiDeps, clients: Set<WebSocket> = new Set()): FastifyInstance {
  const app = Fastify({ logger: false });
  let sessionStatus: 'unknown' | 'authenticated' | 'logged-out' | 'logging-in' = 'unknown';

  /** Record an API-originated state change in the app's own event log (and push it
   * to the live console). Mutations that change what the user will be watching used
   * to be completely silent, which is how "why did my courses stop?" became
   * unanswerable. Never throws: logging must not be able to fail a request. */
  function logStatus(
    message: string,
    targetId?: string,
    level: LogLevel = 'info',
    data?: unknown,
  ): void {
    try {
      const ev = deps.store.appendEvent({ level, message, targetId, data });
      broadcast(clients, ev);
    } catch (e) {
      console.error(`[api] ${level}: ${message} (event log unavailable: ${String(e)})`);
    }
  }

  // `.after()` (not `.catch()`) — surfacing a plugin load failure without
  // prematurely triggering `ready()`, which would reject later route registration.
  app.register(websocketPlugin).after((err) => {
    if (err) console.error('[api] WebSocket plugin failed to load:', err);
  });

  app.get('/api/health', () => ({ ok: true }));

  // --- targets ---
  app.get('/api/targets', () => deps.store.listTargets());
  app.post('/api/targets', (req, reply) => {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return deps.store.addTarget(parsed.data);
  });
  app.patch('/api/targets/:id', (req, reply) => {
    const parsed = targetPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const id = (req.params as { id: string }).id;
    const before = deps.store.getTarget(id);
    const updated = deps.store.updateTarget(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    // Recovery on edit (Q3): a target sits in `error` because three consecutive
    // cycles failed — for instance a typo'd CRN, or a term/subject/faculty that
    // returned nothing. Editing those very fields is the fix the error message
    // tells the user to make, so saving them must also drop the terminal state,
    // otherwise the corrected query is never polled and the log's advice is a
    // dead end. Scope: only query fields, and only out of `error` — a user who
    // deliberately paused a course keeps it paused.
    const queryFields = ['term', 'subject', 'courseNumber', 'targetCrn', 'faculty'] as const;
    const queryEdited = queryFields.some((f) => f in parsed.data);
    if (queryEdited && before?.status === 'error') {
      deps.store.updateTarget(id, { status: 'watching' });
      deps.scheduler.clearFailures?.(id);
      // Also clear any stale nextPollAt (a budget back-off can be hours away) so
      // the fixed query is actually retried soon, and start the engine: `scheduleNow`
      // only writes a timestamp, so without this an API client that does not also POST
      // /api/scheduler/start leaves the target 'watching' with no timer running and the
      // recovery silently does nothing.
      deps.scheduler.scheduleNow?.(id);
      deps.scheduler.start();
      logStatus('Course edited — cleared the error state, watching it again.', id, 'ok', {
        status: 'watching',
      });
      return deps.store.getTarget(id);
    }
    return updated;
  });
  app.delete('/api/targets/:id', (req) => {
    deps.store.removeTarget((req.params as { id: string }).id);
    return { ok: true };
  });
  // Explicit recovery entry for a target the breaker stopped (Q3/Q20). Without
  // this the `error` status was a one-way door: `runCycle` returns early for
  // anything that isn't `watching`, so "Register now" was disabled, Pause/Resume
  // weren't rendered, and Start all deliberately skipped it — the only way out
  // was delete + re-add, losing the label and lastStats.
  app.post('/api/targets/:id/resume', (req, reply) => {
    const { id } = req.params as { id: string };
    const target = deps.store.getTarget(id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    if (target.status === 'watching') {
      // Idempotent, but still make sure the engine is up: a client that calls resume on
      // an already-watching target while the engine is stopped means "poll this", and
      // answering `{resumed:false}` without starting anything would leave it idle. This
      // is also what makes the route safe for the UI's double-click.
      deps.scheduler.start();
      return reply.send({ resumed: false, status: 'watching' });
    }
    if (target.status !== 'error' && target.status !== 'paused') {
      return reply.code(409).send({
        error: `target is ${target.status} — only 'error' or 'paused' targets can be resumed`,
      });
    }
    const was = target.status;
    deps.store.updateTarget(id, { status: 'watching' });
    // A fresh explicit retry deserves a fresh strike count: otherwise one blip
    // makes the target look like it failed 3 times in a row and parks it straight
    // back in `error`, which would make the button appear to do nothing.
    deps.scheduler.clearFailures?.(id);
    deps.scheduler.scheduleNow?.(id);
    // `scheduleNow` only writes a timestamp — start the engine too, or a client that
    // resumes without also POSTing /api/scheduler/start gets a 'watching' target that
    // never polls (the same gap the edit-recovery path above had).
    deps.scheduler.start();
    logStatus(`Resumed watching (was '${was}') — polling again.`, id, 'ok', { status: 'watching' });
    return reply.send({ resumed: true, status: 'watching' });
  });

  // One-click "Register now": run an immediate forced cycle for this target.
  // `started: true` means the run was *accepted*; it executes asynchronously and
  // its outcome arrives via the event stream (like a normal tick). The status
  // check below is a best-effort fast-fail — runCycle re-checks status when it runs.
  app.post('/api/targets/:id/run', (req, reply) => {
    const { id } = req.params as { id: string };
    const target = deps.store.getTarget(id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    // runOnce no-ops on non-watching targets; report honestly rather than a bare started:true.
    if (target.status !== 'watching') {
      return reply.send({ started: false, reason: `target is ${target.status}` });
    }
    deps.scheduler.runTarget(id);
    return { started: true };
  });

  // --- settings ---
  app.get('/api/settings', () => deps.store.getSettings());
  app.put('/api/settings', (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // Compare against the current values first: the UI saves the whole settings
    // object, so the cadence fields are always present even when unchanged. Only
    // reschedule when a value actually changed, otherwise an unrelated save (e.g.
    // toggling dry-run) would needlessly re-jitter every target's next poll.
    const before = deps.store.getSettings();
    const cadenceChanged =
      (parsed.data.pollIntervalMinutes !== undefined &&
        parsed.data.pollIntervalMinutes !== before.pollIntervalMinutes) ||
      (parsed.data.jitterMinutes !== undefined &&
        parsed.data.jitterMinutes !== before.jitterMinutes);
    // Email notifications are temporarily sunset: the server — not the UI — is
    // the source of truth, so a request body carrying `notify.email: true` (a
    // stale client, a hand-rolled curl, a restored backup) is overridden here.
    // Restoring the feature means deleting this override; the notifier, the
    // `EmailConfig` type and docs/EMAIL_SETUP.md all stay in place for that.
    const patch: Partial<Settings> = {
      ...parsed.data,
      notify: { ...before.notify, ...parsed.data.notify, email: false },
    };
    const updated = deps.store.setSettings(patch);
    // Re-apply a changed cadence to already-scheduled targets now, so it takes
    // effect immediately rather than only from each target's next cycle.
    if (cadenceChanged) deps.scheduler.rescheduleWatching?.();
    return updated;
  });

  // --- session ---
  app.get('/api/session', async () => {
    // Lazy re-check so the reported status doesn't drift from reality
    // (session can expire naturally without going through /api/session/login).
    if (sessionStatus === 'authenticated') {
      try {
        const live = await deps.session.isLoggedIn();
        if (!live) sessionStatus = 'logged-out';
      } catch {
        sessionStatus = 'unknown';
      }
    }
    return { status: sessionStatus };
  });
  app.post('/api/session/login', () => {
    if (sessionStatus !== 'logging-in') {
      sessionStatus = 'logging-in';
      void (async () => {
        // Safety net: if the browser/SSO flow hangs, reset the status so the
        // user can retry instead of being stuck in 'logging-in' forever.
        const timeout = setTimeout(() => {
          if (sessionStatus === 'logging-in') sessionStatus = 'logged-out';
        }, LOGIN_TIMEOUT_MS);
        if (typeof timeout.unref === 'function') timeout.unref();
        try {
          await deps.session.launch();
          await deps.session.ensureLoggedIn();
          sessionStatus = (await deps.session.isLoggedIn()) ? 'authenticated' : 'logged-out';
        } catch {
          sessionStatus = 'logged-out';
        } finally {
          clearTimeout(timeout);
        }
      })();
    }
    return { started: true };
  });

  // --- scheduler ---
  app.get('/api/scheduler', () => ({ running: deps.scheduler.isRunning() }));
  app.post('/api/scheduler/start', () => {
    deps.scheduler.start();
    return { running: true };
  });
  app.post('/api/scheduler/stop', () => {
    deps.scheduler.stop();
    return { running: false };
  });
  // "Start all": resume every PAUSED target, then start the engine. Targets the
  // breaker stopped ('error') and the completed ones (registered / waitlisted /
  // stopped) are deliberately NOT auto-resumed — retrying a course that failed
  // three times in a row, or re-watching one you are already registered in, is
  // not something a bulk button should decide. What was broken (Q20) is that the
  // count of those skipped courses was never reported, so "Start all" looked like
  // it had done nothing at all. `skipped` makes the outcome legible; the card's
  // Resume button is the explicit per-course opt-in.
  app.post('/api/scheduler/start-all', () => {
    const all = deps.store.listTargets();
    const toResume = all.filter((t) => t.status === 'paused');
    for (const t of toResume) deps.store.updateTarget(t.id, { status: 'watching' });
    // Recovered targets may still carry a stale nextPollAt (a budget back-off can
    // be hours away), which would make "resumed" a lie until it elapsed.
    for (const t of toResume) deps.scheduler.scheduleNow?.(t.id);
    deps.scheduler.start();
    const errored = all.filter((t) => t.status === 'error').length;
    // "Skipped" means "deliberately left alone because it is finished or failed" — NOT
    // "everything I did not resume". `all.length - toResume.length` also counted courses
    // that were already `watching`, i.e. actively polling, and reported them as skipped;
    // that is precisely the claim this count exists to avoid making. A `watching` course
    // is neither resumed nor skipped — it was already running.
    const skipped = all.filter(
      (t) => t.status === 'error' || t.status === 'registered' || t.status === 'waitlisted',
    ).length;
    logStatus(
      `Start all: resumed ${toResume.length} course(s)` +
        (skipped > 0
          ? `, skipped ${skipped} (${errored} in error — use Resume on the card).`
          : '.'),
      undefined,
      skipped > 0 ? 'warn' : 'ok',
      { resumed: toResume.length, skipped, errored },
    );
    return { running: true, resumed: toResume.length, skipped, errored };
  });
  // "Stop all": pause every actively-watching target, then stop the engine.
  // `scheduler.stop()` now also cancels any in-flight cycle, so nothing is
  // submitted after this returns (Q9/Q14) — the log line makes the stop visible,
  // matching what the cycle-level cancel event reports.
  app.post('/api/scheduler/stop-all', () => {
    const paused = deps.store.listTargets().filter((t) => t.status === 'watching');
    for (const t of paused) deps.store.updateTarget(t.id, { status: 'paused' });
    deps.scheduler.stop();
    logStatus(
      `Stop all: paused ${paused.length} course(s) and stopped the engine. ` +
        `Any cycle already running was cancelled.`,
      undefined,
      'warn',
      { paused: paused.length },
    );
    return { running: false, paused: paused.length };
  });

  // --- events + budget ---
  app.get('/api/events', (req) => {
    const raw = (req.query as { limit?: string }).limit;
    const parsed = raw === undefined ? 200 : Number(raw);
    // Non-numeric garbage (NaN) falls back to the default; negatives clamp to 0;
    // an explicit 0 is honoured.
    const limit = Number.isFinite(parsed) ? Math.max(0, parsed) : 200;
    return deps.store.recentEvents(limit);
  });
  // Clear the persisted event log (the live console "Clear" button).
  app.delete('/api/events', () => {
    deps.store.clearEvents();
    return { ok: true };
  });
  // A single atomic snapshot (one settings + one dailyOps read) so the client
  // never has to combine a fresh limit with a stale op-count.
  app.get('/api/budget', () => deps.budget.snapshot());

  // --- live event stream ---
  // WebSocket routes MUST be registered inside a `register(...)` so they're
  // created after @fastify/websocket has loaded and its onRoute hook is active.
  // Declaring the route synchronously at the top level (the plugin load is
  // deferred) leaves it a plain GET — the handler then receives (request, reply)
  // instead of the socket, and the upgrade 500s ("socket.on is not a function"),
  // which the client sees as an endless reconnect loop.
  void app.register(async (instance) => {
    instance.get('/api/stream', { websocket: true }, (socket: WebSocket) => {
      clients.add(socket);
      // Guard the initial send: a client may disconnect between add and send.
      try {
        socket.send(JSON.stringify({ type: 'recent', events: deps.store.recentEvents() }));
      } catch {
        clients.delete(socket);
      }
      socket.on('close', () => clients.delete(socket));
    });
  });

  // Serve the built web UI from packages/web/dist when present (one-process use).
  const webDist =
    process.env.AUTOREG_WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist });
    // SPA fallback: non-API, non-file GETs return index.html (client-side routing).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

/** Broadcast a log event to all connected WebSocket clients. */
export function broadcast(clients: Set<WebSocket>, event: LogEvent): void {
  const payload = JSON.stringify({ type: 'event', event });
  // Iterate a snapshot: deleting from a Set mid-`for...of` is actually safe
  // (unlike arrays), but the snapshot makes that correctness self-evident.
  for (const client of [...clients]) {
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}
