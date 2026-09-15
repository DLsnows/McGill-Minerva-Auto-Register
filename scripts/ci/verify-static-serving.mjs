#!/usr/bin/env node
/**
 * W3 dependency-upgrade verification — `@fastify/static` 9.x -> 10.x.
 *
 * Why this is a separate command and not part of `npm test`: the unit suite has to
 * prove the SPA fallback contract too, but it can only do that against a throwaway
 * `index.html` (the real bundle is gitignored, so CI has none). This script boots
 * the REAL `buildServer` with the REAL built bundle and checks the things a
 * lockfile bump can silently break:
 *
 *   - `/`, `/courses`, `/settings` and a deep link resolve through the real
 *     `@fastify/static` registration plus the `setNotFoundHandler` -> `sendFile`
 *     fallback in `packages/server/src/api/server.ts`;
 *   - a hashed asset under `/assets/` is served with the right content type;
 *   - `content-disposition` is unchanged by its 1.x -> 2.x jump (absent for the
 *     inline types the app serves);
 *   - the Q5/Q6 guard rejects a hostile `Origin` with no side effects while the
 *     same-origin request still works.
 *
 * Usage: npm run verify:static        (builds the web bundle first if missing)
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_DIST = join(REPO_ROOT, 'packages', 'web', 'dist');
/** `0` = let the kernel pick a free port. Honoured unless `PORT` is set
 * explicitly: hardcoding a port here would reintroduce the `EADDRINUSE` flake
 * class this PR removed from `api-security.test.ts` (and which already bit the
 * e2e suite once, since 4575 is the dev server's default). */
const REQUESTED_PORT = Number(process.env.PORT ?? 0);

if (!existsSync(join(WEB_DIST, 'index.html'))) {
  // Deliberately not shelling out to `npm run build:web`: `spawnSync` cannot run
  // the `npm.cmd` shim on Windows without `shell: true` (EINVAL), and a shell is
  // not worth it for a one-line instruction.
  console.error('[verify:static] no web build found.');
  console.error('[verify:static] run `npm run build:web` first, then re-run this check.');
  process.exit(1);
}

process.env.AUTOREG_WEB_DIST = WEB_DIST;

const { buildServer } = await import('../../packages/server/src/api/server.ts');
const { Store } = await import('../../packages/server/src/store/store.ts');
const { Budget } = await import('../../packages/server/src/budget/budget.ts');
const { WebSocket } = await import('ws');

const dir = mkdtempSync(join(tmpdir(), 'w3-verify-'));
const store = new Store(dir);
const target = store.addTarget({
  term: '202701',
  subject: 'COMP',
  faculty: 'Faculty of Science',
  courseNumber: '551',
  targetCrn: '1814',
  mode: 'auto',
});

let started = 0;
let stopped = 0;
const app = buildServer({
  store,
  budget: new Budget(store),
  session: {
    launch: async () => undefined,
    ensureLoggedIn: async () => undefined,
    isLoggedIn: async () => true,
  },
  scheduler: {
    start: () => {
      started += 1;
    },
    stop: () => {
      stopped += 1;
    },
    runTarget: () => undefined,
    isRunning: () => false,
  },
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// `app.listen()` resolves to the address it actually bound, which is the only way to
// learn the port when `REQUESTED_PORT` is 0.
const address = await app.listen({ host: '127.0.0.1', port: REQUESTED_PORT });
const BASE = address.startsWith('http') ? address : `http://${address}`;
const WS_BASE = BASE.replace(/^http/, 'ws');
// The app's own origin, which is what the Q5/Q6 guard compares a request's `Origin`
// against. Derived from the bound address because a random loopback port cannot be
// assumed: a browser sends the origin it actually navigated to, so "same-origin" here
// means exactly this URL.
const ORIGIN = BASE;
console.log(`[verify:static] listening on ${BASE} (static root = packages/web/dist)\n`);

// ── 1. the pages the brief names, plus a deep link through the SPA fallback ─────
for (const path of ['/', '/courses', '/settings', '/some/deep/link']) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  check(
    `GET ${path} -> 200 index.html (SPA fallback)`,
    res.status === 200 &&
      body.includes('<div id="root">') &&
      (res.headers.get('content-type') ?? '').includes('text/html'),
    `status=${res.status} bytes=${body.length} ct=${res.headers.get('content-type')}`,
  );
}

// ── 2. a real hashed asset, and the content-disposition header it does not set ──
const indexHtml = await (await fetch(`${BASE}/`)).text();
const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
if (!assetPath) {
  check('index.html references a hashed JS asset', false, 'no /assets/*.js found');
} else {
  const res = await fetch(`${BASE}${assetPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  check(
    `GET ${assetPath} -> 200 immutable asset`,
    res.status === 200 &&
      buf.length > 1000 &&
      (res.headers.get('content-type') ?? '').includes('javascript'),
    `status=${res.status} bytes=${buf.length} ct=${res.headers.get('content-type')} etag=${res.headers.get('etag')} cc=${res.headers.get('cache-control')}`,
  );
  check(
    'asset Content-Disposition unchanged by the 1.x -> 2.x jump (absent when inline)',
    res.headers.get('content-disposition') === null,
    `content-disposition=${JSON.stringify(res.headers.get('content-disposition'))}`,
  );
}

// ── 3. clickjacking headers on both a page and an API response ──────────────────
const page = await fetch(`${BASE}/`);
const api = await fetch(`${BASE}/api/health`, { headers: { origin: ORIGIN } });
check('page carries X-Frame-Options: DENY', page.headers.get('x-frame-options') === 'DENY');
check(
  "page + API carry CSP frame-ancestors 'none'",
  (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'") &&
    (api.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
  `page-csp=${page.headers.get('content-security-policy')}`,
);

// ── 4. the audited attack is refused; the app's own requests are not ───────────
const budget = await fetch(`${BASE}/api/budget`, { headers: { origin: ORIGIN } });
check('GET /api/budget same-origin -> 200', budget.status === 200);

const attack = await fetch(`${BASE}/api/scheduler/stop-all`, {
  method: 'POST',
  headers: { origin: 'http://evil.example.com', 'content-type': 'text/plain' },
  body: 'x\r\n',
});
check(
  'AUDIT REPRO: cross-site text/plain form POST -> 403, no side effects',
  attack.status === 403 && stopped === 0 && store.getTarget(target.id)?.status === 'watching',
  `status=${attack.status} stopped=${stopped} target=${store.getTarget(target.id)?.status}`,
);

const legitStop = await fetch(`${BASE}/api/scheduler/stop-all`, {
  method: 'POST',
  headers: { origin: ORIGIN },
});
const legitBody = await legitStop.json();
check(
  'same-origin body-less POST /api/scheduler/stop-all -> 200 with real effect',
  legitStop.status === 200 &&
    stopped === 1 &&
    legitBody.paused === 1 &&
    store.getTarget(target.id)?.status === 'paused',
  `status=${legitStop.status} body=${JSON.stringify(legitBody)}`,
);

// `/api/scheduler/start` is gated on session readiness, and `requireSession()` reads
// the status the *server* holds rather than what this script's session double reports
// — so a cold server answers 409 no matter what the double says. Log in through the
// real route first, exactly as the browser does, and then assert the gate itself:
// an unauthenticated caller must be refused (this is the state the server boots in).
const unauthStart = await fetch(`${BASE}/api/scheduler/start`, {
  method: 'POST',
  headers: { origin: ORIGIN },
});
check(
  'POST /api/scheduler/start without a session -> 409, engine untouched',
  unauthStart.status === 409 && started === 0,
  `status=${unauthStart.status} started=${started}`,
);

const login = await fetch(`${BASE}/api/session/login`, {
  method: 'POST',
  headers: { origin: ORIGIN },
});
// The login route kicks off an async flow; the session double resolves immediately.
await new Promise((r) => setTimeout(r, 20));

const legitStart = await fetch(`${BASE}/api/scheduler/start`, {
  method: 'POST',
  headers: { origin: ORIGIN },
});
check(
  'same-origin body-less POST /api/scheduler/start -> 200',
  legitStart.status === 200 && started === 1,
  `login=${login.status} status=${legitStart.status} started=${started}`,
);

// ── 5. websocket over real TCP: hostile Origin refused, own origin accepted ────
const hostile = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS_BASE}/api/stream`, {
    headers: { origin: 'http://evil.example.com' },
  });
  ws.on('open', () => {
    ws.terminate();
    resolve({ opened: true });
  });
  ws.on('unexpected-response', (_req, res) => resolve({ opened: false, status: res.statusCode }));
  ws.on('error', (err) => resolve({ opened: false, status: err.message }));
});
check('websocket hostile Origin refused', hostile.opened === false, JSON.stringify(hostile));

const sameOrigin = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS_BASE}/api/stream`, { headers: { origin: ORIGIN } });
  const timer = setTimeout(() => resolve({ opened: false, why: 'timeout' }), 3000);
  ws.on('message', (d) => {
    clearTimeout(timer);
    ws.terminate();
    resolve({ opened: true, type: JSON.parse(String(d)).type });
  });
  ws.on('error', (err) => {
    clearTimeout(timer);
    resolve({ opened: false, why: err.message });
  });
});
check(
  'websocket own Origin accepted + snapshot delivered',
  sameOrigin.opened === true && sameOrigin.type === 'recent',
  JSON.stringify(sameOrigin),
);

await app.close();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n[verify:static] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
