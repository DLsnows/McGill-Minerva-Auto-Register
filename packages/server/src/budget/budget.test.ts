import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
