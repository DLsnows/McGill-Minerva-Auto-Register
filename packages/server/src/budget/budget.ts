import type { BudgetCount, BudgetSnapshot } from '@autoregister/shared';
import type { Store } from '../store/store';

export type { BudgetCount, BudgetSnapshot };

/**
 * Turn one op-count + limit pair into a self-consistent counter. `used` is
 * clamped into `[0, limit]`, so lowering the limit below the number of ops
 * already spent reports `used === limit, remaining === 0` instead of a
 * negative remainder — `remaining` is always `limit - used` and a consumer
 * rendering `used / limit` can never produce a numerator above its denominator.
 */
function toCount(count: number, limit: number): BudgetCount {
  const used = Math.max(0, Math.min(count, limit));
  return { used, limit, remaining: limit - used };
}

/** Daily query/register budget guard, backed by the Store's daily op-counts. */
export class Budget {
  constructor(private readonly store: Store) {}

  canQuery(now = Date.now()): boolean {
    return this.store.getDailyOps(now).queryCount < this.store.getSettings().queryBudget;
  }

  canRegister(now = Date.now()): boolean {
    return this.store.getDailyOps(now).registerCount < this.store.getSettings().registerBudget;
  }

  recordQuery(now = Date.now()): void {
    this.store.incrementQuery(now);
  }

  recordRegister(now = Date.now()): void {
    this.store.incrementRegister(now);
  }

  remaining(now = Date.now()): { query: number; register: number } {
    const snap = this.snapshot(now);
    return { query: snap.query.remaining, register: snap.register.remaining };
  }

  /** Both budgets as of a single point in time: exactly one `getDailyOps()` and
   * one `getSettings()` read, so `used` / `limit` / `remaining` always agree —
   * a settings change mid-response can't produce a mixed-up pair. */
  snapshot(now = Date.now()): BudgetSnapshot {
    const ops = this.store.getDailyOps(now);
    const s = this.store.getSettings();
    return {
      query: toCount(ops.queryCount, s.queryBudget),
      register: toCount(ops.registerCount, s.registerBudget),
    };
  }
}
