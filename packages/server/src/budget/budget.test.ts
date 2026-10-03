import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store';
import { Budget } from './budget';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-budget-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Budget', () => {
  it('allows queries under budget and blocks at budget', () => {
    const s = new Store(dir);
    s.setSettings({ queryBudget: 2 });
    const b = new Budget(s);
    expect(b.canQuery()).toBe(true);
    b.recordQuery();
    b.recordQuery();
    expect(b.canQuery()).toBe(false);
  });

  it('tracks register budget independently of query budget', () => {
    const s = new Store(dir);
    s.setSettings({ registerBudget: 1 });
    const b = new Budget(s);
    expect(b.canRegister()).toBe(true);
    b.recordRegister();
    expect(b.canRegister()).toBe(false);
    expect(b.canQuery()).toBe(true);
  });

  it('reports remaining budget', () => {
    const s = new Store(dir);
    s.setSettings({ queryBudget: 5, registerBudget: 3 });
    const b = new Budget(s);
    b.recordQuery();
    expect(b.remaining()).toEqual({ query: 4, register: 3 });
  });

  describe('snapshot()', () => {
    it('reports a fresh day: nothing used, full limits', () => {
      const s = new Store(dir);
      s.setSettings({ queryBudget: 100, registerBudget: 20 });
      const b = new Budget(s);
      expect(b.snapshot()).toEqual({
        query: { used: 0, limit: 100, remaining: 100 },
        register: { used: 0, limit: 20, remaining: 20 },
      });
    });

    it('reports partial usage', () => {
      const s = new Store(dir);
      s.setSettings({ queryBudget: 100, registerBudget: 20 });
      const b = new Budget(s);
      for (let i = 0; i < 12; i++) b.recordQuery();
      b.recordRegister();
      expect(b.snapshot()).toEqual({
        query: { used: 12, limit: 100, remaining: 88 },
        register: { used: 1, limit: 20, remaining: 19 },
      });
    });

    it('clamps to the limit when more ops were spent than the limit allows', () => {
      const s = new Store(dir);
      s.setSettings({ queryBudget: 100, registerBudget: 20 });
      const b = new Budget(s);
      for (let i = 0; i < 7; i++) b.recordQuery();
      // Lowering the limit under the already-spent count must not produce a
      // negative remainder (the old `limit - count` arithmetic showed "-895/100").
      s.setSettings({ queryBudget: 5, registerBudget: 0 });
      expect(b.snapshot()).toEqual({
        query: { used: 5, limit: 5, remaining: 0 },
        register: { used: 0, limit: 0, remaining: 0 },
      });
    });

    it('reads settings exactly once so used/limit/remaining always agree', () => {
      const s = new Store(dir);
      s.setSettings({ queryBudget: 100 });
      const opsSpy = vi.spyOn(s, 'getDailyOps');
      const settingsSpy = vi.spyOn(s, 'getSettings');
      const snap = new Budget(s).snapshot();
      expect(opsSpy).toHaveBeenCalledTimes(1);
      expect(settingsSpy).toHaveBeenCalledTimes(1);
      expect(snap.query.used + snap.query.remaining).toBe(snap.query.limit);
      expect(snap.register.used + snap.register.remaining).toBe(snap.register.limit);
    });

    it('keeps remaining non-negative and consistent with used/limit for any count', () => {
      // A minimal store stub: only the three readers `snapshot()` touches. Lets
      // every limit/count combination be checked without touching the disk.
      const stub = (limit: number, count: number) =>
        ({
          getDailyOps: () => ({ date: '2027-01-01', queryCount: count, registerCount: count }),
          getSettings: () => ({ queryBudget: limit, registerBudget: limit }),
        }) as unknown as Store;
      for (const limit of [0, 1, 5, 9999]) {
        for (const count of [0, 1, 3, 12]) {
          const snap = new Budget(stub(limit, count)).snapshot();
          for (const key of ['query', 'register'] as const) {
            const c = snap[key];
            expect(c.used).toBe(Math.min(count, limit));
            expect(c.used).toBeGreaterThanOrEqual(0);
            expect(c.used).toBeLessThanOrEqual(c.limit);
            expect(c.remaining).toBe(c.limit - c.used);
            expect(c.remaining).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });
});
