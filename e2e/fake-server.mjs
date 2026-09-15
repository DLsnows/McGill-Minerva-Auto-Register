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

/**
 * Per-endpoint request ledger.
 *
 * Why this exists: the e2e suite's "no console errors" assertion cannot distinguish an app
 * bug from a blocked font request, and a 500 from `/api/targets` looks like any other
 * "Failed to load resource" line. Counting calls and recording non-2xx statuses per route
 * gives the suite a signal that is both precise and impossible to satisfy accidentally —
 * and it also catches the opposite failure ("this endpoint was never called at all"), which
 * an error-only assertion can never see.
 *
 * `/api/__requests` and `/api/health` are not routes the frontend calls, so they are kept
 * out of the per-route map; the coverage probe still has to prove it was served, so its
 * count is reported separately as `probeCalls`.
 */

/** The paths that exist for the test harness, not for the app. */
const HARNESS_PATHS = new Set(['/api/__requests', '/api/__session', '/api/health']);
const requestLedger = new Map();
let harnessCalls = 0;

/** Paths that carry an id — counted under their route template so counts stay meaningful. */
const DYNAMIC_ROUTE_TEMPLATES = [
  [/^\/api\/targets\/[^/]+\/run$/, '/api/targets/:id/run'],
  [/^\/api\/targets\/[^/]+$/, '/api/targets/:id'],
];

function ledgerKeyFor(pathname) {
  for (const [pattern, template] of DYNAMIC_ROUTE_TEMPLATES) {
    if (pattern.test(pathname)) return template;
  }
  return pathname;
}

/**
 * Records only API traffic. Static assets are served by this same process, so without the
 * `/api/` filter a 404 on e.g. `/favicon.ico` would enter the ledger and trip the suite's
 * "no route failed" assertion — contradicting the whole point of a ledger that exists to
 * judge the *API contract*. The console sentinel deliberately tolerates a missing favicon
 * too; the two signals should agree.
 */
function isLedgerRoute(pathname) {
  return pathname.startsWith('/api/') && !HARNESS_PATHS.has(pathname);
}

function recordRequest(req) {
  // GitHub-hosted Actions masks the query string in `req.url`, so never parse it.
  const pathname = req.url.split('?')[0];
  if (HARNESS_PATHS.has(pathname)) {
    harnessCalls += 1;
    return;
  }
  if (!isLedgerRoute(pathname)) return;
  const key = ledgerKeyFor(pathname);
  const entry = requestLedger.get(key) ?? { count: 0, statuses: {}, failures: [] };
  entry.count += 1;
  requestLedger.set(key, entry);
}

function recordResponse(req, reply) {
  const pathname = req.url.split('?')[0];
  if (!isLedgerRoute(pathname)) return;
  const key = ledgerKeyFor(pathname);
  const status = reply.statusCode;
  const entry = requestLedger.get(key) ?? { count: 0, statuses: {}, failures: [] };
  entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
  if (status >= 400) entry.failures.push(status);
  requestLedger.set(key, entry);
}

/**
 * Snapshot for the test runner: absolute counts + failure statuses per API route.
 *
 * Absolute, not per-case: `e2e/run.mjs` diffs two snapshots around each case so that a
 * broken endpoint does not cascade into every later case, and so an `>= N` minimum can
 * only be satisfied by the case's *own* traffic (a cumulative ledger would let an earlier
 * case silently satisfy a later case's assertion).
 */
function ledgerSnapshot() {
  const routes = {};
  for (const [route, entry] of requestLedger) {
    routes[route] = { count: entry.count, statuses: entry.statuses, failures: entry.failures };
  }
  return {
    routes,
    // Monotonic counter for the harness paths, so the runner can prove the probe itself was
    // served (a down or wedged fake backend would otherwise make every route's delta 0 and
    // read as "the case never called it").
    probeCalls: harnessCalls,
    serverErrors: [...requestLedger].flatMap(([, e]) => e.failures.filter((s) => s >= 500)),
  };
}

const app = Fastify({ logger: false });

/**
 * Fault injection for testing the suite's own safety net: with
 * `E2E_FAULT_ROUTES=/api/budget,/api/settings` the listed routes answer 500 instead of 200.
 * Used to prove that a broken endpoint actually fails the run (and that the console filter
 * no longer swallows it) rather than silently passing.
 */
const FAULT_ROUTES = new Set(
  (process.env.E2E_FAULT_ROUTES ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
);

app.addHook('onRequest', (req, _reply, done) => {
  recordRequest(req);
  done();
});

// `async` so the fault path can short-circuit by *returning* the reply. A callback-style
// hook that calls `reply.send()` and returns without `done()` never completes Fastify's hook
// chain: the route handler is not dispatched, and any later `preHandler` would silently not
// run for fault-injected routes. It happens to work because `reply.send()` flushes the
// response and fires `onResponse` on its own — but that is not the documented idiom.
app.addHook('preHandler', async (req, reply) => {
  const pathname = req.url.split('?')[0];
  if (FAULT_ROUTES.has(pathname)) {
    return reply.code(500).send({ error: `injected fault for ${pathname}` });
  }
  return undefined;
});

app.addHook('onResponse', (req, reply, done) => {
  recordResponse(req, reply);
  done();
});

app.register(websocketPlugin).after((err) => {
  if (err) console.error('[fake-server] websocket plugin failed to load:', err);
});

app.get('/api/health', () => ({ ok: true }));

// Test-support endpoint: which fake endpoints were hit, and did any of them fail?
app.get('/api/__requests', () => ledgerSnapshot());

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

/**
 * Manual-run cooldown, mirrored from MANUAL_RUN_COOLDOWN_MS in
 * packages/server/src/scheduler/scheduler.ts. Kept in sync deliberately: the real
 * `/run` answers `{started:false, reason:'cooldown', retryAfterMs, lastForcedRunAt}`
 * for a second request inside the window, and the UI's cooldown countdown is only
 * exercised if this fake produces the same shape (the same class of drift that
 * once left `/api/budget` rendering "NaN / undefined" while the assertions still
 * passed). The recorded timestamp is also written onto the target, exactly like
 * the real store does, so a reload sees the window without hitting the rejection.
 */
const MANUAL_RUN_COOLDOWN_MS = 60_000;

app.post('/api/targets/:id/run', (req, reply) => {
  const target = state.targets.find((t) => t.id === req.params.id);
  if (!target) return reply.code(404).send({ error: 'not found' });
  const lastForcedRunAt = target.lastForcedRunAt;
  if (target.status !== 'watching') {
    return reply.send({ started: false, reason: `target is ${target.status}`, lastForcedRunAt });
  }
  const at = now();
  if (lastForcedRunAt !== undefined && at - lastForcedRunAt < MANUAL_RUN_COOLDOWN_MS) {
    return reply.send({
      started: false,
      reason: 'cooldown',
      retryAfterMs: MANUAL_RUN_COOLDOWN_MS - (at - lastForcedRunAt),
      lastForcedRunAt,
    });
  }
  state.targets = state.targets.map((t) =>
    t.id === target.id ? { ...t, lastForcedRunAt: at } : t,
  );
  logEvent(
    'action',
    `[dry-run] Immediate cycle for ${target.label ?? target.targetCrn} (fake backend).`,
  );
  return { started: true, lastForcedRunAt: at };
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
  // Mirror the real server's zod bounds exactly (`server.ts` settingsSchema), so the
  // fake can never emit a shape the real one would reject. A negative budget would
  // otherwise flow straight into `budgetCount()` and render `0 / -5` -- a ticker the
  // real server cannot produce, which would quietly invalidate the e2e assertions
  // that exist to pin that very contract.
  const bounds = {
    pollIntervalMinutes: 1,
    jitterMinutes: 0,
    queryBudget: 1,
    registerBudget: 0,
  };
  for (const [key, min] of Object.entries(bounds)) {
    if (key in patch && patch[key] < min) {
      return reply.code(400).send({ error: `${key} must be >= ${min}` });
    }
  }
  state.settings = { ...state.settings, ...patch };
  return state.settings;
});

// --- session (never authenticates on its own: the fake backend has no Minerva
// behind it) ---
app.get('/api/session', () => ({ status: state.sessionStatus }));
app.post('/api/session/login', () => {
  state.sessionStatus = 'logged-out';
  return { started: true };
});

/**
 * Test-support endpoint: force the reported session status.
 *
 * `logged-out` is the honest default here (nothing is logged in), but it also
 * disables every action button in the UI, so cases that exercise a *real* click
 * path ("Register now" → POST /run → rendered verdict) need the UI to believe a
 * session exists. Before this hook the only way to cover such a path was to call
 * the endpoint with `page.request`, which skips the component under test.
 */
app.post('/api/__session', (req, reply) => {
  const status = req.body?.status;
  if (!['authenticated', 'logged-out', 'logging-in', 'unknown'].includes(status)) {
    return reply
      .code(400)
      .send({ error: 'status must be authenticated|logged-out|logging-in|unknown' });
  }
  state.sessionStatus = status;
  return { status: state.sessionStatus };
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

// Same atomic-snapshot contract as the real server's `Budget.snapshot()`: one
// `{ used, limit, remaining }` triple per budget, with `used` clamped into
// `[0, limit]`. Must stay in lockstep with packages/server/src/budget/budget.ts —
// the web Ticker reads `used` / `limit` straight off this response, so handing it
// bare remaining counts would render "NaN / undefined".
function budgetCount(count, limit) {
  const used = Math.max(0, Math.min(count, limit));
  return { used, limit, remaining: limit - used };
}

app.get('/api/budget', () => ({
  query: budgetCount(state.queryUsed, state.settings.queryBudget),
  register: budgetCount(state.registerUsed, state.settings.registerBudget),
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
