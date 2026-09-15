import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, cooldownRemainingMs, errorMessage, isSessionNotReady, MANUAL_RUN_COOLDOWN_MS, type ApiError } from './api';

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api', () => {
  it('getTargets GETs /api/targets and returns parsed JSON', async () => {
    const f = mockFetch([{ id: 't1' }]);
    vi.stubGlobal('fetch', f);
    const out = await api.getTargets();
    expect(f).toHaveBeenCalledWith('/api/targets', undefined);
    expect(out).toEqual([{ id: 't1' }]);
  });

  it('addTarget POSTs JSON body', async () => {
    const f = mockFetch({ id: 'new' });
    vi.stubGlobal('fetch', f);
    await api.addTarget({ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/targets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ subject: 'COMP', mode: 'auto' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('runTarget POSTs to /api/targets/:id/run', async () => {
    const f = mockFetch({ started: true });
    vi.stubGlobal('fetch', f);
    const out = await api.runTarget('abc');
    expect(f.mock.calls[0][0]).toBe('/api/targets/abc/run');
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(out).toEqual({ started: true });
  });

  it('bodyless POST sends no body and no JSON content-type (avoids Fastify empty-body 400)', async () => {
    const f = mockFetch({ started: true });
    vi.stubGlobal('fetch', f);
    await api.login();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/session/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('getScheduler GETs /api/scheduler', async () => {
    const f = mockFetch({ running: true });
    vi.stubGlobal('fetch', f);
    const out = await api.getScheduler();
    expect(f).toHaveBeenCalledWith('/api/scheduler', undefined);
    expect(out).toEqual({ running: true });
  });

  it('throws on non-ok response', async () => {
    const f = mockFetch({ error: 'bad' }, false, 400);
    vi.stubGlobal('fetch', f);
    // The API's own error shape carries a human-readable reason; surfacing it
    // verbatim is what lets a refusal read as a reason in the UI.
    await expect(api.getBudget()).rejects.toThrow('bad');
  });

  it('surfaces the server error code and reported session status', async () => {
    const f = mockFetch(
      { error: 'Not logged in — open the Session tab.', code: 'session-not-ready', status: 'logged-out' },
      false,
      409,
    );
    vi.stubGlobal('fetch', f);
    const err = await api.startAll().catch((e: unknown) => e);
    expect(isSessionNotReady(err)).toBe(true);
    expect((err as ApiError).sessionStatus).toBe('logged-out');
    expect(errorMessage(err)).toBe('Not logged in — open the Session tab.');
  });

  it('falls back to status + raw body when the error response is not JSON', async () => {
    const f = mockFetch('<html>502 Bad Gateway</html>', false, 502);
    vi.stubGlobal('fetch', f);
    await expect(api.getTargets()).rejects.toThrow(/502.*502 Bad Gateway/s);
  });

  it('getBudget returns the atomic used/limit/remaining snapshot, not a bare remaining count', async () => {
    const snapshot = {
      query: { used: 900, limit: 1000, remaining: 100 },
      register: { used: 4, limit: 20, remaining: 16 },
    };
    const f = mockFetch(snapshot);
    vi.stubGlobal('fetch', f);
    const out = await api.getBudget();
    expect(f).toHaveBeenCalledWith('/api/budget', undefined);
    expect(out).toEqual(snapshot);
    // The shell renders `used / limit` straight from this, so both halves must
    // come from the same response.
    expect(out.query.used).toBeLessThanOrEqual(out.query.limit);
    expect(out.query.remaining).toBe(out.query.limit - out.query.used);
  });
});

// Review finding (4th round): the local estimate and the server epoch were
// combined with `Math.max`, so the server epoch always participated — with a fast
// server clock that inflates the countdown, and a mid-window refetch would make a
// live countdown jump upwards. The local estimate must win outright whenever it
// exists; the server epoch is only the pre-first-response fallback.
describe('cooldownRemainingMs', () => {
  const NOW = 1_000_000;

  it('uses the local estimate alone, even when the server epoch disagrees wildly', () => {
    const localCoolingUntil = NOW + 45_000;
    const skewedServerStart = NOW + 120_000; // server clock minutes ahead
    expect(cooldownRemainingMs(skewedServerStart, localCoolingUntil, NOW)).toBe(45_000);
  });

  it('keeps an expired local estimate authoritative instead of reviving it from the server epoch', () => {
    const localCoolingUntil = NOW - 1; // the local window already ended
    const skewedServerStart = NOW + 120_000;
    expect(cooldownRemainingMs(skewedServerStart, localCoolingUntil, NOW)).toBe(0);
  });

  it('falls back to the server epoch when there is no local estimate (fresh page load)', () => {
    expect(cooldownRemainingMs(NOW - 20_000, undefined, NOW)).toBe(
      MANUAL_RUN_COOLDOWN_MS - 20_000,
    );
  });

  it('reports no cooldown when neither source exists', () => {
    expect(cooldownRemainingMs(undefined, undefined, NOW)).toBe(0);
  });
});
