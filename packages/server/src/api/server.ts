import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LogEvent, LogLevel, Settings } from '@autoregister/shared';
import { MAX_OP_PAUSE_MS, MIN_OP_PAUSE_MS } from '@autoregister/shared';
import type { Budget } from '../budget/budget';
import type { KeepAwakeReason, KeepAwakeStatus, PowerSource } from '../system/keep-awake';
import type { Store } from '../store/store';
import type { ForcedRunResult } from '../scheduler/scheduler';
import { SessionTruth, sessionReadiness, type SessionStatus } from './session-truth';
import { applyPacingSettings } from '../util/pacing';

export { SessionTruth, sessionReadiness };
export type { SessionStatus };

/** Error code returned by `POST /api/scheduler/start*` when the session cannot
 * support polling. Exported so the web client (and tests) can match on it
 * instead of on prose. */
export const SESSION_NOT_READY = 'session-not-ready';

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
  /** Request an immediate forced cycle. Returns what actually happened so the
   * route can distinguish "accepted" from "dropped" (audit Q16/Q60). */
  runTarget(id: string): ForcedRunResult;
  isRunning(): boolean;
  /** Re-apply the poll cadence to already-scheduled targets (after a settings
   * change). Optional so lightweight test doubles can omit it. */
  rescheduleWatching?(): void;
  /** Run one tick immediately if the engine is running (optional: test doubles). */
  tickSoon?(): void;
  /** Forget a target's consecutive-failure streak — explicit recovery (Q3), and
   * also applied when a target enters `watching`. Optional so lightweight test
   * doubles can omit it. */
  clearFailures?(targetId: string): void;
  /** Make a target due on the next tick. Optional, as above. */
  scheduleNow?(targetId: string): void;
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
 * WS client set (also used by the event broadcaster). The returned instance also
 * carries `sessions`, the authoritative session status (see `SessionTruth`). */
export function buildServer(
  deps: ApiDeps,
  clients: Set<WebSocket> = new Set(),
): FastifyInstance & { sessions: SessionTruth } {
  const app = Fastify({ logger: false });
  // The session's single source of truth. It is owned here (not by a closure
  // variable) precisely so that the *scheduler* can also write it: a cycle that
  // finds the session gone is the earliest and most reliable observation, and the
  // status it used to leave untouched is what let the UI keep showing "Active".
  const sessions = new SessionTruth();
  // Push every real transition to connected clients. The UI must not have to poll
  // for this: `GET /api/session` verifies liveness with a real navigation to
  // Minerva, so a timer-driven refresh would hammer the school's server.
  sessions.onChange((status) => {
    const event = sessionEvent(status);
    if (event) broadcast(clients, event);
  });

  /** Reject an engine start when polling could not possibly work, instead of
   * accepting the click and leaving the UI (and the user) to discover it later.
   * Purely local: it reads the status the server already holds and never probes
   * Minerva, so it cannot itself generate traffic against the school. */
  const requireSession = (reply: FastifyReply): FastifyReply | undefined => {
    const status = sessions.get();
    const readiness = sessionReadiness(status);
    if (readiness.ready) return undefined;
    return reply.code(409).send({ error: readiness.message, code: SESSION_NOT_READY, status });
  };

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

  // One clock for every "arm it now" decision. Injectable so tests can drive it from
  // the same source as the scheduler (see ApiDeps.now).
  const now = deps.now ?? Date.now;

  // `.after()` (not `.catch()`) — surfacing a plugin load failure without
  // prematurely triggering `ready()`, which would reject later route registration.
  // `maxPayload` replaces the `ws@8` `WebSocketServer` default of 100 MiB (not 0 /
  // unlimited — see `MAX_WS_PAYLOAD_BYTES`): `/api/stream` is a one-way broadcast and
  // the UI never sends a frame, so this only bounds abuse.
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
      // `reply.send()` alone is Fastify's documented early-response pattern from a
      // hook. Calling `done()` *as well* let the request continue into
      // `preParsing`/`preValidation` after it had already been answered: the result
      // was still correct only because `reply.sent` short-circuits those stages, so
      // every refused request paid for body parsing and schema validation it could
      // not use, and the correctness leaned on that internal guard.
      void reply.code(code).send({ error });
      return;
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
    // New targets default to 'watching' (store.addTarget). Give them a first
    // poll time right away: without it `nextPollAt` stays undefined and the
    // target is only picked up by the next tick, and there is no `watching`
    // transition afterwards that would set it.
    const created = deps.store.addTarget({
      ...parsed.data,
      nextPollAt: armForImmediatePoll(now()),
    });
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
    // Read the prior state before any gate: the edit-recovery block below needs it,
    // and a refused request must not have touched anything.
    const before = deps.store.getTarget(id);
    // Guard the one transition this route makes eager. A PATCH that flips a course back
    // to 'watching' now both arms an immediate poll AND clears the failure streak, so a
    // stray `{ status: 'watching' }` aimed at a course that already has a seat would
    // restart polling on it (burning the query budget every cycle) and could reach
    // `actor.act()` for a duplicate registration.
    //
    // The terminal set matches `/resume` and `start-all`'s `isDone` exactly. `stopped` is
    // included: whether it is "finished" or "deliberately turned off", both routes treat
    // it as terminal, and having PATCH disagree with them was the inconsistency.
    if (parsed.data.status === 'watching') {
      if (!before) return reply.code(404).send({ error: 'not found' });
      if (TERMINAL_STATUSES.includes(before.status)) {
        return reply.code(409).send({
          error: `cannot resume a target in status "${before.status}"`,
          status: before.status,
        });
      }
      // Setting a target to 'watching' is a promise that it will be polled — the
      // per-course "Resume" button also starts the engine right after this PATCH.
      // Without a usable session that promise cannot be kept, and the client that
      // asks for it may hold a stale session snapshot (the exact case that used to
      // leave a course 'watching' on a dead engine, with nothing to ever poll it).
      // Refusing here keeps the stored state honest, and the client shows the same
      // localized reason as for `/scheduler/start`.
      const denied = requireSession(reply);
      if (denied) return denied;
    }
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
  // The response says what really happened for this request:
  //   { started: true }                                  — accepted, runs async
  //   { started: false, reason: 'in progress' }          — a cycle already runs
  //   { started: false, reason: 'cooldown', retryAfterMs } — manual throttle
  //   { started: false, reason: 'target is <status>' }   — not being watched
  // The outcome of an accepted cycle still arrives via the event stream (like a
  // normal tick); `started` only means "this request was accepted". Returning a
  // blanket `started: true` is what made the button flash and do nothing
  // (audit Q16/Q60) — the dropped-vs-accepted distinction is the whole point.
  app.post('/api/targets/:id/run', (req, reply) => {
    const { id } = req.params as { id: string };
    const target = deps.store.getTarget(id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    // `runTarget` re-checks status, the in-flight guard and the manual cooldown,
    // and reports each case honestly rather than a bare started:true. Its
    // fast-fail status check is still best-effort: runCycle re-checks when it runs.
    return reply.send(deps.scheduler.runTarget(id));
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
      (parsed.data.jitterMinutes !== undefined &&
        parsed.data.jitterMinutes !== before.jitterMinutes);
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
    if (sessions.get() === 'authenticated') {
      try {
        const live = await deps.session.isLoggedIn();
        if (!live) sessions.set('logged-out');
      } catch {
        sessions.set('unknown');
      }
    }
    return { status: sessions.get() };
  });
  app.post('/api/session/login', () => {
    if (sessions.get() !== 'logging-in') {
      sessions.set('logging-in');
      void (async () => {
        // Safety net: if the browser/SSO flow hangs, reset the status so the
        // user can retry instead of being stuck in 'logging-in' forever.
        const timeout = setTimeout(() => {
          if (sessions.get() === 'logging-in') sessions.set('logged-out');
        }, LOGIN_TIMEOUT_MS);
        if (typeof timeout.unref === 'function') timeout.unref();
        try {
          await deps.session.launch();
          await deps.session.ensureLoggedIn();
          sessions.set((await deps.session.isLoggedIn()) ? 'authenticated' : 'logged-out');
        } catch {
          sessions.set('logged-out');
        } finally {
          clearTimeout(timeout);
        }
      })();
    }
    return { started: true };
  });

  // --- scheduler ---
  app.get('/api/scheduler', () => ({ running: deps.scheduler.isRunning() }));
  // Both start routes refuse to accept a click they cannot honour. Previously
  // they returned `{running:true}` unconditionally: with no session the engine
  // started anyway, the first tick's session check threw or paused everything,
  // and the user was left staring at a toggle that claimed the automation was
  // running. (That unhandled rejection inside the tick is a separate defect.)
  app.post('/api/scheduler/start', (_req, reply) => {
    const denied = requireSession(reply);
    if (denied) return denied;
    deps.scheduler.start();
    return { running: true };
  });
  app.post('/api/scheduler/stop', () => {
    deps.scheduler.stop();
    return { running: false };
  });
  // "Start all": revive every recoverable target — 'paused' (deliberately stopped)
  // and 'error' (parked by the three-strikes breaker) — then start the engine.
  // 'error' used to be a dead end the UI could not leave: it is neither pausable nor
  // resumable from the course card, and start-all collected only 'paused', so the
  // only way out was deleting and re-creating the course.
  //
  // The completed states (registered / waitlisted / stopped) stay untouched, and are
  // reported as `skipped` so "Start all" never looks like it did nothing (Q20). The
  // card's Resume button remains the explicit per-course opt-in for those.
  //
  // Every revived target is also armed as *due now*, so the immediate tick that
  // `scheduler.start()` fires polls it right away: that is the fix for "the first
  // Start does not actually start polling" — previously the flip to 'watching'
  // carried no `nextPollAt`, so the first real poll waited a whole 30s tick and
  // looked like a no-op.
  //
  // The session readiness check runs BEFORE any target is touched, so a refused
  // start leaves the stored state exactly as it was (no courses resumed on a dead
  // engine).
  app.post('/api/scheduler/start-all', (_req, reply) => {
    const denied = requireSession(reply);
    if (denied) return denied;
    const all = deps.store.listTargets();
    const toResume = all.filter((t) => t.status === 'paused' || t.status === 'error');
    // One timestamp for the whole batch, read from the injectable clock so it matches
    // the instant the immediate tick below will compare against.
    const armedAt = now();
    let recovered = 0;
    for (const t of toResume) {
      if (t.status === 'error') recovered += 1;
      deps.store.updateTarget(t.id, {
        status: 'watching',
        nextPollAt: armForImmediatePoll(armedAt),
      });
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
    // "Skipped" means "deliberately left alone because it is finished or failed" — NOT
    // "everything I did not resume". `all.length - toResume.length` also counted courses
    // that were already `watching`, i.e. actively polling, and reported them as skipped;
    // that is precisely the claim this count exists to avoid making. A `watching` course
    // is neither resumed nor skipped — it was already running.
    const skipped = all.filter((t) => isDone(t.status)).length;
    const errored = recovered;
    logStatus(
      `Start all: resumed ${toResume.length} course(s)` +
        (skipped > 0
          ? `, skipped ${skipped} (${errored} in error — use Resume on the card).`
          : '.'),
      undefined,
      skipped > 0 ? 'warn' : 'ok',
      { resumed: toResume.length, skipped, errored },
    );
    return {
      running: true,
      /** Targets revived out of the 'error' terminal state. */
      recovered,
      /** Paused targets put back under watch. */
      resumed: toResume.length - recovered,
      /** Terminal non-error targets left untouched. */
      skipped,
      /** Targets that had been parked by the failure breaker. */
      errored,
    };
  });
  // "Stop all": pause every actively-watching target, then stop the engine.
  // `scheduler.stop()` now also cancels any in-flight cycle, so nothing is
  // submitted after this returns (Q9/Q14) — the log line makes the stop visible,
  // matching what the cycle-level cancel event reports.
  //
  // Deliberately NOT gated on the session: stopping must always work.
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
  // "Resume watching" for one target: the per-course escape hatch out of 'error'
  // (a hard target that tripped the breaker) and out of a deliberate pause.
  //
  // Both branches matter. A paused target must poll now rather than at whatever
  // `nextPollAt` a previous cycle wrote (a budget back-off can be hours away), and
  // `start()` alone is a no-op when the engine is ALREADY running (other courses
  // still being watched) — so without `tickSoon()` the resumed course would wait out
  // the rest of the 30s interval, the very gap that made "Resume" look broken. And
  // an `error` target needs its failure streak cleared, or the next blip parks it
  // straight back into `error`.
  //
  // Only 'paused' and 'error' are revivable. 'registered' / 'waitlisted' are terminal
  // by design — `start-all` deliberately never touches them — and 'stopped' is a
  // deliberate user decision. Without that guard the route would put a course that
  // already has a seat back into the polling loop: it would burn the daily query
  // budget every cycle and, if `decide()` saw an opening for the target CRN, reach
  // `actor.act()` and submit a *duplicate* registration attempt.
  app.post('/api/targets/:id/resume', (req, reply) => {
    const { id } = req.params as { id: string };
    const target = deps.store.getTarget(id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    if (target.status === 'watching') {
      // Idempotent, but still make sure the engine is up and that a tick happens:
      // a client that calls resume on an already-watching target while the engine is
      // stopped means "poll this", and answering `{resumed:false}` without starting
      // anything would leave it idle. This is also what makes the route safe for the
      // UI's double-click.
      deps.scheduler.start();
      deps.scheduler.tickSoon?.();
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
    // Armed as due NOW (not "a few seconds from now"), so the immediate tick below
    // actually polls it — that is the fix for "I clicked Resume and nothing happened".
    deps.scheduler.scheduleNow?.(id);
    deps.scheduler.start();
    deps.scheduler.tickSoon?.();
    logStatus(`Resumed watching (was '${was}') — polling again.`, id, 'ok', { status: 'watching' });
    return reply.send({ resumed: true, status: 'watching' });
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

  // Exposed on the instance so `main.ts` can feed the scheduler's session-lost
  // observation back into it (and so tests can drive the status directly).
  // Fastify's `decorate` overloads don't propagate the property onto the
  // already-inferred instance type, so the intersection is asserted here.
  return Object.assign(app, { sessions }) as FastifyInstance & { sessions: SessionTruth };
}

/** Human-readable log line for a session transition. Only the transitions that
 * need explaining are announced — the live console explains *why* the session
 * cell went bad, instead of the dot flipping with no trace (the same class of
 * silent state change the audit flagged for the startup pause). A successful
 * login is already visible in the UI, so it stays quiet. */
export function sessionEvent(status: SessionStatus): LogEvent | undefined {
  if (status !== 'logged-out' && status !== 'unknown') return undefined;
  const message =
    status === 'logged-out'
      ? 'Session is no longer active — automation cannot poll. Log in again from the Session tab.'
      : 'Session state could not be verified — automation may not poll. Log in again from the Session tab.';
  return { id: randomUUID(), ts: Date.now(), level: 'warn', message };
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
