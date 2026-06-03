import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionKind,
  Decision,
  RegisterOutcome,
  SectionStats,
  WatchMode,
} from '@autoregister/shared';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { Scheduler, type Actor, type SessionGuard, type Watcher } from './scheduler';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-sched-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-06-02T12:00:00').getTime();

function stats(overrides: Partial<SectionStats> = {}): SectionStats {
  return { crn: '1814', cap: 40, act: 40, rem: 0, wlcap: 20, wlact: 5, wlrem: 15, ...overrides };
}

class FakeWatcher implements Watcher {
  constructor(public result: { stats: SectionStats; decision: Decision } | null) {}
  calls = 0;
  checkCourse = async () => {
    this.calls++;
    return this.result;
  };
}
class FakeActor implements Actor {
  constructor(public outcome: RegisterOutcome) {}
  calls = 0;
  lastArgs?: [string, string, ActionKind];
  act = async (term: string, crn: string, action: ActionKind) => {
    this.calls++;
    this.lastArgs = [term, crn, action];
    return this.outcome;
  };
}
class FakeSession implements SessionGuard {
  constructor(public loggedIn = true) {}
  isLoggedIn = async () => this.loggedIn;
}

function setup(opts: {
  mode?: WatchMode;
  decision: Decision;
  stats?: SectionStats;
  outcome?: RegisterOutcome;
  loggedIn?: boolean;
}) {
  const store = new Store(dir);
  const budget = new Budget(store);
  const watcher = new FakeWatcher({ stats: opts.stats ?? stats(), decision: opts.decision });
  const actor = new FakeActor(opts.outcome ?? { kind: 'registered', crn: '1814' });
  const session = new FakeSession(opts.loggedIn ?? true);
  const scheduler = new Scheduler({
    store,
    budget,
    watcher,
    actor,
    session,
    now: () => NOW,
    random: () => 0.5, // zero jitter
  });
  const target = store.addTarget({
    term: '202701',
    subject: 'COMP',
    faculty: 'Faculty of Science',
    courseNumber: '551',
    targetCrn: '1814',
    mode: opts.mode ?? 'auto',
  });
  return { store, budget, watcher, actor, session, scheduler, target };
}

describe('Scheduler.runOnce', () => {
  it('NOOP keeps the target watching and schedules next', async () => {
    const { scheduler, store, target } = setup({ decision: { action: 'NOOP', reason: 'full' } });
    await scheduler.runOnce(target.id);
    const t = store.getTarget(target.id)!;
    expect(t.status).toBe('watching');
    expect(t.nextPollAt).toBeGreaterThan(NOW);
  });

  it('auto + REGISTER + registered → status registered, actor invoked', async () => {
    const { scheduler, store, actor, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
      outcome: { kind: 'registered', crn: '1814' },
    });
    await scheduler.runOnce(target.id);
    expect(actor.calls).toBe(1);
    expect(actor.lastArgs).toEqual(['202701', '1814', 'REGISTER']);
    expect(store.getTarget(target.id)!.status).toBe('registered');
  });

  it('auto + WAITLIST + waitlisted → status waitlisted', async () => {
    const { scheduler, store, target } = setup({
      decision: { action: 'WAITLIST', reason: 'wlrem>0' },
      outcome: { kind: 'waitlisted', crn: '1814' },
    });
    await scheduler.runOnce(target.id);
    expect(store.getTarget(target.id)!.status).toBe('waitlisted');
  });

  it('notify mode does NOT act, stays watching, logs an action-available event', async () => {
    const { scheduler, store, actor, target } = setup({
      mode: 'notify',
      decision: { action: 'REGISTER', reason: 'rem>0' },
    });
    await scheduler.runOnce(target.id);
    expect(actor.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('watching');
    expect(store.recentEvents().some((e) => /available/i.test(e.message))).toBe(true);
  });

  it('skips querying when the query budget is exhausted', async () => {
    const { scheduler, store, watcher, target } = setup({
      decision: { action: 'NOOP', reason: 'x' },
    });
    store.setSettings({ queryBudget: 0 });
    await scheduler.runOnce(target.id);
    expect(watcher.calls).toBe(0);
    expect(store.recentEvents().some((e) => /query budget/i.test(e.message))).toBe(true);
    // backs off until after the local-midnight reset (NOW is noon → ~12h away)
    expect(store.getTarget(target.id)!.nextPollAt!).toBeGreaterThan(NOW + 11 * 3600 * 1000);
  });

  it('does not register when the register budget is exhausted', async () => {
    const { scheduler, store, actor, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
    });
    store.setSettings({ registerBudget: 0 });
    await scheduler.runOnce(target.id);
    expect(actor.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('watching');
  });

  it('pauses the target when the session is logged out', async () => {
    const { scheduler, store, watcher, target } = setup({
      decision: { action: 'NOOP', reason: 'x' },
      loggedIn: false,
    });
    await scheduler.runOnce(target.id);
    expect(watcher.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('paused');
  });

  it('keeps watching and logs an error when registration errors', async () => {
    const { scheduler, store, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
      outcome: { kind: 'error', crn: '1814', message: 'Level Restriction' },
    });
    await scheduler.runOnce(target.id);
    const t = store.getTarget(target.id)!;
    expect(t.status).toBe('watching');
    expect(store.recentEvents().some((e) => e.level === 'error')).toBe(true);
  });

  it('force-runs a notify-mode target: acts despite the mode gate', async () => {
    const { scheduler, store, actor, target } = setup({
      mode: 'notify',
      decision: { action: 'WAITLIST', reason: 'wlrem>0' },
      outcome: { kind: 'waitlisted', crn: '1814' },
    });
    await scheduler.runOnce(target.id, { force: true });
    expect(actor.calls).toBe(1);
    expect(actor.lastArgs).toEqual(['202701', '1814', 'WAITLIST']);
    expect(store.getTarget(target.id)!.status).toBe('waitlisted');
  });

  it('dry-run: auto + opening logs "would" and does NOT act', async () => {
    const { scheduler, store, actor, budget, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
      outcome: { kind: 'registered', crn: '1814' },
    });
    store.setSettings({ dryRun: true });
    const before = budget.remaining(NOW).register;
    await scheduler.runOnce(target.id);
    expect(actor.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('watching');
    expect(budget.remaining(NOW).register).toBe(before); // register budget untouched
    expect(store.recentEvents().some((e) => /DRY-RUN: would REGISTER/.test(e.message))).toBe(true);
  });

  it('dry-run also applies to a forced (one-click) run', async () => {
    const { scheduler, store, actor, target } = setup({
      mode: 'notify',
      decision: { action: 'WAITLIST', reason: 'wlrem>0' },
      outcome: { kind: 'waitlisted', crn: '1814' },
    });
    store.setSettings({ dryRun: true });
    await scheduler.runOnce(target.id, { force: true });
    expect(actor.calls).toBe(0);
    expect(store.recentEvents().some((e) => /DRY-RUN: would WAITLIST/.test(e.message))).toBe(true);
  });

  it('stops watching (status error) after repeated CRN-not-found results', async () => {
    const store = new Store(dir);
    const watcher = new FakeWatcher(null); // target CRN never appears in the results
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: new FakeActor({ kind: 'registered', crn: '1814' }),
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '9999', mode: 'auto' });

    // First misses log an error but keep watching (absorbs a transient blip).
    await scheduler.runOnce(t.id);
    await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('watching');

    // The third consecutive miss hits the limit → error + stop watching.
    await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('error');
    expect(watcher.calls).toBe(3);
    expect(
      store.recentEvents().some((e) => e.level === 'error' && /not found in search results/i.test(e.message)),
    ).toBe(true);

    // Now stopped: a further run does not query again.
    await scheduler.runOnce(t.id);
    expect(watcher.calls).toBe(3);
  });

  it('skips a concurrent run of the same target (no double registration)', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '1814', mode: 'auto' });
    let releaseCheck!: () => void;
    const gate = new Promise<void>((r) => (releaseCheck = r));
    let checkCalls = 0;
    const watcher: Watcher = {
      checkCourse: async () => {
        checkCalls++;
        await gate; // hold the first run open so the second overlaps it
        return { stats: stats(), decision: { action: 'REGISTER', reason: 'rem>0' } };
      },
    };
    const actor = new FakeActor({ kind: 'registered', crn: '1814' });
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor,
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const p1 = scheduler.runOnce(t.id);
    const p2 = scheduler.runOnce(t.id); // in-flight → should skip immediately
    releaseCheck();
    await Promise.all([p1, p2]);
    expect(checkCalls).toBe(1);
    expect(actor.calls).toBe(1);
  });
});

describe('Scheduler.isRunning', () => {
  it('reflects start/stop', () => {
    const { scheduler } = setup({ decision: { action: 'NOOP', reason: 'x' } });
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});
