import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LogEvent, Settings } from '@autoregister/shared';
import { MAX_OP_PAUSE_MS, MIN_OP_PAUSE_MS } from '@autoregister/shared';
import type { Budget } from '../budget/budget';
import type { KeepAwakeReason, KeepAwakeStatus, PowerSource } from '../system/keep-awake';
import type { Store } from '../store/store';
import { applyPacingSettings } from '../util/pacing';

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
  /** Run one tick immediately if the engine is running (optional: test doubles). */
  tickSoon?(): void;
  /** Drop one target's consecutive-failure streak when it enters `watching`. */
  clearFailures?(id: string): void;
}
/** Windows keep-awake controller. Optional so non-Windows callers and test
 * doubles can omit it entirely. */
export interface ApiKeepAwake {
  status(): KeepAwakeStatus;
  apply(settings: { keepAwake?: boolean }): Promise<KeepAwakeStatus>;
  stop(): KeepAwakeStatus;
}

/** First-poll timestamp for a target that just entered `watching`: *due now*.
 *
 * Deliberately not "now + a little jitter". `Scheduler.tick()` only runs targets
 * with `(nextPollAt ?? 0) <= now`, and `start()`/`tickSoon()` tick at essentially
 * the same `now` — so a timestamp even a few milliseconds in the future makes the
 * freshly armed target miss that immediate tick and wait a whole 30s interval,
 * which is exactly the "I clicked Start and nothing happened" bug this change
 * exists to fix. (The first cut of this PR did jitter by 0-3s and had that bug.)
 *
 * Jitter would also buy nothing: `tick()` dispatches sequentially
 * (`for (const t of due) await this.runOnce(t.id)`), so several targets armed at
 * the same instant still hit Minerva one after another, never concurrently. */
function armForImmediatePoll(now: number): number {
  return now;
}

export interface ApiDeps {
  store: Store;
  budget: Budget;
  session: ApiSession;
  scheduler: ApiScheduler;
  keepAwake?: ApiKeepAwake;
  /** Injectable clock. Defaults to `Date.now`, and mirrors the scheduler's own `now`
   * hook so a test can drive both from one source. Asserting "the route armed it due
   * now" against `Date.now()` instead is fragile: another test in the same file may
   * have fake timers installed, in which case `Date.now()` and the scheduler's clock
   * disagree by however far the fake clock was advanced. */
  now?: () => number;
}

/**
 * Statuses a target cannot be revived out of.
 *
 * `registered` / `waitlisted` are finished; `stopped` is a deliberate user decision.
 * Every route that can put a target back into `watching` must agree on this set —
 * PATCH and `/resume` consult it, and `start-all` uses the same three statuses in its
 * `isDone` filter — because disagreeing is how a route ends up restarting polling on a
 * course that already has a seat.
 */
const TERMINAL_STATUSES: readonly string[] = ['registered', 'waitlisted', 'stopped'];

const targetSchema = z.object({  term: z.string().min(1),
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

/**
 * Exported for `fake-settings-contract.test.ts` only. Adding a setting to this
 * schema without teaching `e2e/fake-settings.mjs` about it has silently broken
 * the e2e saved-settings flow three times now (the budget snapshot in #35, the
 * `/resume` contract in #34, operation speed in #36), each time because the fake
 * is a hand-maintained parallel copy of a contract nobody re-derived. The
 * contract test derives the fake's obligations from *this* schema instead, so a
 * new bounded field without a fake counterpart fails `npm test` rather than
 * surfacing as a mystery e2e timeout.
 */
export const settingsSchema = z
  .object({
    pollIntervalMinutes: z.number().min(1),
    jitterMinutes: z.number().min(0),
    // Operation speed (inside one poll). Enforced server-side so a hand-rolled
    // request can't push the automation below the 250ms anti-detection floor —
    // the UI clamp alone is not a guarantee. z.number() already rejects NaN and
    // ±Infinity; min/max reject out-of-range and negative values.
    opPauseMs: z.number().min(MIN_OP_PAUSE_MS).max(MAX_OP_PAUSE_MS),
    opJitterMs: z.number().min(0).max(MAX_OP_PAUSE_MS),
    queryBudget: z.number().min(1),
    registerBudget: z.number().min(0),
    notify: z.object({ desktop: z.boolean(), sound: z.boolean(), email: z.boolean() }),
    email: emailSchema,
    dryRun: z.boolean(),
    keepAwake: z.boolean(),
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

/** Wire shape of `GET /api/power` (and of the `keepAwake` block the settings UI
 * reads). `enabled` is the persisted setting, `active` what is happening now. */
export interface PowerStatusDto {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  powerSource: PowerSource;
  reason: KeepAwakeReason;
}

/** What we report when no keep-awake controller was wired in at all. */
const UNSUPPORTED_POWER: KeepAwakeStatus = {
  supported: false,
  settingEnabled: false,
  active: false,
  powerSource: 'unknown',
  reason: 'unsupported',
};

function toPowerDto(status: KeepAwakeStatus): PowerStatusDto {
  return {
    supported: status.supported,
    enabled: status.settingEnabled,
    active: status.active,
    powerSource: status.powerSource,
    reason: status.reason,
  };
}

/** Build the local HTTP/WebSocket API over the runtime. `clients` is the shared
 * WS client set (also used by the event broadcaster). */
export function buildServer(deps: ApiDeps, clients: Set<WebSocket> = new Set()): FastifyInstance {
  const app = Fastify({ logger: false });
  // One clock for every "arm it now" decision. Injectable so tests can drive it from
  // the same source as the scheduler (see ApiDeps.now).
  const now = deps.now ?? Date.now;
  let sessionStatus: 'unknown' | 'authenticated' | 'logged-out' | 'logging-in' = 'unknown';

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
    // New targets default to 'watching' (store.addTarget). Give them a first
    // poll time right away: without it `nextPollAt` stays undefined and the
    // target is only picked up by the next tick, and there is no `watching`
    // transition afterwards that would set it.
    const created = deps.store.addTarget({ ...parsed.data, nextPollAt: armForImmediatePoll(now()) });
    // Adding a course while the engine is already running should poll it now, not on the
    // next 30s interval. Every other route that puts a target into `watching` (PATCH,
    // /resume, start-all) kicks a tick for exactly this reason; this one did not, so a
    // course added mid-run silently waited a full interval for its first poll.
    deps.scheduler.tickSoon?.();
    return created;
  });
  app.patch('/api/targets/:id', (req, reply) => {
    const parsed = targetPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    // Guard the one transition this branch makes eager. A PATCH that flips a course back
    // to 'watching' now both arms an immediate poll AND clears the failure streak, so a
    // stray `{ status: 'watching' }` aimed at a course that already has a seat would
    // restart polling on it (burning the query budget every cycle) and could reach
    // `actor.act()` for a duplicate registration.
    //
    // The terminal set matches `/resume` and `start-all`'s `isDone` exactly. `stopped` is
    // included: whether it is "finished" or "deliberately turned off", both routes treat
    // it as terminal, and having PATCH disagree with them was the inconsistency.
    if (parsed.data.status === 'watching') {
      const existing = deps.store.getTarget(id);
      if (!existing) return reply.code(404).send({ error: 'not found' });
      if (TERMINAL_STATUSES.includes(existing.status)) {
        return reply
          .code(409)
          .send({ error: `cannot resume a target in status "${existing.status}"`, status: existing.status });
      }
    }
    const updated = deps.store.updateTarget(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    // A target (re-)entering 'watching' (resume from pause, revive from error,
    // un-terminal from stopped) must poll immediately rather than wait a full
    // tick, and must not carry an old failure streak into the new run.
    //
    // `start()` is called before `tickSoon()` on purpose: `tickSoon()` is a no-op while
    // the engine is stopped (`scheduler.ts` guards on `this.timer`), so arming the poll
    // and asking for a tick without starting the engine would leave the target
    // `watching` but un-polled until something else started it — the route's own promise
    // ("must poll immediately") would be false for direct API callers. The web UI no
    // longer reaches this path (it uses `/resume`), so this is about the contract, not
    // about the UI.
    if (parsed.data.status === 'watching') {
      const fresh = deps.store.updateTarget(id, { nextPollAt: armForImmediatePoll(now()) });
      deps.scheduler.clearFailures?.(id);
      deps.scheduler.start();
      deps.scheduler.tickSoon?.();
      return fresh;
    }
    return updated;
  });
  app.delete('/api/targets/:id', (req) => {
    deps.store.removeTarget((req.params as { id: string }).id);
    return { ok: true };
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
  app.put('/api/settings', async (req, reply) => {
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
      (parsed.data.jitterMinutes !== undefined && parsed.data.jitterMinutes !== before.jitterMinutes);
    // Email notifications are temporarily sunset: the server — not the UI — is
    // the source of truth, so a request body carrying `notify.email: true` (a
    // stale client, a hand-rolled curl, a restored backup) is overridden here.
    // Restoring the feature means deleting this override; the notifier, the
    // `EmailConfig` type and docs/EMAIL_SETUP.md all stay in place for that.
    const pacingChanged =
      (parsed.data.opPauseMs !== undefined && parsed.data.opPauseMs !== before.opPauseMs) ||
      (parsed.data.opJitterMs !== undefined && parsed.data.opJitterMs !== before.opJitterMs);
    const patch: Partial<Settings> = {
      ...parsed.data,
      notify: { ...before.notify, ...parsed.data.notify, email: false },
    };
    const updated = deps.store.setSettings(patch);
    // Re-apply a changed cadence to already-scheduled targets now, so it takes
    // effect immediately rather than only from each target's next cycle.
    if (cadenceChanged) deps.scheduler.rescheduleWatching?.();
    // Keep-awake: flip the keeper immediately on save. Applied on every save
    // (not just on change) so the caller's response reports the real state.
    // Awaited because the first tick probes the power source asynchronously — doing
    // this synchronously used to stall the event loop for the whole server.
    if (deps.keepAwake) await deps.keepAwake.apply(updated);
    // Same idea for the operation speed: `humanPause()` reads the runtime config
    // on every call, so a changed value applies from the next browser operation on.
    // Uses `updated` (the persisted merge) so unchanged fields keep their value.
    if (pacingChanged) applyPacingSettings(updated);
    return updated;
  });

  // --- power / keep-awake (Windows only; `supported:false` elsewhere) ---
  app.get('/api/power', () => toPowerDto(deps.keepAwake?.status() ?? UNSUPPORTED_POWER));

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
  // "Start all": revive every recoverable target — 'paused' (deliberately
  // stopped) and 'error' (parked by the three-strikes breaker) — then start the
  // engine. 'error' used to be a dead end the UI could not leave: it is neither
  // pausable nor resumable from the course card, and start-all collected only
  // 'paused', so the only way out was deleting and re-creating the course.
  // The completed states (registered / waitlisted / stopped) stay untouched.
  //
  // Every revived target is also armed as *due now*, so the immediate tick that
  // `scheduler.start()` fires polls it right away: that is the fix for "the first
  // Start does not actually start polling" — previously the flip to 'watching'
  // carried no `nextPollAt`, so the first real poll waited a whole 30s tick and
  // looked like a no-op.
  app.post('/api/scheduler/start-all', () => {
    const all = deps.store.listTargets();
    const resumable = all.filter((t) => t.status === 'paused' || t.status === 'error');
    // One timestamp for the whole batch, read from the injectable clock so it matches
    // the instant the immediate tick below will compare against.
    const armedAt = now();
    let recovered = 0;
    for (const t of resumable) {
      if (t.status === 'error') recovered += 1;
      deps.store.updateTarget(t.id, { status: 'watching', nextPollAt: armForImmediatePoll(armedAt) });
      // A revived target starts with a clean failure streak, otherwise its very
      // next failure would immediately re-trip the breaker. Scoped to the targets
      // actually being revived — a watching course that is simply continuing must
      // keep its streak (clearing it would silently give a flaky course three more
      // tries for free).
      deps.scheduler.clearFailures?.(t.id);
    }
    deps.scheduler.start();
    // `start()` is a no-op when the engine is already running (a second, stale tab, or
    // simply another course still being watched), so without this the targets revived
    // above would wait up to a full 30s interval for the first poll — reopening the very
    // "I clicked Start and nothing happened" gap this route exists to close. `/resume`
    // calls this for the same reason.
    deps.scheduler.tickSoon?.();
    const isDone = (s: string) => s === 'registered' || s === 'waitlisted' || s === 'stopped';
    return {
      running: true,
      /** Targets revived out of the 'error' terminal state. */
      recovered,
      /** Paused targets put back under watch. */
      resumed: resumable.length - recovered,
      /** Terminal non-error targets left untouched. */
      skipped: all.filter((t) => isDone(t.status)).length,
    };
  });
  // "Stop all": pause every actively-watching target, then stop the engine.
  app.post('/api/scheduler/stop-all', () => {
    const paused = deps.store.listTargets().filter((t) => t.status === 'watching');
    for (const t of paused) deps.store.updateTarget(t.id, { status: 'paused' });
    deps.scheduler.stop();
    return { running: false, paused: paused.length };
  });
  // "Resume watching" for one target: the per-course escape hatch out of 'error'
  // (a hard target that tripped the breaker). PATCH /api/targets/:id with status
  // 'watching' does the same, but this route gives the course card one
  // unambiguous action and makes sure a tick happens now: `start()` is a no-op
  // when the engine is ALREADY running (other courses still being watched), so
  // without `tickSoon()` the resumed course would wait out the rest of the 30s
  // interval — the very gap that made "Resume" look broken.
  app.post('/api/targets/:id/resume', (req, reply) => {
    const { id } = req.params as { id: string };
    const target = deps.store.getTarget(id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    // Only 'paused' and 'error' are revivable. 'registered' / 'waitlisted' are terminal
    // by design — `start-all` deliberately never touches them — and 'stopped' is a
    // deliberate user decision. Without this guard the route would put a course that
    // already has a seat back into the polling loop: it would burn the daily query
    // budget every cycle and, if `decide()` saw an opening for the target CRN, reach
    // `actor.act()` and submit a *duplicate* registration attempt.
    if (target.status !== 'paused' && target.status !== 'error') {
      return reply
        .code(409)
        .send({ error: `cannot resume a target in status "${target.status}"`, status: target.status });
    }
    deps.store.updateTarget(id, { status: 'watching', nextPollAt: armForImmediatePoll(now()) });
    deps.scheduler.clearFailures?.(id);
    deps.scheduler.start();
    deps.scheduler.tickSoon?.();
    return { running: true, status: 'watching' as const };
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
