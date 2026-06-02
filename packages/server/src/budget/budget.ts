import type { Store } from '../store/store';

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
    const ops = this.store.getDailyOps(now);
    const s = this.store.getSettings();
    return {
      query: Math.max(0, s.queryBudget - ops.queryCount),
      register: Math.max(0, s.registerBudget - ops.registerCount),
    };
  }
}
