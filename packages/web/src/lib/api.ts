import type { BudgetSnapshot, LogEvent, Settings, WatchTarget } from '@autoregister/shared';

export type { BudgetCount, BudgetSnapshot } from '@autoregister/shared';
export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';
export interface SessionInfo {
  status: SessionStatus;
}
export interface SchedulerState {
  running: boolean;
}
/** Error code the server attaches when it refuses to start the engine because the
 * session cannot support polling (see `session-truth.ts`). */
export const SESSION_NOT_READY = 'session-not-ready';

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
  runTarget: (id: string) => post<{ started: boolean }>(`/api/targets/${id}/run`),

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
