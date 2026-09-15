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
import { NUMERIC_BOUNDS, defaultSettings } from './fake-settings.mjs';
import { powerStatus } from './fake-power.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const PORT = Number(argValue('--port') ?? process.env.E2E_PORT ?? 4575);
const WEB_DIST =
  argValue('--web-dist') ?? process.env.E2E_WEB_DIST ?? `${REPO_ROOT}packages/web/dist`;

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
 * out of the per-route map entirely.
 */

/** The two paths that exist for the test harness, not for the app. */
const HARNESS_PATHS = new Set(['/api/__requests', '/api/health']);
const requestLedger = new Map();

/** Paths that carry an id — counted under their route template so counts stay meaningful. */
const DYNAMIC_ROUTE_TEMPLATES = [
  [/^\/api\/targets\/[^/]+\/run$/, '/api/targets/:id/run'],
  [/^\/api\/targets\/[^/]+\/resume$/, '/api/targets/:id/resume'],
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
 *
 * Liveness of this endpoint is not reported here: the runner proves it implicitly, because
 * `fetchLedger()` throws when the probe request fails or answers non-2xx. A wedged backend
 * therefore fails the case rather than looking like "the case never called its endpoints".
 */
function ledgerSnapshot() {
  const routes = {};
  for (const [route, entry] of requestLedger) {
    routes[route] = { count: entry.count, statuses: entry.statuses, failures: entry.failures };
  }
  return {
    routes,
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

// Both per-card actions (`▶ Resume` and `⟳ Resume watching`) go through this route
// (`packages/web/src/lib/api.ts` -> `resumeTarget`), so without it the fake backend
// 404s on them, `req()` throws and the card shows a scheduler error. This is the same
// "second consumer of the contract" drift that the `start-all` response shape had --
// the real route deliberately refuses to revive a terminal target, so mirror that too.
app.post('/api/targets/:id/resume', (req, reply) => {
  const { id } = req.params;
  const index = state.targets.findIndex((t) => t.id === id);
  if (index < 0) return reply.code(404).send({ error: 'not found' });
  const target = state.targets[index];
  if (target.status !== 'paused' && target.status !== 'error') {
    return reply.code(409).send({
      error: `cannot resume a target in status "${target.status}"`,
      status: target.status,
    });
  }
  state.targets = state.targets.map((t, i) => (i === index ? { ...t, status: 'watching' } : t));
  state.schedulerRunning = true;
  logEvent('ok', `Resumed ${target.label ?? target.targetCrn}.`);
  return { running: true, status: 'watching' };
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
  // Every key is derived from `NUMERIC_BOUNDS`, not from a hand-written list.
  //
  // The list used to be four names long while the real schema bounded eight
  // fields, so a body the real server rejects could be stored here — and the
  // fake, unlike the real server, *keeps* the bad value, so a later GET would
  // return it and every assertion about the saved settings would be measuring a
  // state the product cannot actually reach. Deriving the keys means a new
  // bounded setting is validated the moment it is added to the contract module.
  for (const key of Object.keys(NUMERIC_BOUNDS)) {
    if (key in patch && (typeof patch[key] !== 'number' || Number.isNaN(patch[key]))) {
      return reply.code(400).send({ error: `${key} must be a number` });
    }
  }
  // Mirror the real server's zod bounds exactly (`server.ts` settingsSchema), so the
  // fake can never emit a shape the real one would reject. A negative budget would
  // otherwise flow straight into `budgetCount()` and render `0 / -5` -- a ticker the
  // real server cannot produce, which would quietly invalidate the e2e assertions
  // that exist to pin that very contract.
  for (const [key, { min, max }] of Object.entries(NUMERIC_BOUNDS)) {
    if (!(key in patch) || typeof patch[key] !== 'number' || Number.isNaN(patch[key])) continue;
    if (patch[key] < min) return reply.code(400).send({ error: `${key} must be >= ${min}` });
    if (max !== undefined && patch[key] > max) {
      return reply.code(400).send({ error: `${key} must be <= ${max}` });
    }
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

// --- power / keep-awake (Windows only; `supported:false` elsewhere) ---
// `enabled` mirrors the persisted setting while `supported`/`active`/`reason`
// describe the machine, exactly as the real `toPowerDto()` splits them. The
// Settings page reads both and must not be told it is active on a machine that
// cannot host the keeper.
app.get('/api/power', () => ({ ...powerStatus(), enabled: state.settings.keepAwake ?? false }));

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
  // Mirrors the real route's response shape exactly. The web client reads all three
  // counts for its "Start all" notice (`Dashboard.tsx`), so returning only `resumed` made
  // that notice render `undefined` against the fake backend -- the same class of
  // drift the budget snapshot contract already had to be fixed for.
  const all = state.targets;
  const resumable = all.filter((t) => t.status === 'paused' || t.status === 'error');
  const recovered = resumable.filter((t) => t.status === 'error').length;
  const isDone = (s) => s === 'registered' || s === 'waitlisted' || s === 'stopped';
  state.targets = all.map((t) =>
    t.status === 'paused' || t.status === 'error' ? { ...t, status: 'watching' } : t,
  );
  state.schedulerRunning = true;
  logEvent('ok', `Start all: resumed ${resumable.length - recovered} course(s).`);
  return {
    running: true,
    recovered,
    resumed: resumable.length - recovered,
    skipped: all.filter((t) => isDone(t.status)).length,
  };
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
