import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LogEvent, Settings } from '@autoregister/shared';
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
    const updated = deps.store.updateTarget((req.params as { id: string }).id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not found' });
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
      (parsed.data.jitterMinutes !== undefined && parsed.data.jitterMinutes !== before.jitterMinutes);
    const updated = deps.store.setSettings(parsed.data as Partial<Settings>);
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
  // "Start all": resume every PAUSED target (error / registered / waitlisted /
  // stopped are intentionally left untouched), then start the engine.
  app.post('/api/scheduler/start-all', () => {
    const resumed = deps.store.listTargets().filter((t) => t.status === 'paused');
    for (const t of resumed) deps.store.updateTarget(t.id, { status: 'watching' });
    deps.scheduler.start();
    return { running: true, resumed: resumed.length };
  });
  // "Stop all": pause every actively-watching target, then stop the engine.
  app.post('/api/scheduler/stop-all', () => {
    const paused = deps.store.listTargets().filter((t) => t.status === 'watching');
    for (const t of paused) deps.store.updateTarget(t.id, { status: 'paused' });
    deps.scheduler.stop();
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
  app.get('/api/budget', () => deps.budget.remaining());

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
