import type { BudgetSnapshot } from './api';

/**
 * Test-only daily-budget fixture for the shared web tests: both budgets
 * completely untouched (`used = 0`, so `remaining = limit`). Kept in one place
 * so a change to the `BudgetSnapshot` contract shows up as a type error in every
 * test at once instead of drifting test-by-test.
 */
export const ZERO_BUDGET: BudgetSnapshot = {
  query: { used: 0, limit: 100, remaining: 100 },
  register: { used: 0, limit: 20, remaining: 20 },
};
