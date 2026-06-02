import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    scheduler: { start: () => undefined, stop: () => undefined },
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
});
