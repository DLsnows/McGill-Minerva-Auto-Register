import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LogEvent, Settings } from '@autoregister/shared';
import type { Budget } from '../budget/budget';
import type { Store } from '../store/store';

export interface ApiSession {
  launch(): Promise<void>;
  ensureLoggedIn(onPrompt?: () => void): Promise<void>;
  isLoggedIn(): Promise<boolean>;
}
export interface ApiScheduler {
  start(tickMs?: number): void;
  stop(): void;
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
  faculty: z.string().optional(),
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

  void app.register(websocketPlugin);

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

  // --- settings ---
  app.get('/api/settings', () => deps.store.getSettings());
  app.put('/api/settings', (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return deps.store.setSettings(parsed.data as Partial<Settings>);
  });

  // --- session ---
  app.get('/api/session', () => ({ status: sessionStatus }));
  app.post('/api/session/login', () => {
    if (sessionStatus !== 'logging-in') {
      sessionStatus = 'logging-in';
      void (async () => {
        try {
          await deps.session.launch();
          await deps.session.ensureLoggedIn();
          sessionStatus = (await deps.session.isLoggedIn()) ? 'authenticated' : 'logged-out';
        } catch {
          sessionStatus = 'logged-out';
        }
      })();
    }
    return { started: true };
  });

  // --- scheduler ---
  app.post('/api/scheduler/start', () => {
    deps.scheduler.start();
    return { running: true };
  });
  app.post('/api/scheduler/stop', () => {
    deps.scheduler.stop();
    return { running: false };
  });

  // --- events + budget ---
  app.get('/api/events', (req) => {
    const raw = (req.query as { limit?: string }).limit;
    const limit = raw !== undefined ? Math.max(0, Number(raw) || 0) : 200;
    return deps.store.recentEvents(limit);
  });
  app.get('/api/budget', () => deps.budget.remaining());

  // --- live event stream ---
  app.get('/api/stream', { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'recent', events: deps.store.recentEvents() }));
    socket.on('close', () => clients.delete(socket));
  });

  return app;
}

/** Broadcast a log event to all connected WebSocket clients. */
export function broadcast(clients: Set<WebSocket>, event: LogEvent): void {
  const payload = JSON.stringify({ type: 'event', event });
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      // drop a dead client silently
    }
  }
}
