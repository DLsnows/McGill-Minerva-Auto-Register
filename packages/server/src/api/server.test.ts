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
import { buildServer, SESSION_NOT_READY, type ApiDeps } from './server';

type App = ReturnType<typeof buildServer>;

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
let app: App;
/** The store that backs `app`, so a test can seed targets directly (deps are private). */
let seededStore: Store;

function makeSession() {
  return {
    launch: async () => undefined,
    ensureLoggedIn: async () => undefined,
    isLoggedIn: async () => true,
  };
}

function makeDeps(): ApiDeps {
  const store = new Store(dir);
  seededStore = store;
  return {
    store,
    budget: new Budget(store),
    session: makeSession(),
    scheduler: {
      start: () => undefined,
      stop: () => undefined,
      runTarget: () => ({ started: true }),
      isRunning: () => false,
    },
  };
}

/** ApiDeps for a test that drives the routes with a *real* Scheduler. */
function makeSessionDeps(store: Store, scheduler: Scheduler): ApiDeps {
  return {
    store,
    budget: new Budget(store),
    session: makeSession(),
    scheduler,
  };
}

/** A server whose session is 'authenticated' — the only state in which the
 * engine may be started. Uses the real login route so nothing is faked beyond
 * the session double itself. */
async function loggedInApp(
  deps: ApiDeps,
  clients?: Parameters<typeof buildServer>[1],
): Promise<App> {
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
    const r = await app.inject({
      method: 'POST',
      url: '/api/targets',
      payload: { subject: 'COMP' },
    });
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
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().notify.email).toBe(
      false,
    );
    // Re-reading from disk proves the override was persisted, not just masked.
    expect(new Store(dir).getSettings().notify.email).toBe(false);
  });

  it('accepts and persists the dryRun setting', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { dryRun: true },
    });
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

      await local.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { queryBudget: 1, registerBudget: 1 },
      });
      const body = (await local.inject({ method: 'GET', url: '/api/budget' })).json();

      // No negative remainder (the old arithmetic rendered "-6/1").
      expect(body.query).toEqual({ used: 1, limit: 1, remaining: 0 });
      expect(body.register).toEqual({ used: 1, limit: 1, remaining: 0 });
    } finally {
      await local.close();
    }
  });

  it('reports session status and toggles the scheduler', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/session' })).json()).toHaveProperty(
      'status',
    );
    // The engine may only be started from an authenticated session (Q12).
    const active = await loggedInApp(makeDeps());
    try {
      expect((await active.inject({ method: 'POST', url: '/api/scheduler/start' })).json()).toEqual(
        {
          running: true,
        },
      );
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
    const dead = {
      send: () => {
        throw new Error('boom');
      },
    };
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
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'notify',
    });
    const runTarget = vi.fn(() => ({ started: true }));
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
        runTarget,
        isRunning: () => false,
      },
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
    });
    const runTarget = vi.fn(() => ({ started: false, reason: 'in progress' }));
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
        runTarget,
        isRunning: () => true,
      },
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
    });
    const runTarget = vi.fn(() => ({ started: false, reason: 'cooldown', retryAfterMs: 42_000 }));
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
        runTarget,
        isRunning: () => false,
      },
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
    });
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
    });
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
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => true,
      },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/scheduler' })).json()).toEqual({
      running: true,
    });
    await app2.close();
  });

  it('POST /api/targets/:id/run reports started:false for a non-watching target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
    });
    store.updateTarget(t.id, { status: 'paused' });
    // The status check lives in the scheduler now, so the route asks it and
    // relays the verdict — a target paused between check and call is therefore
    // still answered honestly instead of optimistically.
    const runTarget = vi.fn(() => ({ started: false, reason: 'target is paused' }));
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
        runTarget,
        isRunning: () => false,
      },
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
      });
      expect((await app2.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
        ok: true,
      });
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
      });
      const r = await app2.inject({ method: 'GET', url: '/dashboard' });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Synapse');
      // API routes are unaffected by the SPA fallback
      expect((await app2.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
        ok: true,
      });
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
        rescheduleWatching,
      },
    });
    // Changed cadence (default is 30) → reschedule once.
    await app2.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { pollIntervalMinutes: 15 },
    });
    expect(rescheduleWatching).toHaveBeenCalledTimes(1);
    // Same value sent again (UI saves the whole object) → no reschedule.
    rescheduleWatching.mockClear();
    await app2.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { pollIntervalMinutes: 15 },
    });
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
    // `loggedInApp` (not a bare `buildServer`) because `/start-all` is gated on
    // session readiness — a raw app answers 409 and the counts below never appear.
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: makeSession(),
      scheduler: {
        start,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
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
        tickSoon,
      },
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
    // Going through the real login route: PATCHing a target to 'watching' is gated on
    // session readiness, and this test is about the arming/tick behaviour rather than
    // about the gate (which has its own cases).
    const app2 = await loggedInApp({
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
        tickSoon,
      },
    });
    const before = Date.now();
    const r = await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${t.id}`,
      payload: { status: 'watching' },
    });
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
    });
    await app2.inject({
      method: 'PATCH',
      url: `/api/targets/${t.id}`,
      payload: { status: 'paused' },
    });
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
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
        clearFailures,
        tickSoon,
        // The route arms the target through this hook (the real Scheduler writes
        // `nextPollAt = now`); without it in the double the timestamp stays unset.
        scheduleNow: (id: string) => store.updateTarget(id, { nextPollAt: Date.now() }),
      },
    });
    const before = Date.now();
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/resume` });
    expect(r.statusCode).toBe(200);
    // `resumed` (not `running`) is this route's contract — the client's
    // `resumeTarget` types it as `{ resumed, status }`, and the engine start is a
    // side effect it does not need echoed back.
    expect(r.json()).toMatchObject({ resumed: true, status: 'watching' });
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
    // `/start-all` is gated on session readiness, so go through the real login route.
    const app2 = await loggedInApp({
      store,
      budget: new Budget(store),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
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
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
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
    // This route is gated on session readiness.
    const app2 = await loggedInApp({
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
      },
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
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start: () => undefined,
        stop,
        runTarget: () => ({ started: true }),
        isRunning: () => true,
      },
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
        scheduler: {
          start,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start: () => undefined,
          stop,
          runTarget: () => ({ started: true }),
          isRunning: () => true,
        },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
      });
      try {
        expect((await app2.inject({ method: 'GET', url: '/api/session' })).json().status).toBe(
          'authenticated',
        );
        expect(app2.sessions.markLoggedOut()).toBe(true);
        expect((await app2.inject({ method: 'GET', url: '/api/session' })).json().status).toBe(
          'logged-out',
        );
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
        scheduler: {
          start: () => undefined,
          stop: () => undefined,
          runTarget: () => ({ started: true }),
          isRunning: () => false,
        },
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

    // Three targets: one paused, one parked by the breaker, one already registered.
    //
    // The merged contract revives the *error* target too — that is the "the first
    // Start must actually start polling" fix, and it is why `error` is reported as
    // `recovered` rather than counted as skipped. Only the completed state is left
    // alone. (The earlier reading of this test asserted that `error` stayed terminal
    // and was included in `skipped`; that was the audit side's semantics before the
    // product side changed it deliberately.)
    expect(r.json()).toMatchObject({
      running: true,
      resumed: 1,
      recovered: 1,
      skipped: 1,
      errored: 1,
    });
    expect(store.getTarget(errored.id)!.status).toBe('watching'); // revived, not parked
    expect(store.getTarget(paused.id)!.status).toBe('watching');
    expect(store.getTarget(done.id)!.status).toBe('registered'); // completed → untouched
    // Revived targets are armed "due now", which is an *effect* — the route reaches it
    // by writing `nextPollAt` itself rather than by calling the scheduler's
    // `scheduleNow` hook, so assert the state a tick reads, not the call that produced
    // it. A future timestamp here is exactly the bug that made a first "Start" look
    // like a no-op.
    const armedAt = store.getTarget(paused.id)!.nextPollAt;
    expect(armedAt).toBeDefined();
    expect(armedAt!).toBeLessThanOrEqual(Date.now());
    expect(store.recentEvents().some((e) => /skipped 1/.test(e.message))).toBe(true);
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

    // 1 paused + 1 already active + 1 parked by the breaker.
    //
    // Only the *completed* states count as skipped now: the error target is revived
    // (that is the "first Start must actually poll" fix, and it is reported through
    // `recovered`), and the already-watching one is neither resumed nor skipped —
    // it was already running, which is the pr-agent finding this test exists for.
    expect(body).toMatchObject({ resumed: 1, recovered: 1, skipped: 0, errored: 1 });
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
      scheduler: {
        start,
        stop: () => undefined,
        runTarget: () => ({ started: true }),
        isRunning: () => false,
      },
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
    });
    await app2.ready();
    // Attach the message listener via onInit: injectWS delivers the snapshot
    // over in-memory streams the instant the connection opens, so a listener
    // attached after `await injectWS()` would miss it.
    const snapshot = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no websocket message received')), 2000);
      void app2.injectWS(
        '/api/stream',
        { headers: { host: '127.0.0.1:4575', origin: 'http://127.0.0.1:4575' } },
        {
          onInit: (ws) =>
            ws.on('message', (d) => {
              clearTimeout(timer);
              resolve(String(d));
            }),
        },
      );
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

describe('API — power / keep-awake', () => {
  /** Records what the API asked the controller to do; never spawns anything. */
  function fakeKeepAwake(supported = true) {
    let enabled = false;
    let active = false;
    const status = () => ({
      supported,
      settingEnabled: enabled,
      active,
      powerSource: 'ac' as const,
      reason: active
        ? ('active' as const)
        : enabled
          ? ('unavailable' as const)
          : ('disabled' as const),
    });
    return {
      applied: [] as boolean[],
      status: vi.fn(status),
      apply: vi.fn(async (s: { keepAwake?: boolean }) => {
        enabled = s.keepAwake === true;
        active = supported && enabled;
        return status();
      }),
      stop: vi.fn(() => {
        enabled = false;
        active = false;
        return status();
      }),
    };
  }

  function buildWithPower(keepAwake: ReturnType<typeof fakeKeepAwake>) {
    const store = new Store(dir);
    return buildServer({
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
      keepAwake,
    });
  }

  let powered: FastifyInstance;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autoreg-power-'));
  });
  afterEach(async () => {
    await powered?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/power reports the controller status', async () => {
    const keepAwake = fakeKeepAwake();
    powered = buildWithPower(keepAwake);
    const r = await powered.inject({ method: 'GET', url: '/api/power' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      supported: true,
      enabled: false,
      active: false,
      powerSource: 'ac',
      reason: 'disabled',
    });
  });

  it('GET /api/power reports supported:false when the controller is absent', async () => {
    const store = new Store(dir);
    powered = buildServer({
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
    });
    const r = await powered.inject({ method: 'GET', url: '/api/power' });
    expect(r.json()).toEqual({
      supported: false,
      enabled: false,
      active: false,
      powerSource: 'unknown',
      reason: 'unsupported',
    });
  });

  it('PUT /api/settings persists keepAwake and applies it immediately', async () => {
    const keepAwake = fakeKeepAwake();
    powered = buildWithPower(keepAwake);

    const on = await powered.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwake: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().keepAwake).toBe(true);
    expect(keepAwake.apply).toHaveBeenLastCalledWith(expect.objectContaining({ keepAwake: true }));

    // The applied state is observable through /api/power without another save.
    expect((await powered.inject({ method: 'GET', url: '/api/power' })).json()).toMatchObject({
      enabled: true,
      active: true,
      reason: 'active',
    });

    const off = await powered.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwake: false },
    });
    expect(off.json().keepAwake).toBe(false);
    expect((await powered.inject({ method: 'GET', url: '/api/power' })).json()).toMatchObject({
      enabled: false,
      active: false,
      reason: 'disabled',
    });
  });

  it('rejects a non-boolean keepAwake with 400', async () => {
    powered = buildWithPower(fakeKeepAwake());
    const r = await powered.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwake: 'yes' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('defaults keepAwake to false so it is opt-in', async () => {
    powered = buildWithPower(fakeKeepAwake());
    const r = await powered.inject({ method: 'GET', url: '/api/settings' });
    expect(r.json().keepAwake).toBe(false);
  });
});
