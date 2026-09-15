#!/usr/bin/env node
/**
 * E2E-only fake backend — a tiny in-memory implementation of the API contract the web
 * UI talks to. It exists so the end-to-end suite can exercise the real frontend bundle
 * without ever touching Minerva, Playwright sessions, the disk store, or the scheduler.
 *
 * Implemented (see packages/web/src/lib/api.ts + packages/server/src/api/server.ts):
 *   GET    /api/health
 *   GET    /api/targets          POST /api/targets      PATCH/DELETE /api/targets/:id
 *   POST   /api/targets/:id/run
 *   GET    /api/settings         PUT  /api/settings
 *   GET    /api/session
 *   GET    /api/scheduler        POST /api/scheduler/start|stop|start-all|stop-all
 *   GET    /api/budget
 *   WS     /api/stream
 *
 * It also serves the built SPA (packages/web/dist) with an index.html fallback, i.e. the
 * same one-process topology as the real server, so `/courses`, `/settings`, ... resolve
 * on a hard navigation.
 *
 * Usage: node e2e/fake-server.mjs [--port 4575] [--web-dist packages/web/dist]
 * Env:   E2E_PORT, E2E_WEB_DIST
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocketPlugin from '@fastify/websocket';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const PORT = Number(argValue('--port') ?? process.env.E2E_PORT ?? 4575);
const WEB_DIST =
  argValue('--web-dist') ?? process.env.E2E_WEB_DIST ?? `${REPO_ROOT}packages/web/dist`;

/** Factory defaults, mirrored from packages/shared/src/store-types.ts DEFAULT_SETTINGS
 * (kept inline so this fake stays dependency-free and never imports product code). */
function defaultSettings() {
  return {
    pollIntervalMinutes: 30,
    jitterMinutes: 3,
    queryBudget: 100,
    registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
    dryRun: false,
  };
}

const state = {
  settings: defaultSettings(),
  targets: [],
  schedulerRunning: false,
  queryUsed: 2,
  registerUsed: 0,
  sessionStatus: 'logged-out',
  events: [
    { level: 'info', message: 'E2E fake backend ready — no Minerva session involved.' },
    { level: 'ok', message: 'Loaded 0 watched courses.' },
  ],
};

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

function logEvent(level, message) {
  const event = { id: nextId('evt'), ts: Date.now(), level, message };
  state.events = [...state.events, event].slice(-200);
  const frame = JSON.stringify({ type: 'event', event });
  for (const client of clients) {
    try {
      client.send(frame);
    } catch {
      clients.delete(client);
    }
  }
  return event;
}

const clients = new Set();
const now = () => Date.now();

const REQUIRED_TARGET_FIELDS = ['term', 'subject', 'courseNumber', 'targetCrn', 'faculty'];

const app = Fastify({ logger: false });

app.register(websocketPlugin).after((err) => {
  if (err) console.error('[fake-server] websocket plugin failed to load:', err);
});

app.get('/api/health', () => ({ ok: true }));

// --- targets ---
app.get('/api/targets', () => state.targets);

app.post('/api/targets', (req, reply) => {
  const body = req.body ?? {};
  const missing = REQUIRED_TARGET_FIELDS.filter((f) => !String(body[f] ?? '').trim());
  if (missing.length) {
    return reply.code(400).send({ error: `missing required field(s): ${missing.join(', ')}` });
  }
  if (body.mode !== 'auto' && body.mode !== 'notify') {
    return reply.code(400).send({ error: 'mode must be "auto" or "notify"' });
  }
  const target = {
    id: nextId('tgt'),
    term: String(body.term),
    subject: String(body.subject),
    courseNumber: String(body.courseNumber),
    targetCrn: String(body.targetCrn),
    faculty: String(body.faculty),
    ...(body.label ? { label: String(body.label) } : {}),
    mode: body.mode,
    status: 'watching',
    createdAt: now(),
  };
  state.targets = [...state.targets, target];
  logEvent(
    'info',
    `Added watch target ${target.label ?? `${target.subject} ${target.courseNumber}`}.`,
  );
  return target;
});

app.patch('/api/targets/:id', (req, reply) => {
  const { id } = req.params;
  const index = state.targets.findIndex((t) => t.id === id);
  if (index < 0) return reply.code(404).send({ error: 'not found' });
  const patch = req.body ?? {};
  const allowed = [
    'term',
    'subject',
    'courseNumber',
    'targetCrn',
    'faculty',
    'label',
    'mode',
    'status',
  ];
  const next = { ...state.targets[index] };
  for (const key of allowed) {
    if (key in patch) next[key] = patch[key];
  }
  state.targets = state.targets.map((t, i) => (i === index ? next : t));
  return next;
});

app.delete('/api/targets/:id', (req) => {
  state.targets = state.targets.filter((t) => t.id !== req.params.id);
  return { ok: true };
});

app.post('/api/targets/:id/run', (req, reply) => {
  const target = state.targets.find((t) => t.id === req.params.id);
  if (!target) return reply.code(404).send({ error: 'not found' });
  if (target.status !== 'watching') {
    return reply.send({ started: false, reason: `target is ${target.status}` });
  }
  logEvent(
    'action',
    `[dry-run] Immediate cycle for ${target.label ?? target.targetCrn} (fake backend).`,
  );
  return { started: true };
});

// --- settings ---
app.get('/api/settings', () => state.settings);

app.put('/api/settings', (req, reply) => {
  const patch = req.body ?? {};
  const numeric = ['pollIntervalMinutes', 'jitterMinutes', 'queryBudget', 'registerBudget'];
  for (const key of numeric) {
    if (key in patch && (typeof patch[key] !== 'number' || Number.isNaN(patch[key]))) {
      return reply.code(400).send({ error: `${key} must be a number` });
    }
  }
  if ('pollIntervalMinutes' in patch && patch.pollIntervalMinutes < 1) {
    return reply.code(400).send({ error: 'pollIntervalMinutes must be >= 1' });
  }
  state.settings = { ...state.settings, ...patch };
  return state.settings;
});

// --- session (never authenticates: the fake backend has no Minerva behind it) ---
app.get('/api/session', () => ({ status: state.sessionStatus }));
app.post('/api/session/login', () => {
  state.sessionStatus = 'logged-out';
  return { started: true };
});

// --- scheduler ---
app.get('/api/scheduler', () => ({ running: state.schedulerRunning }));

app.post('/api/scheduler/start', () => {
  state.schedulerRunning = true;
  logEvent('ok', 'Scheduler started (fake backend).');
  return { running: true };
});

app.post('/api/scheduler/stop', () => {
  state.schedulerRunning = false;
  return { running: false };
});

app.post('/api/scheduler/start-all', () => {
  const paused = state.targets.filter((t) => t.status === 'paused');
  state.targets = state.targets.map((t) =>
    t.status === 'paused' ? { ...t, status: 'watching' } : t,
  );
  state.schedulerRunning = true;
  logEvent('ok', `Start all: resumed ${paused.length} course(s).`);
  return { running: true, resumed: paused.length };
});

app.post('/api/scheduler/stop-all', () => {
  const watching = state.targets.filter((t) => t.status === 'watching');
  state.targets = state.targets.map((t) =>
    t.status === 'watching' ? { ...t, status: 'paused' } : t,
  );
  state.schedulerRunning = false;
  return { running: false, paused: watching.length };
});

// --- events + budget ---
app.get('/api/events', (req) => {
  const raw = req.query?.limit;
  const parsed = raw === undefined ? 200 : Number(raw);
  const limit = Number.isFinite(parsed) ? Math.max(0, parsed) : 200;
  return state.events.slice(-limit);
});

app.delete('/api/events', () => {
  state.events = [];
  return { ok: true };
});

app.get('/api/budget', () => ({
  query: Math.max(0, state.settings.queryBudget - state.queryUsed),
  register: Math.max(0, state.settings.registerBudget - state.registerUsed),
}));

// --- live event stream (registered inside a plugin so @fastify/websocket's onRoute hook applies)
void app.register(async (instance) => {
  instance.get('/api/stream', { websocket: true }, (socket) => {
    clients.add(socket);
    try {
      socket.send(JSON.stringify({ type: 'recent', events: state.events }));
    } catch {
      clients.delete(socket);
    }
    socket.on('close', () => clients.delete(socket));
  });
});

// --- built SPA with client-side-routing fallback ---
if (!existsSync(WEB_DIST)) {
  console.error(`[fake-server] web build not found at ${WEB_DIST}`);
  console.error('[fake-server] run `npm run build:web` first (or pass --web-dist <dir>).');
  process.exit(1);
}

void app.register(fastifyStatic, { root: WEB_DIST });

app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && !req.url.startsWith('/api')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not found' });
});

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[fake-server] serving ${WEB_DIST} + fake API on http://127.0.0.1:${PORT}`);
} catch (err) {
  console.error('[fake-server] failed to start:', err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
