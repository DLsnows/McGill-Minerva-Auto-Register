import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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
    await expect(api.getBudget()).rejects.toThrow(/400/);
  });
});
