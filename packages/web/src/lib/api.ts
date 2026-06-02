import type { LogEvent, Settings, WatchTarget } from '@autoregister/shared';

export interface BudgetRemaining {
  query: number;
  register: number;
}
export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';
export interface SessionInfo {
  status: SessionStatus;
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
  return req<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  startScheduler: () => post<{ running: boolean }>('/api/scheduler/start'),
  stopScheduler: () => post<{ running: boolean }>('/api/scheduler/stop'),

  getEvents: (limit = 200) => req<LogEvent[]>(`/api/events?limit=${limit}`),
  getBudget: () => req<BudgetRemaining>('/api/budget'),
};
