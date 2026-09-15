import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { buildServer, SESSION_NOT_READY, type ApiDeps } from './server';

type App = ReturnType<typeof buildServer>;

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
    scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
      scheduler: { start, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
      scheduler: { start: () => undefined, stop, runTarget: () => undefined, isRunning: () => true },
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
        scheduler: { start, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
        scheduler: { start, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
        scheduler: { start, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
        scheduler: { start: () => undefined, stop, runTarget: () => undefined, isRunning: () => true },
      });
      try {
        const r = await app2.inject({ method: 'POST', url: '/api/scheduler/stop-all' });
        expect(r.statusCode).toBe(200);
        expect(stop).toHaveBeenCalled();
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
        scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
          scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined, isRunning: () => false },
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
