import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { Scheduler } from '../scheduler/scheduler';
import { buildServer, SESSION_NOT_READY, type ApiDeps } from './server';

type App = ReturnType<typeof buildServer>;

/** ApiDeps for a test that drives the routes with a *real* Scheduler. */
function makeSessionDeps(store: Store, scheduler: Scheduler): ApiDeps {
  return {
    store,
    budget: new Budget(store),
    session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
    scheduler,
  };
}

let dir: string;
let app: App;

function makeSession() {
  return {
    launch: async () => undefined,
    ensureLoggedIn: async () => undefined,
    isLoggedIn: async () => true,
  };
}

function makeDeps(): ApiDeps {
  const store = new Store(dir);
  return {
    store,
    budget: new Budget(store),
    session: makeSession(),
    scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
  };
}

/** A server whose session is 'authenticated' — the only state in which the
 * engine may be started. Uses the real login route so nothing is faked beyond
 * the session double itself. */
async function loggedInApp(deps: ApiDeps, clients?: Parameters<typeof buildServer>[1]): Promise<App> {
  const instance = buildServer(deps, clients);
  await instance.inject({ method: 'POST', url: '/api/session/login' });
  // Let the async login IIFE settle (the doubles resolve immediately).
  await new Promise((r) => setTimeout(r, 10));
  return instance;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-api-'));
  app = buildServer(makeDeps());
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
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
    // The engine may only be started from an authenticated session (Q12).
    const active = await loggedInApp(makeDeps());
    try {
      expect((await active.inject({ method: 'POST', url: '/api/scheduler/start' })).json()).toEqual({
        running: true,
      });
      expect((await active.inject({ method: 'POST', url: '/api/scheduler/stop' })).json()).toEqual({
        running: false,
      });
    } finally {
      await active.close();
    }
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
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
    const runTarget = vi.fn(() => ({ started: true }));
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

  // Regression (audit Q16/Q60): a request dropped by the in-flight guard must not
  // be reported as accepted. Before the fix the route ignored runTarget's outcome
  // and unconditionally answered `{started:true}`.
  it('POST /api/targets/:id/run reports started:false/reason:in progress when a cycle is already running', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    const runTarget = vi.fn(() => ({ started: false, reason: 'in progress' }));
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget, isRunning: () => true },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: false, reason: 'in progress' });
    await app2.close();
  });

  // Regression (audit Q23): the manual-run cooldown is expressed through the same
  // response, including how long the caller must wait.
  it('POST /api/targets/:id/run reports started:false/reason:cooldown with retryAfterMs', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    const runTarget = vi.fn(() => ({ started: false, reason: 'cooldown', retryAfterMs: 42_000 }));
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: false, reason: 'cooldown', retryAfterMs: 42_000 });
    await app2.close();
  });

  it('POST /api/targets/:id/run returns 404 for a missing target', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/targets/nope/run' });
    expect(r.statusCode).toBe(404);
  });

  // End-to-end through the *real* scheduler: the mocked-scheduler cases above
  // pin the route's contract, these two pin that a real Scheduler actually
  // produces those verdicts (a mock can happily return a shape no code emits).
  it('POST /api/targets/:id/run answers {started:true} once, then cooldown for a real scheduler', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher: { checkCourse: async () => null },
      actor: { act: async () => ({ kind: 'not-found', crn: '2347' }) },
      session: { isLoggedIn: async () => true },
      now: () => Date.now(),
      random: () => 0.5,
    });
    const app2 = buildServer(makeSessionDeps(store, scheduler));
    const first = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.started).toBe(true);
    // The route echoes the window's start so the client can count down from the
    // server's clock instead of its own.
    expect(typeof firstBody.lastForcedRunAt).toBe('number');
    const second = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(second.statusCode).toBe(200);
    expect(second.json().started).toBe(false);
    expect(second.json().reason).toBe('cooldown');
    expect(second.json().retryAfterMs).toBeGreaterThan(0);
    expect(second.json().lastForcedRunAt).toBe(firstBody.lastForcedRunAt);
    await app2.close();
  });

  it('POST /api/targets/:id/run answers {started:false, reason:in progress} while a real cycle runs', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    let releaseCheck!: () => void;
    const gate = new Promise<void>((r) => (releaseCheck = r));
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher: {
        checkCourse: async () => {
          await gate;
          return null;
        },
      },
      actor: { act: async () => ({ kind: 'not-found', crn: '2347' }) },
      session: { isLoggedIn: async () => true },
      now: () => Date.now(),
      random: () => 0.5,
    });
    const app2 = buildServer(makeSessionDeps(store, scheduler));
    const first = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(first.json().started).toBe(true);
    const second = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(second.json()).toEqual({
      started: false,
      reason: 'in progress',
      lastForcedRunAt: first.json().lastForcedRunAt,
    });
    releaseCheck();
    await app2.close();
  });

  it('GET /api/scheduler reports running state', async () => {
    const store = new Store(dir);
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => true },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/scheduler' })).json()).toEqual({ running: true });
    await app2.close();
  });

  it('POST /api/targets/:id/run reports started:false for a non-watching target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    store.updateTarget(t.id, { status: 'paused' });
    // The status check lives in the scheduler now, so the route asks it and
    // relays the verdict — a target paused between check and call is therefore
    // still answered honestly instead of optimistically.
    const runTarget = vi.fn(() => ({ started: false, reason: 'target is paused' }));
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget, isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: false, reason: 'target is paused' });
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false, rescheduleWatching },
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

  it('POST /api/scheduler/start-all resumes paused targets (not error) and starts the engine', async () => {
    const store = new Store(dir);
    const start = vi.fn();
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' });
    const b = store.addTarget({ ...validTarget, targetCrn: '2222' });
    store.updateTarget(a.id, { status: 'paused' });
    store.updateTarget(b.id, { status: 'error' });
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: { start, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
    });
    const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });
    expect(r.json()).toMatchObject({ running: true, resumed: 1 });
    expect(store.getTarget(a.id)!.status).toBe('watching'); // paused → watching
    expect(store.getTarget(b.id)!.status).toBe('error'); // error left untouched
    expect(start).toHaveBeenCalled();
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
      scheduler: { start: () => undefined, stop, runTarget: () => ({ started: true }), isRunning: () => true },
    });
    const r = await app2.inject({ method: 'POST', url: '/api/scheduler/stop-all' });
    expect(r.json()).toMatchObject({ running: false, paused: 1 });
    expect(store.getTarget(a.id)!.status).toBe('paused'); // watching → paused
    expect(store.getTarget(b.id)!.status).toBe('registered'); // terminal left untouched
    expect(stop).toHaveBeenCalled();
    await app2.close();
  });

  // --- Q12: an engine start that cannot work must be refused, not accepted ---
  // Before the fix both routes answered `{running:true}` unconditionally with no
  // session and no browser context: the user got a toggle that claimed the
  // automation was running while the first tick's session check paused every
  // target (and, per Q1, could take the process down with it).
  describe('POST /api/scheduler/start* refuses a start with no usable session', () => {
    it('answers 409 + a machine-readable code on both start routes', async () => {
      const start = vi.fn();
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        for (const url of ['/api/scheduler/start', '/api/scheduler/start-all']) {
          const r = await app2.inject({ method: 'POST', url });
          expect(r.statusCode).toBe(409);
          const body = r.json() as { code: string; error: string; status: string };
          expect(body.code).toBe(SESSION_NOT_READY);
          expect(body.status).toBe('unknown');
          // The message has to be actionable on its own (curl / non-UI clients).
          expect(body.error.toLowerCase()).toContain('log in');
        }
        expect(start).not.toHaveBeenCalled();
      } finally {
        await app2.close();
      }
    });

    it('names the actual state when the session is known to be logged out', async () => {
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        // Make the server known-logged-out without going through a navigation.
        expect(app2.sessions.markLoggedOut()).toBe(true);
        const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start' });
        expect(r.statusCode).toBe(409);
        expect((r.json() as { status: string; error: string }).status).toBe('logged-out');
        expect((r.json() as { error: string }).error).toMatch(/not logged in/i);
      } finally {
        await app2.close();
      }
    });

    it('leaves stored targets untouched when start-all is refused', async () => {
      const store = new Store(dir);
      const start = vi.fn();
      const t = store.addTarget({ ...validTarget, targetCrn: '3333' });
      store.updateTarget(t.id, { status: 'paused' });
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });
        expect(r.statusCode).toBe(409);
        // The old code resumed the targets *before* touching the engine, so a
        // refused start used to leave courses 'watching' with nothing polling.
        expect(store.getTarget(t.id)!.status).toBe('paused');
        expect(start).not.toHaveBeenCalled();
      } finally {
        await app2.close();
      }
    });

    it('still accepts the start once the session is authenticated', async () => {
      const store = new Store(dir);
      const start = vi.fn();
      const app2 = await loggedInApp({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start' });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ running: true });
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        await app2.close();
      }
    });

    it('always allows stopping, even with no session', async () => {
      const store = new Store(dir);
      const stop = vi.fn();
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start: () => undefined, stop, runTarget: () => ({ started: true }), isRunning: () => true },
      });
      try {
        const r = await app2.inject({ method: 'POST', url: '/api/scheduler/stop-all' });
        expect(r.statusCode).toBe(200);
        expect(stop).toHaveBeenCalled();
      } finally {
        await app2.close();
      }
    });

    // The per-course "Resume" button PATCHes the target to 'watching' *before*
    // starting the engine, so a stale client could flip a course back to watching
    // and then have the start refused — leaving a course that claims to be polled
    // with no engine behind it. The PATCH itself has to refuse.
    it('refuses PATCH … status=watching without a usable session', async () => {
      const store = new Store(dir);
      const t = store.addTarget({ ...validTarget, targetCrn: '4444' });
      store.updateTarget(t.id, { status: 'paused' });
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        const r = await app2.inject({
          method: 'PATCH',
          url: `/api/targets/${t.id}`,
          payload: { status: 'watching' },
        });
        expect(r.statusCode).toBe(409);
        expect((r.json() as { code: string }).code).toBe(SESSION_NOT_READY);
        expect(store.getTarget(t.id)!.status).toBe('paused');
      } finally {
        await app2.close();
      }
    });

    it('still allows pausing (and other edits) with no session', async () => {
      const store = new Store(dir);
      const t = store.addTarget({ ...validTarget, targetCrn: '5555' }); // watching
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        const paused = await app2.inject({
          method: 'PATCH',
          url: `/api/targets/${t.id}`,
          payload: { status: 'paused' },
        });
        expect(paused.statusCode).toBe(200);
        expect(store.getTarget(t.id)!.status).toBe('paused');
        // A field edit that leaves the status alone is not gated either.
        const relabel = await app2.inject({
          method: 'PATCH',
          url: `/api/targets/${t.id}`,
          payload: { label: 'COMP 551 (renamed)' },
        });
        expect(relabel.statusCode).toBe(200);
      } finally {
        await app2.close();
      }
    });

    it('accepts PATCH … status=watching once the session is authenticated', async () => {
      const store = new Store(dir);
      const t = store.addTarget({ ...validTarget, targetCrn: '6666' });
      store.updateTarget(t.id, { status: 'paused' });
      const app2 = await loggedInApp({
        store,
        budget: new Budget(store),
        session: makeSession(),
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        const r = await app2.inject({
          method: 'PATCH',
          url: `/api/targets/${t.id}`,
          payload: { status: 'watching' },
        });
        expect(r.statusCode).toBe(200);
        expect(store.getTarget(t.id)!.status).toBe('watching');
      } finally {
        await app2.close();
      }
    });
  });

  // --- Q7 (server half): the reported status must follow the scheduler ---
  describe('session truth follows what the scheduler detected', () => {
    it('reports logged-out after the scheduler reports the session lost', async () => {
      const store = new Store(dir);
      const session = makeSession();
      const app2 = await loggedInApp({
        store,
        budget: new Budget(store),
        // The browser probe keeps saying "logged in" — the point is that the
        // scheduler's observation, not this probe, is what the API reports.
        session,
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        expect((await app2.inject({ method: 'GET', url: '/api/session' })).json().status).toBe('authenticated');
        expect(app2.sessions.markLoggedOut()).toBe(true);
        expect((await app2.inject({ method: 'GET', url: '/api/session' })).json().status).toBe('logged-out');
      } finally {
        await app2.close();
      }
    });

    it('reports unknown when the session check throws', async () => {
      const store = new Store(dir);
      const app2 = buildServer({
        store,
        budget: new Budget(store),
        session: {
          ...makeSession(),
          isLoggedIn: async () => {
            throw new Error('no browser context');
          },
        },
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
      });
      try {
        // The status was authenticated (e.g. login succeeded, then the browser
        // window died and the probe can no longer answer at all).
        app2.sessions.set('authenticated');
        const r = await app2.inject({ method: 'GET', url: '/api/session' });
        expect(r.statusCode).toBe(200);
        expect(r.json().status).toBe('unknown');
      } finally {
        await app2.close();
      }
    });

    it('pushes a warn event when the status turns bad, so the UI needs no polling', async () => {
      const store = new Store(dir);
      const sent: string[] = [];
      const clients = new Set([{ send: (frame: string) => sent.push(frame) }]);
      const app2 = await loggedInApp(
        {
          store,
          budget: new Budget(store),
          session: makeSession(),
          scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clients as any,
      );
      try {
        sent.length = 0; // drop anything the login sequence broadcast
        app2.sessions.markLoggedOut();
        const frames = sent.map(
          (f) => JSON.parse(f) as { type: string; event: { level: string; message: string } },
        );
        expect(frames).toHaveLength(1);
        expect(frames[0].type).toBe('event');
        expect(frames[0].event.level).toBe('warn');
        expect(frames[0].event.message).toMatch(/no longer active/i);
        // A repeated observation must not spam the console.
        sent.length = 0;
        expect(app2.sessions.markLoggedOut()).toBe(false);
        expect(sent).toHaveLength(0);
        // No probe was needed to learn this: the session double was never asked.
      } finally {
        await app2.close();
      }
    });
  });

  // --- Q3/Q20: the ways out of the `error` terminal state -------------------

  it('POST /api/targets/:id/resume revives an errored target, clears its streak and reschedules it', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'error', nextPollAt: Date.now() + 6 * 3600 * 1000 });
    const clearFailures = vi.fn();
    const scheduleNow = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
        clearFailures,
        scheduleNow,
      },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ resumed: true, status: 'watching' });
    expect(store.getTarget(t.id)!.status).toBe('watching');
    // Without clearing the streak one transient blip would look like 3 consecutive
    // failures and park the target straight back in 'error' — a button that appears
    // to do nothing.
    expect(clearFailures).toHaveBeenCalledWith(t.id);
    // Without this the target keeps its old (possibly hours-away) nextPollAt and
    // "resumed" is a lie until it elapses.
    expect(scheduleNow).toHaveBeenCalledWith(t.id);
    // And the recovery is visible in the app's own log, not just in the response.
    expect(store.recentEvents().some((e) => /Resumed watching/.test(e.message))).toBe(true);
    await app2.close();
  });

  it('POST /api/targets/:id/resume also works for a paused target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'paused' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });
    expect(r.json()).toEqual({ resumed: true, status: 'watching' });
    expect(store.getTarget(t.id)!.status).toBe('watching');
    await app2.close();
  });

  it('POST /api/targets/:id/resume refuses the completed states and reports a missing one', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'registered' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    // You already have the seat — re-watching it would only burn budget.
    const conflict = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });
    expect(conflict.statusCode).toBe(409);
    expect(store.getTarget(t.id)!.status).toBe('registered');
    expect(
      (await app2.inject({ method: 'POST', url: '/api/targets/nope/resume' })).statusCode,
    ).toBe(404);
    await app2.close();
  });

  it('PATCH with corrected query fields revives an errored target (the log tells the user to do this)', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'error' });
    const clearFailures = vi.fn();
    const scheduleNow = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
        clearFailures,
        scheduleNow,
      },
    });
    const r = await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${t.id}`,
      payload: { targetCrn: '2222' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('watching'); // the corrected query is actually polled
    expect(store.getTarget(t.id)!.targetCrn).toBe('2222');
    expect(store.getTarget(t.id)!.status).toBe('watching');
    expect(clearFailures).toHaveBeenCalledWith(t.id);
    expect(scheduleNow).toHaveBeenCalledWith(t.id);
    await app2.close();
  });

  it('PATCH of a non-query field leaves an errored target stopped', async () => {
    // Only the fields the error message blames are treated as "I fixed it".
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'error' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    const r = await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${t.id}`,
      payload: { label: 'renamed' },
    });
    expect(r.json().status).toBe('error');
    expect(store.getTarget(t.id)!.label).toBe('renamed');
    await app2.close();
  });

  it('PATCH of a query field does NOT un-pause a deliberately paused target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(t.id, { status: 'paused' });
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    const r = await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${t.id}`,
      payload: { courseNumber: '552' },
    });
    expect(r.json().status).toBe('paused'); // user intent wins
    await app2.close();
  });

  it('start-all reports how many courses it skipped, and why', async () => {
    const store = new Store(dir);
    const start = vi.fn();
    const paused = store.addTarget({ ...validTarget, targetCrn: '1111' });
    const errored = store.addTarget({ ...validTarget, targetCrn: '2222' });
    const done = store.addTarget({ ...validTarget, targetCrn: '3333' });
    store.updateTarget(paused.id, { status: 'paused' });
    store.updateTarget(errored.id, { status: 'error' });
    store.updateTarget(done.id, { status: 'registered' });
    const scheduleNow = vi.fn();
    // Start-all reaches the engine, which now refuses to start without a ready
    // session (Q12) — go through the real login route so the test exercises the
    // route it means to, instead of a 409.
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
        scheduleNow,
      },
    });
    const r = await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' });

    // The old response was just `{running:true, resumed:1}` — with one errored
    // course the user saw "resumed 0" and no explanation at all (Q20).
    expect(r.json()).toMatchObject({ running: true, resumed: 1, skipped: 2, errored: 1 });
    expect(store.getTarget(errored.id)!.status).toBe('error'); // still needs the explicit Resume
    expect(store.getTarget(paused.id)!.status).toBe('watching');
    expect(scheduleNow).toHaveBeenCalledWith(paused.id); // and is due now, not hours from now
    expect(store.recentEvents().some((e) => /skipped 2/.test(e.message))).toBe(true);
    expect(start).toHaveBeenCalled();
    await app2.close();
  });

  it('start-all reports a clean run when there is nothing to skip', async () => {
    const store = new Store(dir);
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(a.id, { status: 'paused' });
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    expect(
      (await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' })).json(),
    ).toMatchObject({
      resumed: 1,
      skipped: 0,
      errored: 0,
    });
    await app2.close();
  });

  it('start-all does not count already-watching courses as skipped', async () => {
    // Review finding (pr-agent): `all.length - resumed` reported actively-watched
    // courses as "skipped", i.e. it claimed active courses were left idle. The UI
    // avoids calling start-all in that state, but the API has no such guard.
    const store = new Store(dir);
    const paused = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.addTarget({ ...validTarget, targetCrn: '2222' }); // already watching
    const errored = store.addTarget({ ...validTarget, targetCrn: '3333' });
    store.updateTarget(paused.id, { status: 'paused' });
    store.updateTarget(errored.id, { status: 'error' });
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
    });
    const body = (await app2.inject({ method: 'POST', url: '/api/scheduler/start-all' })).json();

    // 1 paused (resumed) + 1 already active + 1 errored → only the errored one skipped.
    expect(body).toMatchObject({ resumed: 1, skipped: 1, errored: 1 });
    await app2.close();
  });

  it('resume and edit-recovery start the engine themselves', async () => {
    // Review finding (pr-agent): `scheduleNow` only writes nextPollAt. Without
    // starting the engine, an API client that does not also POST
    // /api/scheduler/start leaves the target 'watching' with no timer running —
    // the recovery silently does nothing.
    const store = new Store(dir);
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' });
    const b = store.addTarget({ ...validTarget, targetCrn: '2222' });
    store.updateTarget(a.id, { status: 'error' });
    store.updateTarget(b.id, { status: 'error' });
    const start = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: { start, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
    });

    await app2.inject({ method: 'POST', url: `/api/targets/${a.id}/resume` });
    expect(start).toHaveBeenCalledTimes(1);

    await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${b.id}`,
      payload: { targetCrn: '9999' },
    });
    expect(start).toHaveBeenCalledTimes(2);
    await app2.close();
  });

  it('pushes scheduler status changes to the live console, not just to the store', async () => {
    // The response body alone is not enough: the Dashboard is a stream client, and
    // the log line is how a user reconstructs "why did everything stop?".
    const store = new Store(dir);
    const a = store.addTarget({ ...validTarget, targetCrn: '1111' });
    store.updateTarget(a.id, { status: 'error' });
    const sent: string[] = [];
    const clients = new Set<{ send: (d: string) => void }>();
    clients.add({ send: (d: string) => sent.push(d) });
    const app2 = buildServer(
      {
        store,
        budget: new Budget(store),
        session: {
          launch: async () => undefined,
          ensureLoggedIn: async () => undefined,
          isLoggedIn: async () => true,
        },
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients as any,
    );
    await app2.inject({ method: 'POST', url: `/api/targets/${a.id}/resume` });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'event',
      event: { level: 'ok', message: expect.stringContaining('Resumed watching') },
    });
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
      scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => ({ started: true }), isRunning: () => false },
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
