import type { BudgetSnapshot, LogEvent, Settings, WatchTarget } from '@autoregister/shared';

export type { BudgetCount, BudgetSnapshot } from '@autoregister/shared';
export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';
export interface SessionInfo {
  status: SessionStatus;
}
export interface SchedulerState {
  running: boolean;
}

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
 * clock — so both inputs must be local-clock instants:
 *   - `localCoolingUntil`: end of the window estimated locally from a
 *     `retryAfterMs` duration anchored when the response arrived (preferred, no
 *     cross-clock arithmetic);
 *   - `targetLastForcedRunAt`: the server's epoch for the window's start, used
 *     only as a fallback when there is no local estimate (e.g. right after a
 *     reload). Cross-clock skew shows up here — acceptable for a cosmetic
 *     disable, since the server re-checks every request.
 * 0 = a forced run is allowed now. */
export function cooldownRemainingMs(
  targetLastForcedRunAt: number | undefined,
  localCoolingUntil: number | undefined,
  now: number,
): number {
  const fromServer =
    targetLastForcedRunAt === undefined ? 0 : targetLastForcedRunAt + MANUAL_RUN_COOLDOWN_MS - now;
  const fromLocal = localCoolingUntil === undefined ? 0 : localCoolingUntil - now;
  return Math.max(0, fromServer, fromLocal);
}

type NewTarget = Pick<WatchTarget, 'term' | 'subject' | 'courseNumber' | 'targetCrn' | 'mode'> &
  Partial<Pick<WatchTarget, 'faculty' | 'label'>>;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Read the body as text — error responses may be HTML (e.g. a 502 page), not JSON.
    const detail = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
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
  startAll: () => post<{ running: boolean; resumed: number }>('/api/scheduler/start-all'),
  stopAll: () => post<{ running: boolean; paused: number }>('/api/scheduler/stop-all'),

  getEvents: (limit = 200) => req<LogEvent[]>(`/api/events?limit=${limit}`),
  clearEvents: () => req<{ ok: true }>('/api/events', { method: 'DELETE' }),
  getBudget: () => req<BudgetSnapshot>('/api/budget'),
};
