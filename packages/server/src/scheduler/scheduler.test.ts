import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MANUAL_RUN_COOLDOWN_MS, Scheduler, type Actor, type SessionGuard, type Watcher } from './scheduler';

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
/** A session probe that blows up — e.g. the browser context died mid-cycle. */
class ExplodingSession implements SessionGuard {
  isLoggedIn = async (): Promise<boolean> => {
    throw new Error('no browser context');
  };
}

function setup(opts: {
  mode?: WatchMode;
  decision: Decision;
  stats?: SectionStats;
  outcome?: RegisterOutcome;
  loggedIn?: boolean;
  session?: SessionGuard;
  onSessionLost?: (reason: string) => void;
}) {
  const store = new Store(dir);
  const budget = new Budget(store);
  const watcher = new FakeWatcher({ stats: opts.stats ?? stats(), decision: opts.decision });
  const actor = new FakeActor(opts.outcome ?? { kind: 'registered', crn: '1814' });
  const session = opts.session ?? new FakeSession(opts.loggedIn ?? true);
  const scheduler = new Scheduler({
    store,
    budget,
    watcher,
    actor,
    session,
    now: () => NOW,
    random: () => 0.5, // zero jitter
    onSessionLost: opts.onSessionLost,
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

  // The API's reported session status is corrected from here: a cycle that finds
  // no session is the earliest reliable evidence, and without reporting it
  // `GET /api/session` kept answering 'authenticated' while every target sat
  // paused — the UI then showed a green "Active" over a stopped engine (Q7/Q12).
  it('reports the lost session so the API can stop claiming it is authenticated', async () => {
    const reasons: string[] = [];
    const { scheduler, target } = setup({
      decision: { action: 'NOOP', reason: 'x' },
      loggedIn: false,
      onSessionLost: (r) => reasons.push(r),
    });
    await scheduler.runOnce(target.id);
    expect(reasons).toEqual(['session check returned not-logged-in']);
  });

  it('reports a throwing session probe as a lost session instead of only logging it', async () => {
    const reasons: string[] = [];
    const { scheduler, store, target } = setup({
      decision: { action: 'NOOP', reason: 'x' },
      session: new ExplodingSession(),
      onSessionLost: (r) => reasons.push(r),
    });
    await scheduler.runOnce(target.id);
    expect(reasons).toEqual(['no browser context']);
    expect(store.getTarget(target.id)!.status).toBe('paused');
    expect(store.recentEvents().some((e) => e.level === 'warn' && /no browser context/.test(e.message))).toBe(
      true,
    );
  });

  it('accepts a handler registered after construction (the API wires it up later)', async () => {
    const { scheduler, store, target } = setup({ decision: { action: 'NOOP', reason: 'x' }, loggedIn: false });
    const reasons: string[] = [];
    scheduler.setSessionLostHandler((r) => reasons.push(r));
    await scheduler.runOnce(target.id);
    expect(reasons).toHaveLength(1);
    // The cycle paused the target; re-arm it to prove the late-registered
    // handler keeps firing on later cycles, not just the first one.
    store.updateTarget(target.id, { status: 'watching' });
    await scheduler.runOnce(target.id);
    expect(reasons).toHaveLength(2);
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

  it('stopping one unfindable target leaves the other targets polling', async () => {
    const store = new Store(dir);
    const good = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '1814', mode: 'auto' });
    const bad = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '9999', mode: 'notify' });
    let goodCalls = 0;
    const watcher: Watcher = {
      checkCourse: async (q) => {
        if (q.targetCrn === '9999') return null; // this CRN is never in the results
        goodCalls++;
        return { stats: stats({ crn: '1814' }), decision: { action: 'NOOP', reason: 'full' } };
      },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: new FakeActor({ kind: 'registered', crn: '1814' }),
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });

    for (let i = 0; i < 4; i++) {
      await scheduler.runOnce(bad.id);
      await scheduler.runOnce(good.id);
    }

    expect(store.getTarget(bad.id)!.status).toBe('error'); // this one stopped
    expect(store.getTarget(good.id)!.status).toBe('watching'); // the other unaffected
    expect(goodCalls).toBe(4); // and it kept being polled every cycle
  });

  it('stops a target after repeated registration errors (any error trips the breaker)', async () => {
    const { scheduler, store, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
      outcome: { kind: 'error', crn: '1814', message: 'Level Restriction' },
    });
    await scheduler.runOnce(target.id);
    await scheduler.runOnce(target.id);
    expect(store.getTarget(target.id)!.status).toBe('watching'); // still retrying
    await scheduler.runOnce(target.id);
    expect(store.getTarget(target.id)!.status).toBe('error'); // 3rd consecutive → stop
  });

  it('only CONSECUTIVE failures stop a target — a clean cycle resets the streak', async () => {
    const store = new Store(dir);
    let kind: RegisterOutcome['kind'] = 'error';
    const watcher: Watcher = {
      checkCourse: async () => ({ stats: stats(), decision: { action: 'REGISTER', reason: 'rem>0' } }),
    };
    const actor: Actor = {
      act: async () =>
        kind === 'error'
          ? { kind: 'error', crn: '1814', message: 'x' }
          : { kind: 'waitlist-full', crn: '1814' },
    };
    const scheduler = new Scheduler({
      store, budget: new Budget(store), watcher, actor,
      session: new FakeSession(true), now: () => NOW, random: () => 0.5,
    });
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '1814', mode: 'auto' });

    await scheduler.runOnce(t.id); // fail 1
    await scheduler.runOnce(t.id); // fail 2
    kind = 'waitlist-full';
    await scheduler.runOnce(t.id); // clean cycle → streak reset
    expect(store.getTarget(t.id)!.status).toBe('watching');
    kind = 'error';
    await scheduler.runOnce(t.id); // fail 1 (after reset)
    await scheduler.runOnce(t.id); // fail 2
    expect(store.getTarget(t.id)!.status).toBe('watching'); // not stopped — needs 3 in a row
  });

  it('rescheduleWatching recomputes nextPollAt for watching targets only', () => {
    const { store, scheduler, target } = setup({ decision: { action: 'NOOP', reason: 'x' } });
    const paused = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '2222', mode: 'auto' });
    const STALE = NOW + 9_000_000; // far-future, as if scheduled under an old long interval
    store.updateTarget(target.id, { nextPollAt: STALE });
    store.updateTarget(paused.id, { status: 'paused', nextPollAt: STALE });

    scheduler.rescheduleWatching();

    const watched = store.getTarget(target.id)!;
    expect(watched.nextPollAt!).toBeGreaterThan(NOW);
    expect(watched.nextPollAt!).toBeLessThan(STALE); // recomputed sooner under the new cadence
    expect(store.getTarget(paused.id)!.nextPollAt).toBe(STALE); // paused → untouched
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
    const [ran1, ran2] = await Promise.all([p1, p2]);
    expect(checkCalls).toBe(1);
    expect(actor.calls).toBe(1);
    // The guard also *reports* the drop now: the accepted call returns true, the
    // skipped one false — what `started:false/reason:'in progress'` is built on
    // (audit Q16/Q60). Before the fix runOnce returned void for both.
    expect(ran1).toBe(true);
    expect(ran2).toBe(false);
    expect(
      store.recentEvents().some((e) => e.message.includes('Run already in progress')),
    ).toBe(true);
  });
});

describe('Scheduler.runTarget (manual "Register now")', () => {
  function manualSetup() {
    const store = new Store(dir);
    const budget = new Budget(store);
    const watcher = new FakeWatcher({ stats: stats(), decision: { action: 'NOOP', reason: 'full' } });
    const actor = new FakeActor({ kind: 'not-found', crn: '1814' });
    let clock = NOW;
    const scheduler = new Scheduler({
      store,
      budget,
      watcher,
      actor,
      session: new FakeSession(true),
      now: () => clock,
      random: () => 0.5,
    });
    const target = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '1814', mode: 'auto' });
    return { store, budget, watcher, scheduler, target, setClock: (t: number) => (clock = t) };
  }

  it('accepts the first manual run and records lastForcedRunAt', async () => {
    const { scheduler, store, watcher, target } = manualSetup();
    // The result carries the *duration* the client anchors its countdown to, plus
    // the start it can echo/debug with — never a value the client must subtract
    // from its own clock.
    expect(scheduler.runTarget(target.id)).toEqual({
      started: true,
      retryAfterMs: MANUAL_RUN_COOLDOWN_MS,
      lastForcedRunAt: NOW,
    });
    expect(store.getTarget(target.id)!.lastForcedRunAt).toBe(NOW);
    await vi.waitFor(() => expect(watcher.calls).toBe(1));
  });

  // Regression (audit Q23): before this, nothing throttled manual runs — each
  // click hit Minerva for real, bounded only by the shared daily query budget.
  it('refuses a second manual run inside the cooldown and reports how long is left', async () => {
    const { scheduler, watcher, target, setClock } = manualSetup();
    scheduler.runTarget(target.id);
    await vi.waitFor(() => expect(watcher.calls).toBe(1));

    setClock(NOW + 20_000); // 20s of the 60s window elapsed
    expect(scheduler.runTarget(target.id)).toEqual({
      started: false,
      reason: 'cooldown',
      retryAfterMs: MANUAL_RUN_COOLDOWN_MS - 20_000,
      lastForcedRunAt: NOW,
    });
    // The refused click did not query Minerva again.
    expect(watcher.calls).toBe(1);
  });

  it('allows a manual run again once the cooldown has elapsed', async () => {
    const { scheduler, watcher, target, setClock } = manualSetup();
    scheduler.runTarget(target.id);
    await vi.waitFor(() => expect(watcher.calls).toBe(1));

    setClock(NOW + MANUAL_RUN_COOLDOWN_MS);
    expect(scheduler.runTarget(target.id)).toEqual({
      started: true,
      retryAfterMs: MANUAL_RUN_COOLDOWN_MS,
      lastForcedRunAt: NOW + MANUAL_RUN_COOLDOWN_MS,
    });
    await vi.waitFor(() => expect(watcher.calls).toBe(2));
  });

  it('does not let the automatic tick loop consume or need the manual cooldown', async () => {
    const { scheduler, store, watcher, target } = manualSetup();
    expect(scheduler.runTarget(target.id).started).toBe(true);
    await vi.waitFor(() => expect(watcher.calls).toBe(1));

    // The cooldown throttles *manual* runs only: a due automatic cycle still runs.
    store.updateTarget(target.id, { nextPollAt: NOW - 1 });
    await scheduler.tick();
    expect(watcher.calls).toBe(2);
  });

  it('reports in progress — not a false start — when a cycle is already running', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', faculty: 'Faculty of Science', courseNumber: '551', targetCrn: '1814', mode: 'auto' });
    let releaseCheck!: () => void;
    const gate = new Promise<void>((r) => (releaseCheck = r));
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher: {
        checkCourse: async () => {
          await gate;
          return { stats: stats(), decision: { action: 'NOOP', reason: 'full' } };
        },
      },
      actor: new FakeActor({ kind: 'not-found', crn: '1814' }),
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    expect(scheduler.runTarget(t.id)).toEqual({
      started: true,
      retryAfterMs: MANUAL_RUN_COOLDOWN_MS,
      lastForcedRunAt: NOW,
    });
    expect(scheduler.runTarget(t.id)).toEqual({
      started: false,
      reason: 'in progress',
      lastForcedRunAt: NOW,
    });
    // `runTarget` short-circuits *before* `runOnce`, so it has to emit the guard's
    // info line itself — otherwise a dropped manual click would leave no trace at
    // all (review finding: the first version relied on `runOnce`, which this
    // branch never reaches).
    expect(
      store.recentEvents().filter((e) => e.message.includes('Run already in progress')),
    ).toHaveLength(1);
    releaseCheck();
  });

  it('refuses a non-watching target with its real status', () => {
    const { scheduler, store, target } = manualSetup();
    store.updateTarget(target.id, { status: 'paused' });
    expect(scheduler.runTarget(target.id)).toEqual({ started: false, reason: 'target is paused' });
  });

  it('refuses an unknown target instead of pretending to start', () => {
    const { scheduler } = manualSetup();
    expect(scheduler.runTarget('no-such-id')).toEqual({ started: false, reason: 'target not found' });
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
