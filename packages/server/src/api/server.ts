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

/** Hostnames the local API answers to. Anything else is a DNS-rebinding Host. */
const ALLOWED_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** Default ports per scheme, so `http://localhost` and `localhost:80` compare equal. */
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Hard cap on a single inbound websocket *message* (after fragment
 * reassembly — `maxPayload` bounds messages, not frames). `/api/stream` is a
 * one-way broadcast and the UI never sends anything, so this only bounds abuse;
 * it is not a protocol feature. Note the pre-fix limit was NOT unlimited: `ws@8`
 * defaults `maxPayload` to `100 * 1024 * 1024` (verified:
 * `new WebSocketServer({noServer:true}).options.maxPayload` === 104857600), so
 * this is a ~100x tightening rather than a limit appearing where there was none. */
const MAX_WS_PAYLOAD_BYTES = 1 << 20; // 1 MiB

/** The only scheme the API is served over (`main.ts` listens on plain HTTP), so an
 * `https://` Origin cannot be this application. Pinned rather than ignored: a
 * scheme-blind comparison would accept `Origin: https://127.0.0.1:<port>`. */
const EXPECTED_PROTOCOL = 'http:';

/** Methods that cannot change server state, so they are exempt from the
 * content-type rule. The Host/Origin rules still apply to every method — a
 * DNS-rebound `GET /api/settings` is exactly the leak we are closing. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Sec-Fetch-Site` values that can only come from a request the browser itself
 * made on behalf of *this* page: `same-origin` (the UI's own fetches) and `none`
 * (a user-typed URL / bookmark — no initiator to forge the header). A cross-site
 * form submission or `sendBeacon` reports `cross-site`, and a script cannot lie
 * about it: the Fetch spec makes every `Sec-Fetch-*` header a forbidden header
 * name, so `fetch(..., { headers: { 'sec-fetch-site': 'same-origin' } })` is
 * stripped by the browser before the request leaves. This is a third, independent
 * signal on top of `Origin` — see the asymmetry note on the hook. */
const ALLOWED_SEC_FETCH_SITE = new Set(['same-origin', 'none']);

interface ParsedAuthority {
  name: string;
  port: string;
  /** Present for `Origin` (which carries a scheme), absent for `Host`. */
  protocol?: string;
}

/** Split an HTTP authority (`host[:port]`, `[::1]:port`) into name + port.
 * Bracket handling matters: the `[::1]:4575` form must not be read as name `[`. */
function splitAuthority(authority: string, defaultPort: string): ParsedAuthority | null {
  const value = authority.trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) return null;
    return { name: value.slice(1, end).toLowerCase(), port: rest.slice(1) || defaultPort };
  }
  const idx = value.lastIndexOf(':');
  // More than one colon and no brackets = a malformed (or smuggling) authority.
  if (idx < 0) return { name: value.toLowerCase(), port: defaultPort };
  if (value.indexOf(':') !== idx) return null;
  const port = value.slice(idx + 1);
  if (!/^\d+$/.test(port)) return null;
  return { name: value.slice(0, idx).toLowerCase(), port };
}

/** Parse a `Host` header (always carrying the served port when non-default). */
function parseHostHeader(host: string | undefined): ParsedAuthority | null {
  if (host === undefined) return null;
  return splitAuthority(host, '80');
}

/** Parse an `Origin` header. `null` (an opaque origin from a sandboxed frame or a
 * `data:`/`file:` document) and anything unparseable resolve to `null` = refused. */
function parseOriginHeader(origin: string | undefined): ParsedAuthority | null {
  if (origin === undefined) return null;
  const value = origin.trim();
  if (!value || value === 'null') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  const authority = splitAuthority(url.host, DEFAULT_PORTS[url.protocol] ?? '');
  return authority === null ? null : { ...authority, protocol: url.protocol };
}

/** `Content-Type` without its parameters, lower-cased (`application/json; c=1`). */
function mediaType(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const semi = contentType.indexOf(';');
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

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
  // `maxPayload` replaces the plugin default of 0 (unlimited): `/api/stream` is a
  // one-way broadcast and the UI never sends a frame, so this only bounds abuse.
  app.register(websocketPlugin, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } }).after((err) => {
    if (err) console.error('[api] WebSocket plugin failed to load:', err);
  });

  // --- local-API source validation (Q5 / Q6, audit 2026-09-15) ---
  //
  // The API is unauthenticated by design (single-user, loopback-only), which is
  // only safe if it is also unreachable from anything except its own UI. Before
  // this hook a web page the user merely *visited* could drive it: the five
  // body-less POSTs (`/api/scheduler/*`, `/api/session/login`) and a
  // `text/plain` form post are CORS-simple requests, so no preflight happens and
  // the JSON-parsing routes never object. The auditor reproduced a 200 for
  // `<form method=POST enctype=text/plain action=http://127.0.0.1:4575/api/scheduler/stop-all>`.
  //
  // Four rules, all fail-closed, all applied before routing so no handler runs
  // on a rejected request:
  //   1. `Host` must be a loopback name — this is the DNS-rebinding gate (a
  //      rebound page has an attacker-controlled `Host` even though its origin
  //      *looks* same-origin to the browser). Name only; see the note at the check.
  //   2. If `Origin` is present it must be this application's own origin: scheme
  //      `http:` plus the same host and port as the request's own `Host` header.
  //      The scheme is pinned explicitly rather than ignored, so an
  //      `Origin: https://127.0.0.1:<port>` is not treated as same-origin (this API
  //      is plain HTTP only — `main.ts` listens without TLS).
  //      `Origin` is deliberately optional: browsers attach it to every cross-site
  //      request (including forms and websocket handshakes), while curl and scripts
  //      omit it, so "absent" is not evidence of an attack. A websocket upgrade is
  //      the exception and requires it (see below).
  //   3. A request that carries a body must declare `application/json`, so the
  //      `text/plain` / urlencoded form postings that CORS lets through without a
  //      preflight are refused even if an Origin is somehow forged. Body-less
  //      requests are exempt because the UI's helper omits the header entirely
  //      for them (`packages/web/src/lib/api.ts`), and requiring it there would
  //      break every legitimate client for no additional protection — rule 2
  //      already covers that vector.
  //   4. On write methods, a `Sec-Fetch-Site` that is present must be `same-origin`
  //      or `none` (see the check below).
  //
  // Why the `Origin` requirement is ASYMMETRIC between plain HTTP and the
  // websocket upgrade, on purpose (do not "unify" these two — there is a test for
  // each half):
  //   * Plain HTTP must keep accepting requests with no `Origin`. Node's `fetch`
  //     does not send one, and `e2e/run.mjs` drives the API with it (the `/`
  //     readiness probe and the `/api/__requests` ledger probe), as do curl and
  //     every CLI script. Every browser-originated cross-site attack *does* carry
  //     an `Origin`, so "present but different" is the case that matters here —
  //     and it is refused.
  //   * A websocket upgrade must require it. A browser always sends `Origin` on a
  //     handshake (the spec forbids omitting it for `ws:`/`wss:`), so its absence
  //     proves the peer is not this application's page. Nothing in this repo opens
  //     a raw websocket, so nothing legitimate is lost.
  //   * Non-browser clients can forge any header, including a valid-looking
  //     `Origin`, so allowing the absent case costs nothing against them either
  //     way; rule 1 is what stops those.
  app.addHook('onRequest', (req, reply, done) => {
    // `request.ws` is set by @fastify/websocket's own onRequest hook (registered
    // before this one, so it always runs first) and is true exactly when this HTTP
    // request is a websocket upgrade rather than an ordinary request.
    const isUpgrade = req.ws === true;

    /** Refuse, and say why in the server log — a silently 403-ing local API is
     * indistinguishable from a broken one when the user is the one debugging it.
     * Nothing here is echoed beyond method/path/reason, so it cannot be used as a
     * reflection oracle. */
    const refuse = (code: number, error: string) => {
      console.warn(`[api] ${req.method} ${req.url} refused (${code}): ${error}`);
      void reply.code(code).send({ error });
      return done();
    };

    // Rule 1 checks the Host *name* only, deliberately: the bound port is not known
    // at `buildServer()` time (the caller picks it), and a browser's Host/Origin are
    // bound to the URL it actually navigated to, so an attacker cannot pair an
    // arbitrary port with a loopback name. Rule 2 is what pins the port — it compares
    // Origin against whatever Host the request carried, so the two can never disagree.
    const host = parseHostHeader(req.headers.host);
    if (!host || !ALLOWED_HOST_NAMES.has(host.name)) {
      return refuse(403, 'forbidden: unexpected Host header');
    }

    const rawOrigin = req.headers.origin;
    if (isUpgrade && rawOrigin === undefined) {
      // A browser always sends Origin on a websocket handshake, so its absence
      // means the peer is not the app's own page.
      return refuse(403, 'forbidden: websocket upgrade without Origin');
    }
    if (rawOrigin !== undefined) {
      const origin = parseOriginHeader(rawOrigin);
      if (
        !origin ||
        origin.protocol !== EXPECTED_PROTOCOL ||
        origin.name !== host.name ||
        origin.port !== host.port
      ) {
        return refuse(403, 'forbidden: cross-origin request');
      }
    }

    // Rule 4 (defence in depth, and the one signal a page cannot fake): when the
    // browser tells us where the request came from, believe it. Only write methods
    // are checked — a `Sec-Fetch-Site: cross-site` GET can only read responses the
    // same-origin policy already hides. Absent → allowed, so Node/curl are
    // unaffected (they never send `Sec-Fetch-*`); present → must be same-origin or
    // `none`. `same-site` is refused because for a loopback literal there is no
    // meaningful "same site" other than the exact origin.
    const site = req.headers['sec-fetch-site'];
    if (!READ_ONLY_METHODS.has(req.method) && typeof site === 'string' && site !== '') {
      if (!ALLOWED_SEC_FETCH_SITE.has(site.toLowerCase())) {
        return refuse(403, 'forbidden: cross-site request (Sec-Fetch-Site)');
      }
    }

    const declaresBody =
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > 0);
    if (!READ_ONLY_METHODS.has(req.method) && declaresBody) {
      const type = mediaType(req.headers['content-type']);
      if (type !== 'application/json') {
        return refuse(415, 'unsupported media type: expected application/json');
      }
    }
    return done();
  });

  // Clickjacking: the local UI must never be frameable by another site. Applied to
  // every response (API included) — it costs nothing there and means a future
  // route cannot forget it.
  app.addHook('onSend', (_req, reply, payload, done) => {
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    done(null, payload);
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
