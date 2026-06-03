import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { buildServer, type ApiDeps } from './server';

let dir: string;
let app: FastifyInstance;

function makeDeps(): ApiDeps {
  const store = new Store(dir);
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
});

const validTarget = {
  term: '202701',
  subject: 'COMP',
  faculty: 'Faculty of Science',
  courseNumber: '551',
  targetCrn: '1814',
  mode: 'auto',
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

  it('gets and updates settings (incl. email)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { pollIntervalMinutes: 45, notify: { desktop: true, sound: false, email: true } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().pollIntervalMinutes).toBe(45);
    expect(get.json().notify.email).toBe(true);
  });

  it('accepts and persists the dryRun setting', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { dryRun: true } });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().dryRun).toBe(true);
  });

  it('returns budget remaining', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/budget' });
    expect(r.json()).toHaveProperty('query');
    expect(r.json()).toHaveProperty('register');
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
      // Advance past the 120s login timeout — the safety net resets the status
      vi.advanceTimersByTime(120_000);
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
});
