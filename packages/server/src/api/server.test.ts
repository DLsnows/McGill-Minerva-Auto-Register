import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { Scheduler } from '../scheduler/scheduler';
import { getPacing, humanPause, resetPacing } from '../util/pacing';
import type { SectionStats } from '@autoregister/shared';
import { buildServer, type ApiDeps } from './server';

const testStats = (): SectionStats => ({
  crn: '1814',
  cap: 40,
  act: 40,
  rem: 0,
  wlcap: 20,
  wlact: 5,
  wlrem: 15,
});

let dir: string;
let app: FastifyInstance;
/** The store that backs `app`, so a test can seed targets directly (deps are private). */
let seededStore: Store;

function makeDeps(): ApiDeps {
  const store = new Store(dir);
  seededStore = store;
  return {
    store,
    budget: new Budget(store),
    session: {
      launch: async () => undefined,
      ensureLoggedIn: async () => undefined,
      isLoggedIn: async () => true,
    },
    scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-api-'));
  app = buildServer(makeDeps());
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  // The pacing config is module-level: a settings PUT would otherwise leak into
  // the next test.
  resetPacing();
});

const validTarget = {
  term: '202701',
  subject: 'COMP',
  faculty: 'Faculty of Science',
  courseNumber: '551',
  targetCrn: '1814',
  mode: 'auto' as const,
};

describe('API', () => {
  it('GET /api/health', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.json()).toEqual({ ok: true });
  });

  it('adds and lists targets', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/targets', payload: validTarget });
    expect(post.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/targets' });
    expect(list.json()).toHaveLength(1);
  });

  it('rejects an invalid target with 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/targets', payload: { subject: 'COMP' } });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a target missing faculty with 400', async () => {
    const noFaculty = {
      term: validTarget.term,
      subject: validTarget.subject,
      courseNumber: validTarget.courseNumber,
      targetCrn: validTarget.targetCrn,
      mode: validTarget.mode,
    };
    const r = await app.inject({ method: 'POST', url: '/api/targets', payload: noFaculty });
    expect(r.statusCode).toBe(400);
  });

  it('gets and updates settings (the email channel is forced off)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { pollIntervalMinutes: 45, notify: { desktop: true, sound: false, email: true } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().pollIntervalMinutes).toBe(45);
    // Email notifications are sunset: the request asks for `true`, the server
    // overrides it (the UI can't be trusted as the source of truth).
    expect(get.json().notify.email).toBe(false);
    // The channels that stay are persisted as sent.
    expect(get.json().notify.desktop).toBe(true);
    expect(get.json().notify.sound).toBe(false);
  });

  it('PUT /api/settings forces notify.email=false even with no UI in the loop', async () => {
    // A stale client (or a hand-written curl) can still send the old toggle on.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notify: { desktop: true, sound: true, email: true } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().notify.email).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().notify.email).toBe(false);
    // Re-reading from disk proves the override was persisted, not just masked.
    expect(new Store(dir).getSettings().notify.email).toBe(false);
  });

  it('accepts and persists the dryRun setting', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { dryRun: true } });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().dryRun).toBe(true);
  });

  it('accepts and persists the operation-speed settings', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { opPauseMs: 1500, opJitterMs: 200 },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().opPauseMs).toBe(1500);
    expect(get.json().opJitterMs).toBe(200);
  });

  it('rejects out-of-range operation-speed values with 400 (server-side bound)', async () => {
    const cases = [
      { opPauseMs: 0 }, // below the 250ms anti-detection floor
      { opPauseMs: 249 },
      { opPauseMs: 60_001 },
      { opJitterMs: -1 },
      { opJitterMs: 60_001 },
      { opPauseMs: Number.NaN }, // serialized as null
    ];
    for (const payload of cases) {
      const r = await app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Nothing was written by the rejected requests.
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().opPauseMs).toBe(3000);
    expect(get.json().opJitterMs).toBe(1000);
  });

  it('accepts the boundary operation-speed values', async () => {
    const low = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { opPauseMs: 250, opJitterMs: 0 },
    });
    expect(low.statusCode).toBe(200);
    const high = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { opPauseMs: 60_000, opJitterMs: 60_000 },
    });
    expect(high.statusCode).toBe(200);
  });

  it('re-applies a saved operation speed to subsequent humanPause calls', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { opPauseMs: 1500, opJitterMs: 100 },
    });
    expect(r.statusCode).toBe(200);
    expect(getPacing()).toEqual({ baseMs: 1500, jitterMs: 100 });
    // The next browser operation waits within the new range.
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(globalThis, 'setTimeout');
      void humanPause();
      const delay = Number(spy.mock.calls.at(-1)?.[1]);
      expect(delay).toBeGreaterThanOrEqual(1400);
      expect(delay).toBeLessThanOrEqual(1600);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges a partial operation-speed save with the stored values', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { opJitterMs: 250 } });
    expect(getPacing()).toEqual({ baseMs: 3000, jitterMs: 250 });
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { opPauseMs: 2000 } });
    expect(getPacing()).toEqual({ baseMs: 2000, jitterMs: 250 });
  });

  it('returns a self-consistent budget snapshot', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/budget' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      query: { used: 0, limit: 100, remaining: 100 },
      register: { used: 0, limit: 20, remaining: 20 },
    });
  });

  it('keeps the budget snapshot self-consistent in the same response after the limit is raised', async () => {
    const store = new Store(dir);
    const budget = new Budget(store);
    const local = buildServer({ ...makeDeps(), store, budget });
    try {
      for (let i = 0; i < 3; i++) budget.recordQuery();

      // The reported bug: raising the daily limit used to leave the UI pairing the
      // new limit with a stale remaining-count (1000 spent of 100 → "900/1000").
      await local.inject({ method: 'PUT', url: '/api/settings', payload: { queryBudget: 10000 } });
      const body = (await local.inject({ method: 'GET', url: '/api/budget' })).json();

      expect(body.query).toEqual({ used: 3, limit: 10000, remaining: 9997 });
      expect(body.query.used).toBeLessThanOrEqual(body.query.limit);
      expect(body.query.used + body.query.remaining).toBe(body.query.limit);
    } finally {
      await local.close();
    }
  });

  it('clamps used to the limit when the limit drops below the ops already spent', async () => {
    const store = new Store(dir);
    const budget = new Budget(store);
    const local = buildServer({ ...makeDeps(), store, budget });
    try {
      for (let i = 0; i < 7; i++) budget.recordQuery();
      for (let i = 0; i < 2; i++) budget.recordRegister();

      await local.inject({ method: 'PUT', url: '/api/settings', payload: { queryBudget: 1, registerBudget: 1 } });
      const body = (await local.inject({ method: 'GET', url: '/api/budget' })).json();

      // No negative remainder (the old arithmetic rendered "-6/1").
      expect(body.query).toEqual({ used: 1, limit: 1, remaining: 0 });
      expect(body.register).toEqual({ used: 1, limit: 1, remaining: 0 });
    } finally {
      await local.close();
    }
  });

  it('reports session status and toggles the scheduler', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/session' })).json()).toHaveProperty('status');
    expect((await app.inject({ method: 'POST', url: '/api/scheduler/start' })).json()).toEqual({
      running: true,
    });
    expect((await app.inject({ method: 'POST', url: '/api/scheduler/stop' })).json()).toEqual({
      running: false,
    });
  });

  it('rejects empty-string email fields with 400', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        email: { host: '', port: 587, user: 'u', pass: 'p', to: '' },
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('uses limit=0 as zero (not 200)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/events?limit=0' });
    expect(r.json()).toEqual([]);
  });

  it('falls back to default for non-numeric limit', async () => {
    // seed one event so default-limit returns it (proving we did NOT return [])
    const store = new Store(dir);
    store.appendEvent({ level: 'info', message: 'seed' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'GET', url: '/api/events?limit=abc' });
    expect(r.json()).toHaveLength(1);
    await app2.close();
  });

  it('DELETE /api/events clears the event log', async () => {
    const store = new Store(dir);
    store.appendEvent({ level: 'info', message: 'x' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/events' })).json()).toHaveLength(1);
    const del = await app2.inject({ method: 'DELETE', url: '/api/events' });
    expect(del.json()).toEqual({ ok: true });
    expect((await app2.inject({ method: 'GET', url: '/api/events' })).json()).toEqual([]);
    await app2.close();
  });

  it('broadcast removes dead clients from the set', async () => {
    const { broadcast } = await import('./server');
    const clients = new Set<{ send: () => void }>();
    const dead = { send: () => { throw new Error('boom'); } };
    clients.add(dead);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    broadcast(clients as any, { level: 'info', message: 'test', id: 'x', ts: 1 });
    expect(clients.has(dead)).toBe(false);
  });

  it('lazy-checks session status on GET when currently authenticated', async () => {
    const store = new Store(dir);
    let isLoggedIn = true;
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => isLoggedIn,
      },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    // Simulate a successful login — status becomes 'authenticated'
    await app2.inject({ method: 'POST', url: '/api/session/login' });
    // Let the async IIFE complete (mock functions resolve instantly,
    // but a microtask yield is needed)
    await new Promise((r) => setTimeout(r, 10));
    // Confirm we are authenticated
    let r = await app2.inject({ method: 'GET', url: '/api/session' });
    expect(r.json().status).toBe('authenticated');

    // Now simulate session expiry — isLoggedIn starts returning false
    isLoggedIn = false;
    r = await app2.inject({ method: 'GET', url: '/api/session' });
    // Lazy re-check should detect drift and flip to 'logged-out'
    expect(r.json().status).toBe('logged-out');
    await app2.close();
  });

  it('resets session status to logged-out when login hangs past the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: {
          launch: () => new Promise<void>(() => {}), // never resolves — simulates a hang
          ensureLoggedIn: async () => undefined,
          isLoggedIn: async () => false,
        },
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
      });
      await app2.inject({ method: 'POST', url: '/api/session/login' });
      // Still mid-login before the timeout fires
      let r = await app2.inject({ method: 'GET', url: '/api/session' });
      expect(r.json().status).toBe('logging-in');
      // Advance past the 6-min safety-net timeout — it resets the hung status
      vi.advanceTimersByTime(360_000);
      r = await app2.inject({ method: 'GET', url: '/api/session' });
      expect(r.json().status).toBe('logged-out');
      await app2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /api/targets/:id/run triggers runTarget for an existing target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'notify' });
    const runTarget = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: true });
    expect(runTarget).toHaveBeenCalledWith(t.id);
    await app2.close();
  });

  it('POST /api/targets/:id/run returns 404 for a missing target', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/targets/nope/run' });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/scheduler reports running state', async () => {
    const store = new Store(dir);
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => true },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/scheduler' })).json()).toEqual({ running: true });
    await app2.close();
  });

  it('POST /api/targets/:id/run reports started:false for a non-watching target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    store.updateTarget(t.id, { status: 'paused' });
    const runTarget = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json().started).toBe(false);
    expect(runTarget).not.toHaveBeenCalled();
    await app2.close();
  });

  it('skips static serving when the web dist is absent (API still works, non-API 404)', async () => {
    const missing = join(dir, 'no-such-dist');
    const prev = process.env.AUTOREG_WEB_DIST;
    process.env.AUTOREG_WEB_DIST = missing;
    try {
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
      });
      expect((await app2.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true });
      expect((await app2.inject({ method: 'GET', url: '/some-page' })).statusCode).toBe(404);
      await app2.close();
    } finally {
      if (prev === undefined) delete process.env.AUTOREG_WEB_DIST;
      else process.env.AUTOREG_WEB_DIST = prev;
    }
  });

  it('serves index.html for non-API GETs when the web dist is present (SPA fallback)', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'autoreg-dist-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Synapse</title>');
    const prev = process.env.AUTOREG_WEB_DIST;
    process.env.AUTOREG_WEB_DIST = distDir;
    try {
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
      });
      const r = await app2.inject({ method: 'GET', url: '/dashboard' });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Synapse');
      // API routes are unaffected by the SPA fallback
      expect((await app2.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true });
      await app2.close();
    } finally {
      if (prev === undefined) delete process.env.AUTOREG_WEB_DIST;
      else process.env.AUTOREG_WEB_DIST = prev;
      rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/settings reschedules only when the cadence actually changes', async () => {
    const store = new Store(dir);
    const rescheduleWatching = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false, rescheduleWatching },
    });
    // Changed cadence (default is 30) → reschedule once.
    await app2.inject({ method: 'PUT', url: '/api/settings', payload: { pollIntervalMinutes: 15 } });
    expect(rescheduleWatching).toHaveBeenCalledTimes(1);
    // Same value sent again (UI saves the whole object) → no reschedule.
    rescheduleWatching.mockClear();
    await app2.inject({ method: 'PUT', url: '/api/settings', payload: { pollIntervalMinutes: 15 } });
    expect(rescheduleWatching).not.toHaveBeenCalled();
    // An unrelated change → no reschedule.
    await app2.inject({ method: 'PUT', url: '/api/settings', payload: { queryBudget: 50 } });
    expect(rescheduleWatching).not.toHaveBeenCalled();
    await app2.close();
  });

  it('POST /api/scheduler/start-all resumes paused AND revives error targets, reports the counts', async () => {
    const store = new Store(dir);
    const start = vi.fn();
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' });
    const b = store.addTarget({ ...validTarget, targetCrn: '2222' });
    const c = store.addTarget({ ...validTarget, targetCrn: '3333' });
    store.updateTarget(a.id, { status: 'paused' });
    store.updateTarget(b.id, { status: 'error' });
    store.updateTarget(c.id, { status: 'registered' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });
    // 'error' used to be skipped, leaving the course permanently stopped with no
    // way out except deleting it.
    expect(r.json()).toMatchObject({ running: true, resumed: 1, recovered: 1, skipped: 1 });
    expect(store.getTarget(a.id)!.status).toBe('watching'); // paused → watching
    expect(store.getTarget(b.id)!.status).toBe('watching'); // error → watching (revived)
    expect(store.getTarget(c.id)!.status).toBe('registered'); // completed → untouched
    // Revived targets are armed as DUE NOW (not "a few seconds from now"), so the
    // immediate tick that start() fires actually polls them.
    const revived = store.getTarget(b.id)!.nextPollAt;
    expect(revived).toBeDefined();
    expect(revived!).toBeLessThanOrEqual(Date.now());
    expect(start).toHaveBeenCalled();
    await app2.close();
  });

  it('POST /api/targets gives a brand-new (watching) target an immediate first poll', async () => {
    const store = new Store(dir);
    const tickSoon = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false, tickSoon },
    });
    const before = Date.now();
    const res = await app2.inject({ method: 'POST', url: '/api/targets', payload: validTarget });
    expect(res.statusCode).toBe(200);
    const created = store.listTargets()[0];
    expect(created.status).toBe('watching');
    // Due now (not undefined, and not the 30-minute cadence), so the very next
    // tick — including the immediate one start() fires — polls it.
    expect(created.nextPollAt).toBeGreaterThanOrEqual(before);
    expect(created.nextPollAt!).toBeLessThanOrEqual(Date.now());
    expect(res.json().nextPollAt).toBe(created.nextPollAt);
    // Regression: this route armed `nextPollAt` but never kicked a tick, so adding a
    // course while the engine was already running left it waiting a full 30s interval
    // for its first poll — unlike PATCH / `/resume` / `start-all`, which all tick.
    expect(tickSoon).toHaveBeenCalledTimes(1);
    await app2.close();
  });

  it('PATCH paused → watching arms a due-now poll, clears the failure streak and ticks', async () => {
    const store = new Store(dir);
    const clearFailures = vi.fn();
    const tickSoon = vi.fn();
    const t = store.addTarget({ ...validTarget, targetCrn: '4444' });
    store.updateTarget(t.id, { status: 'paused', nextPollAt: undefined });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: {
        start: () => undefined, stop: () => undefined, runTarget: () => undefined,
        isRunning: () => false, clearFailures, tickSoon,
      },
    });
    const before = Date.now();
    const r = await app2.inject({ method: 'PATCH', url: `/api/targets/${t.id}`, payload: { status: 'watching' } });
    expect(r.statusCode).toBe(200);
    const next = store.getTarget(t.id)!.nextPollAt;
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThanOrEqual(before);
    // Due now — a future timestamp would make the immediate tick miss this target.
    expect(next!).toBeLessThanOrEqual(Date.now());
    expect(r.json().nextPollAt).toBe(next);
    expect(clearFailures).toHaveBeenCalledWith(t.id);
    expect(tickSoon).toHaveBeenCalled();
    await app2.close();
  });

  it('PATCH to a non-watching status leaves nextPollAt alone', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '5555' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    await app2.inject({ method: 'PATCH', url: `/api/targets/${t.id}`, payload: { status: 'paused' } });
    expect(store.getTarget(t.id)!.nextPollAt).toBeUndefined();
    await app2.close();
  });

  it('POST /api/targets/:id/resume revives an error target, clears its streak and kicks the engine', async () => {
    const store = new Store(dir);
    const start = vi.fn();
    const tickSoon = vi.fn();
    const clearFailures = vi.fn();
    const t = store.addTarget({ ...validTarget, targetCrn: '6666' });
    store.updateTarget(t.id, { status: 'error' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: {
        start, stop: () => undefined, runTarget: () => undefined,
        isRunning: () => false, clearFailures, tickSoon,
      },
    });
    const before = Date.now();
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ running: true, status: 'watching' });
    const revived = store.getTarget(t.id)!;
    expect(revived.status).toBe('watching');
    expect(revived.nextPollAt!).toBeGreaterThanOrEqual(before);
    // Due now, so a tick that fires right after this request polls it.
    expect(revived.nextPollAt!).toBeLessThanOrEqual(Date.now());
    expect(clearFailures).toHaveBeenCalledWith(t.id);
    expect(start).toHaveBeenCalled();
    // start() is a no-op when the engine already runs (other courses watched) —
    // tickSoon() is what guarantees an immediate poll in that case.
    expect(tickSoon).toHaveBeenCalled();
    await app2.close();
  });

  it('POST /api/targets/:id/resume returns 404 for a missing target', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/targets/nope/resume' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/targets/:id/resume refuses terminal targets (no duplicate registration)', async () => {
    // 'registered' / 'waitlisted' are terminal by design: `start-all` filters them out
    // and the card UI never offers Resume for them. The route itself used to accept
    // *any* id, which would put a course that already has a seat back into the polling
    // loop — burning the query budget every cycle and, if `decide()` saw an opening,
    // reaching `actor.act()` for a duplicate submit. 'stopped' is included so this route
    // and PATCH agree on the terminal set.
    for (const status of ['registered', 'waitlisted', 'stopped'] as const) {
      const t = seededStore.addTarget({ ...validTarget, targetCrn: '4242' });
      seededStore.updateTarget(t.id, { status });

      const r = await app.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });

      expect(r.statusCode).toBe(409);
      expect(seededStore.getTarget(t.id)!.status).toBe(status);
      seededStore.removeTarget(t.id);
    }
  });

  it('PATCH cannot flip a terminal target back to watching', async () => {
    // Same hazard on the PATCH path, which additionally arms an immediate poll and
    // clears the failure streak — so a stray `{ status: 'watching' }` used to both
    // restart polling and hand the course a fresh set of retries. The set must match
    // `/resume`: 'stopped' used to slip through here while `/resume` rejected it.
    for (const status of ['registered', 'waitlisted', 'stopped'] as const) {
      const t = seededStore.addTarget({ ...validTarget, targetCrn: '5150' });
      seededStore.updateTarget(t.id, { status });

      const r = await app.inject({
        method: 'PATCH',
        url: `/api/targets/${t.id}`,
        payload: { status: 'watching' },
      });

      expect(r.statusCode).toBe(409);
      expect(seededStore.getTarget(t.id)!.status).toBe(status);
      seededStore.removeTarget(t.id);
    }
  });

  it('REGRESSION: start-all arms revived targets as due-now and polls them in the same request', async () => {
    // End-to-end over the REAL scheduler and the REAL routes. The previous cut of
    // this fix armed revived targets with `nextPollAt = now + 0..3s`, which made
    // them miss the immediate tick `start()` fires (it runs at the same `now`) —
    // so a revived course still waited a whole 30s interval. A test that presets
    // `nextPollAt` by hand cannot catch that; this one goes through the route.
    const store = new Store(dir);
    const before = Date.now();
    // One frozen clock shared by the scheduler and the routes: the route arms the
    // target "due now" from this clock, and the immediate tick compares against the
    // same value — which is exactly the invariant under test.
    const clock = () => before;
    const watcher = {
      calls: 0,
      checkCourse: async () => {
        watcher.calls++;
        return { stats: testStats(), decision: { action: 'NOOP' as const, reason: 'full' } };
      },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: { act: async () => ({ kind: 'registered' as const, crn: '1814' }) },
      session: { isLoggedIn: async () => true },
      now: clock,
      random: () => 0.5,
    });
    const t = store.addTarget({ ...validTarget, targetCrn: '7777' });
    store.updateTarget(t.id, { status: 'error', nextPollAt: undefined });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler,
      now: clock,
    });
    try {
      const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });
      expect(r.json()).toMatchObject({ running: true, recovered: 1 });
      const armed = store.getTarget(t.id)!;
      expect(armed.status).toBe('watching');
      // `nextPollAt` is NOT the observable to assert on here: the immediate tick really
      // runs (that is the point), and when its cycle finishes `scheduleNext()` rewrites
      // `nextPollAt` to the *next* interval. Asserting on it would be asserting on the
      // post-cycle schedule, not on what the route armed. What proves the fix is that
      // the poll happened at all, right now — `lastPolledAt` is set from the same clock.
      await vi.waitFor(() => expect(watcher.calls).toBe(1));
      expect(store.getTarget(t.id)!.lastPolledAt).toBe(before);
      expect(store.recentEvents().some((e) => /No opening/.test(e.message))).toBe(true);
    } finally {
      scheduler.stop();
      await app2.close();
    }
  });

  it('REGRESSION: POST /api/targets/:id/resume polls immediately even when the engine is already running', async () => {
    const store = new Store(dir);
    const before = Date.now();
    // One frozen clock shared by the scheduler and the routes — see the note in the
    // start-all regression test above.
    const clock = () => before;
    const watcher = {
      calls: 0,
      checkCourse: async () => {
        watcher.calls++;
        return { stats: testStats(), decision: { action: 'NOOP' as const, reason: 'full' } };
      },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: { act: async () => ({ kind: 'registered' as const, crn: '1814' }) },
      session: { isLoggedIn: async () => true },
      now: clock,
      random: () => 0.5,
    });
    // Another course is already being watched, so the engine is already running:
    // `start()` inside the resume route is a no-op, and only `tickSoon()` can make
    // the resumed course poll before the next 30s interval.
    const other = store.addTarget({ ...validTarget, targetCrn: '8888' });
    store.updateTarget(other.id, { nextPollAt: before + 3_600_000 }); // not due
    scheduler.start();
    const t = store.addTarget({ ...validTarget, targetCrn: '9999' });
    store.updateTarget(t.id, { status: 'error', nextPollAt: undefined });

    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler,
      now: clock,
    });
    try {
      const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });
      expect(r.statusCode).toBe(200);
      // Same reasoning as the start-all test: asserting on `nextPollAt` would race the
      // cycle's own `scheduleNext()`. The resumed target was polled immediately (from
      // the shared clock), which is the behaviour under test.
      await vi.waitFor(() => expect(watcher.calls).toBe(1));
      expect(store.getTarget(t.id)!.lastPolledAt).toBe(before);
      // The untouched watching course was not due, so it was NOT polled too.
      expect(watcher.calls).toBe(1);
    } finally {
      scheduler.stop();
      await app2.close();
    }
  });

  it('start-all only clears the failure streak of the targets it revives', async () => {
    const store = new Store(dir);
    const clearFailures = vi.fn();
    const a = store.addTarget({ ...validTarget, targetCrn: 'a111' }); // paused → revived
    const b = store.addTarget({ ...validTarget, targetCrn: 'b222' }); // error  → revived
    const c = store.addTarget({ ...validTarget, targetCrn: 'c333' }); // already watching
    store.updateTarget(a.id, { status: 'paused' });
    store.updateTarget(b.id, { status: 'error' });
    expect(store.getTarget(c.id)!.status).toBe('watching');
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false, clearFailures },
    });
    await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });
    // Scoped: a watching course that is merely continuing keeps its streak.
    expect(clearFailures.mock.calls.map((calls) => calls[0]).sort()).toEqual([a.id, b.id].sort());
    expect(clearFailures).not.toHaveBeenCalledWith(c.id);
    await app2.close();
  });

  it('POST /api/scheduler/stop-all pauses watching targets and stops the engine', async () => {
    const store = new Store(dir);
    const stop = vi.fn();
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' }); // watching by default
    const b = store.addTarget({ ...validTarget, targetCrn: '2222' });
    store.updateTarget(b.id, { status: 'registered' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop, runTarget: () => undefined, isRunning: () => true },
    });
    const r = await app2.inject({ method: 'POST', url: '/api/scheduler/stop-all' });
    expect(r.json()).toMatchObject({ running: false, paused: 1 });
    expect(store.getTarget(a.id)!.status).toBe('paused'); // watching → paused
    expect(store.getTarget(b.id)!.status).toBe('registered'); // terminal left untouched
    expect(stop).toHaveBeenCalled();
    await app2.close();
  });

  // Guards the @fastify/websocket registration-timing bug: a route declared
  // synchronously before the plugin loads silently becomes a plain GET, and the
  // upgrade 500s ("socket.on is not a function") — the client then reconnects
  // forever. A real upgrade via injectWS must open and deliver the snapshot.
  it('serves the recent-events snapshot over the /api/stream websocket', async () => {
    const store = new Store(dir);
    store.appendEvent({ level: 'info', message: 'stream hello' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
    });
    await app2.ready();
    // Attach the message listener via onInit: injectWS delivers the snapshot
    // over in-memory streams the instant the connection opens, so a listener
    // attached after `await injectWS()` would miss it.
    const snapshot = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no websocket message received')), 2000);
      void app2.injectWS('/api/stream', {}, {
        onInit: (ws) =>
          ws.on('message', (d) => {
            clearTimeout(timer);
            resolve(String(d));
          }),
      });
    });
    try {
      const msg = JSON.parse(await snapshot) as { type: string; events: { message: string }[] };
      expect(msg.type).toBe('recent');
      expect(msg.events.some((e) => e.message === 'stream hello')).toBe(true);
    } finally {
      await app2.close();
    }
  });
});
