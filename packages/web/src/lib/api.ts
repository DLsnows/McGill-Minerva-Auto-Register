import type { BudgetSnapshot, LogEvent, Settings, WatchTarget } from '@autoregister/shared';

export type { BudgetCount, BudgetSnapshot } from '@autoregister/shared';
export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';
export interface SessionInfo {
  status: SessionStatus;
}
export interface SchedulerState {
  running: boolean;
}
/** Result of "Start all". `skipped` counts the targets the bulk action left
 * alone (terminal states + ones the failure breaker stopped), so the UI can say
 * what happened instead of showing an indistinguishable "nothing" (Q20). */
export interface StartAllResult {
  running: boolean;
  resumed: number;
  skipped: number;
  errored: number;
}

/** Error code the server attaches when it refuses to start the engine because the
 * session cannot support polling (see `session-truth.ts`). */
export const SESSION_NOT_READY = 'session-not-ready';

/** Manual-run cooldown, mirrored from `MANUAL_RUN_COOLDOWN_MS` in
 * packages/server/src/scheduler/scheduler.ts. Used to place the end of the window
 * on the client's own clock; the server enforces it and re-checks every request. */
export const MANUAL_RUN_COOLDOWN_MS = 60_000;

/** Result of `POST /api/targets/:id/run` — what *this request* did.
 *
 * `started: true` means the cycle was accepted and is running in the background;
 * its outcome still arrives via the event stream. `started: false` means the
 * request was dropped, and `reason` says why — the UI must show it, otherwise
 * the button just flashes and the click silently does nothing (audit Q16/Q60).
 * `reason` is an open string (the server also reports `target is <status>`, and
 * a future `'queued'` is reserved), so consumers must fall back to a neutral
 * message for values they don't know. */
export interface RunTargetResult {
  started: boolean;
  reason?: string;
  /** How much of the manual cooldown is left: the full window on acceptance, the
   * remainder on a `'cooldown'` rejection, 0/absent otherwise. A *duration*, so
   * the UI anchors it to its own receive time and needs no clock agreement with
   * the server. */
  retryAfterMs?: number;
  /** The target's `lastForcedRunAt` after this request (epoch ms, absent when it
   * never had a forced run). Informational — a freshly-loaded page can show a
   * running window without asking again. Deliberately *not* used for the
   * countdown: subtracting the client's clock from a server epoch is exactly what
   * makes a countdown skew-sensitive. */
  lastForcedRunAt?: number;
}

/** Milliseconds of manual-run cooldown left, as an instant on the *caller's*
 * clock.
 *
 * `localCoolingUntil` (a `retryAfterMs` duration anchored to the moment the
 * response arrived) wins **whenever it exists**, even if it is in the past —
 * that is what makes it exclusive rather than merely additive: taking a maximum
 * over both sources instead would let a stale or skewed server epoch keep the
 * countdown (and the button) alive after the local window has ended.
 *
 * `targetLastForcedRunAt` is the server's epoch for the window's start, used
 * **only** while there is no local estimate at all (a freshly-loaded page that
 * has not clicked yet). That path does subtract the client's clock from a server
 * epoch, so skew shows up in the rendered seconds; it is cosmetic, since the
 * server re-checks every request.
 *
 * 0 = a forced run is allowed now. */
export function cooldownRemainingMs(
  targetLastForcedRunAt: number | undefined,
  localCoolingUntil: number | undefined,
  now: number,
): number {
  if (localCoolingUntil !== undefined) return Math.max(0, localCoolingUntil - now);
  if (targetLastForcedRunAt === undefined) return 0;
  return Math.max(0, targetLastForcedRunAt + MANUAL_RUN_COOLDOWN_MS - now);
}

type NewTarget = Pick<WatchTarget, 'term' | 'subject' | 'courseNumber' | 'targetCrn' | 'mode'> &
  Partial<Pick<WatchTarget, 'faculty' | 'label'>>;

/** A failed request, carrying the server's machine-readable `code` when it sent
 * one — so the UI can localize the reason instead of printing raw prose. */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly httpStatus: number | undefined;
  /** The session state the server reported at the moment it refused. */
  readonly sessionStatus: string | undefined;

  constructor(
    message: string,
    opts: { code?: string; httpStatus?: number; sessionStatus?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.sessionStatus = opts.sessionStatus;
  }
}

/** True when the server refused because the session cannot drive polling. */
export function isSessionNotReady(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === SESSION_NOT_READY;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Read the body as text first — error responses may be HTML (e.g. a 502
    // page), not JSON.
    const detail = await res.text().catch(() => '');
    const what = `${init?.method ?? 'GET'} ${url}`;
    let body: unknown;
    try {
      body = JSON.parse(detail);
    } catch {
      body = undefined; // not JSON — fall back to reporting the raw text
    }
    if (body && typeof body === 'object') {
      // The API's own error shape: `{ error, code?, status? }`, where `status`
      // is the *session* status the refusal was based on (not the HTTP status).
      // Prefer the server's message over the raw JSON body so a refusal reads as
      // a reason ("Not logged in — ...") rather than as a serialized object.
      const { error, code, status } = body as { error?: unknown; code?: unknown; status?: unknown };
      const message = typeof error === 'string' && error ? error : `${what} failed: ${res.status}`;
      throw new ApiError(message, {
        code: typeof code === 'string' ? code : undefined,
        httpStatus: res.status,
        sessionStatus: typeof status === 'string' ? status : undefined,
      });
    }
    throw new ApiError(`${what} failed: ${res.status}${detail ? ` — ${detail}` : ''}`, {
      httpStatus: res.status,
    });
  }
  return (await res.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  // Only set the JSON content-type when there's an actual body. Sending the
  // header with an empty body makes Fastify reject it (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which breaks bodyless POSTs like /session/login, /scheduler/start, /:id/run.
  return req<T>(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  getTargets: () => req<WatchTarget[]>('/api/targets'),
  addTarget: (t: NewTarget) => post<WatchTarget>('/api/targets', t),
  updateTarget: (id: string, patch: Partial<WatchTarget>) =>
    req<WatchTarget>(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeTarget: (id: string) => req<{ ok: true }>(`/api/targets/${id}`, { method: 'DELETE' }),
  runTarget: (id: string) => post<RunTargetResult>(`/api/targets/${id}/run`),
  /** Explicitly watch a paused (or breaker-stopped `error`) target again (Q3). */
  resumeTarget: (id: string) =>
    post<{ resumed: boolean; status: WatchTarget['status'] }>(`/api/targets/${id}/resume`),

  getSettings: () => req<Settings>('/api/settings'),
  putSettings: (patch: Partial<Settings>) =>
    req<Settings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  getSession: () => req<SessionInfo>('/api/session'),
  login: () => post<{ started: boolean }>('/api/session/login'),

  getScheduler: () => req<SchedulerState>('/api/scheduler'),
  startScheduler: () => post<{ running: boolean }>('/api/scheduler/start'),
  stopScheduler: () => post<{ running: boolean }>('/api/scheduler/stop'),
  startAll: () => post<StartAllResult>('/api/scheduler/start-all'),
  stopAll: () => post<{ running: boolean; paused: number }>('/api/scheduler/stop-all'),

  getEvents: (limit = 200) => req<LogEvent[]>(`/api/events?limit=${limit}`),
  clearEvents: () => req<{ ok: true }>('/api/events', { method: 'DELETE' }),
  getBudget: () => req<BudgetSnapshot>('/api/budget'),
};
