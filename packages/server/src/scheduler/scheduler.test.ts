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
import { Scheduler, type Actor, type SessionGuard, type Watcher } from './scheduler';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-sched-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-06-02T12:00:00').getTime();

/** Let every already-settled promise's rejection handler run. An unhandled
 * rejection is only reported at the end of a microtask checkpoint, so a test that
 * asserts "nothing escaped" has to yield first. */
const tickMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '9999',
      mode: 'auto',
    });

    // First misses log an error but keep watching (absorbs a transient blip).
    await scheduler.runOnce(t.id);
    await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('watching');

    // The third consecutive miss hits the limit → error + stop watching.
    await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('error');
    expect(watcher.calls).toBe(3);
    expect(
      store
        .recentEvents()
        .some((e) => e.level === 'error' && /not found in search results/i.test(e.message)),
    ).toBe(true);

    // Now stopped: a further run does not query again.
    await scheduler.runOnce(t.id);
    expect(watcher.calls).toBe(3);
  });

  it('stopping one unfindable target leaves the other targets polling', async () => {
    const store = new Store(dir);
    const good = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });
    const bad = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '9999',
      mode: 'notify',
    });
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
      checkCourse: async () => ({
        stats: stats(),
        decision: { action: 'REGISTER', reason: 'rem>0' },
      }),
    };
    const actor: Actor = {
      act: async () =>
        kind === 'error'
          ? { kind: 'error', crn: '1814', message: 'x' }
          : { kind: 'waitlist-full', crn: '1814' },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor,
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });

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
    const paused = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2222',
      mode: 'auto',
    });
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
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });
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

/** Build a two-target scheduler whose first target throws from `checkCourse`.
 * Everything that runs inside an unhandled-rejection-sensitive context needs this. */
function setupThrowingRound(reason: 'query-throws' | 'session-throws') {
  const store = new Store(dir);
  const budget = new Budget(store);
  const ok = store.addTarget({
    term: '202701',
    subject: 'COMP',
    faculty: 'Faculty of Science',
    courseNumber: '551',
    targetCrn: '1814',
    mode: 'auto',
  });
  const bad = store.addTarget({
    term: '202701',
    subject: 'COMP',
    faculty: 'Faculty of Science',
    courseNumber: '551',
    targetCrn: '9999',
    mode: 'auto',
  });
  let okCalls = 0;
  const watcher: Watcher = {
    checkCourse: async (q) => {
      if (q.targetCrn === '9999')
        throw new Error(reason === 'query-throws' ? 'watcher exploded' : 'x');
      okCalls++;
      return { stats: stats(), decision: { action: 'NOOP', reason: 'full' } };
    },
  };
  const session: SessionGuard = {
    isLoggedIn: async () => {
      if (reason === 'session-throws')
        throw new Error('SessionManager not launched — call launch() first');
      return true;
    },
  };
  const actor = new FakeActor({ kind: 'registered', crn: '1814' });
  const scheduler = new Scheduler({
    store,
    budget,
    watcher,
    actor,
    session,
    now: () => NOW,
    random: () => 0.5,
  });
  return { store, scheduler, actor, ok, bad, okCalls: () => okCalls };
}

describe('Scheduler.tick — process resilience (Q1)', () => {
  it('never rejects when one target throws, and still polls the other due target', async () => {
    const { store, scheduler, actor, ok, bad, okCalls } = setupThrowingRound('query-throws');
    // Make `bad` the only target that is due (listTargets order is insertion order,
    // so it is also the *first* one the round touches — proving the throw does not
    // starve what comes after it).
    store.updateTarget(bad.id, { nextPollAt: NOW });
    store.updateTarget(ok.id, { nextPollAt: NOW });

    // A rejection escaping tick() is exactly the pre-fix defect: the timer callback's
    // `void this.tick().finally(...)` left it unhandled, and Node ≥22 exits the process.
    const escaped: unknown[] = [];
    const onUnhandled = (r: unknown) => escaped.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      await scheduler.tick();
      await tickMicrotasks();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(escaped).toEqual([]); // nothing escaped the round
    expect(okCalls()).toBe(1); // the healthy target was still polled
    expect(actor.calls).toBe(0); // and the thrower did not register anything
    expect(
      store.recentEvents().some((e) => e.level === 'error' && /watcher exploded/.test(e.message)),
    ).toBe(true);
  });

  it('keeps the process alive through the real timer callback when a target rejects', async () => {
    // Only the interval is faked: the round itself is driven by real awaits, and
    // faking setTimeout too would also freeze the microtask checkpoint below.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { store, scheduler, bad, ok, okCalls } = setupThrowingRound('query-throws');
    store.updateTarget(bad.id, { nextPollAt: NOW });
    store.updateTarget(ok.id, { nextPollAt: NOW });

    const escaped: unknown[] = [];
    const onUnhandled = (r: unknown) => escaped.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      scheduler.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await tickMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
      await tickMicrotasks();

      // Pre-fix this is where Node would have had an unhandled rejection from the
      // interval callback (and, in production, exited with code 1).
      expect(escaped).toEqual([]);
      expect(scheduler.isRunning()).toBe(true); // the loop survived
      expect(okCalls()).toBeGreaterThanOrEqual(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('treats a throwing isLoggedIn() as "session unavailable" instead of crashing', async () => {
    const store = new Store(dir);
    const watcher = new FakeWatcher({ stats: stats(), decision: { action: 'NOOP', reason: 'x' } });
    const session: SessionGuard = {
      // The documented real-world trigger: the user closes the automation's Chromium
      // window, so the next probe throws instead of resolving false.
      isLoggedIn: async () => {
        throw new Error('SessionManager not launched — call launch() first');
      },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: new FakeActor({ kind: 'registered', crn: '1814' }),
      session,
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });

    await expect(scheduler.runOnce(t.id)).resolves.toBeUndefined();

    expect(store.getTarget(t.id)!.status).toBe('paused'); // same path as logged-out
    expect(watcher.calls).toBe(0); // never reached the query
    expect(
      store
        .recentEvents()
        .some((e) => e.level === 'warn' && /Session check failed/.test(e.message)),
    ).toBe(true);
  });

  it('logs to stderr instead of throwing when the store cannot persist a cycle error', async () => {
    const { store, scheduler, bad, ok } = setupThrowingRound('query-throws');
    store.updateTarget(bad.id, { nextPollAt: NOW });
    store.updateTarget(ok.id, { nextPollAt: NOW });
    // A full disk / AV lock makes appendEvent throw. The error path itself must not
    // become a second, fatal failure (the pre-fix code let it bubble out of tick()).
    const spy = vi.spyOn(store, 'appendEvent').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('Scheduler cancels in-flight cycles on stop/pause (Q9/Q14)', () => {
  /** A scheduler whose `checkCourse` blocks until `release()` is called, so the
   * test can mutate state at the exact moment a real cycle would be navigating. */
  function blockingScheduler() {
    const store = new Store(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredGate = new Promise<void>((r) => (entered = r));
    const watcher: Watcher = {
      checkCourse: async () => {
        entered();
        await gate;
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
    const target = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });
    return { store, scheduler, actor, target, release, entered: enteredGate };
  }

  it('does not submit a registration when the target is paused mid-cycle', async () => {
    const { store, scheduler, actor, target, release, entered } = blockingScheduler();
    const cycle = scheduler.runOnce(target.id);
    await entered; // the cycle is now past its entry status check
    store.updateTarget(target.id, { status: 'paused' }); // the user hits Pause
    release();
    await cycle;

    expect(actor.calls).toBe(0); // the pre-fix code registered here
    expect(store.getTarget(target.id)!.status).toBe('paused'); // not overwritten with 'registered'
    expect(store.recentEvents().some((e) => /cancelled in flight/.test(e.message))).toBe(true);
  });

  it('does not submit a registration when the scheduler is stopped mid-cycle (Stop all)', async () => {
    const { store, scheduler, actor, target, release, entered } = blockingScheduler();
    scheduler.start(); // Stop all goes through stop(); mirror that
    const cycle = scheduler.runOnce(target.id);
    await entered;
    store.updateTarget(target.id, { status: 'paused' }); // stop-all pauses first…
    scheduler.stop(); // …then stops the engine
    release();
    await cycle;

    expect(actor.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('paused');
    expect(store.recentEvents().some((e) => /scheduler was stopped/.test(e.message))).toBe(true);
  });

  it('still runs a forced (one-click) cycle when nothing cancelled it', async () => {
    // Guards the fix against over-reach: the cancel checks must not block a
    // legitimate run.
    const { store, scheduler, actor, target, release, entered } = blockingScheduler();
    const cycle = scheduler.runOnce(target.id, { force: true });
    await entered;
    release();
    await cycle;
    expect(actor.calls).toBe(1);
    expect(store.getTarget(target.id)!.status).toBe('registered');
  });

  // Review finding (pr-agent): the generation was captured per *target*, so a round
  // with several due targets only cancelled the one that was already running — the
  // not-yet-started ones captured the post-stop generation and ran a full cycle,
  // including a submission, after Stop returned.
  it('a stop during target A also cancels target B later in the same round', async () => {
    const store = new Store(dir);
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let enteredA!: () => void;
    const enteredGateA = new Promise<void>((r) => (enteredA = r));
    const queried: string[] = [];
    const watcher: Watcher = {
      checkCourse: async (q) => {
        if (q.targetCrn === '1111') {
          enteredA();
          await gateA;
        }
        queried.push(q.targetCrn);
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
    const a = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1111',
      mode: 'auto',
    });
    const b = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '2222',
      mode: 'auto',
    });
    store.updateTarget(a.id, { nextPollAt: NOW });
    store.updateTarget(b.id, { nextPollAt: NOW });

    scheduler.start(); // Stop all goes through stop(); mirror that
    const round = scheduler.tick();
    await enteredGateA; // A is mid-cycle
    scheduler.stop(); // …the user presses Stop
    releaseA();
    await round;

    expect(queried).toEqual(['1111']); // B was never queried
    expect(actor.calls).toBe(0); // and nothing was submitted for either target
    expect(store.getTarget(b.id)!.status).toBe('watching'); // untouched, not 'registered'
  });

  // Review finding (Claude + pr-agent): a cancel check placed *after* act() can only
  // suppress the recording of a registration that already happened.
  it('records the outcome when a stop lands while act() is in flight', async () => {
    const store = new Store(dir);
    let releaseAct!: () => void;
    const gate = new Promise<void>((r) => (releaseAct = r));
    let enteredAct!: () => void;
    const enteredGate = new Promise<void>((r) => (enteredAct = r));
    const actor: Actor = {
      act: async () => {
        enteredAct();
        await gate;
        return { kind: 'registered', crn: '1814' }; // the submission really happened
      },
    };
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher: {
        checkCourse: async () => ({
          stats: stats(),
          decision: { action: 'REGISTER', reason: 'rem>0' },
        }),
      },
      actor,
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });

    scheduler.start();
    const cycle = scheduler.runOnce(t.id);
    await enteredGate;
    scheduler.stop(); // stop lands mid-submission
    releaseAct();
    await cycle;

    // A stop that lands mid-submission must not throw the outcome away: the registration
    // already happened, so the user has to be told. It must equally not restart anything —
    // `stop()` leaves the target's status alone (it is the *engine* that stopped), so it
    // stays 'watching' while the engine is down, and no follow-up poll is scheduled.
    expect(store.getTarget(t.id)!.status).toBe('watching');
    expect(store.recentEvents().some((e) => /Registered/.test(e.message))).toBe(true);
    expect(store.getTarget(t.id)!.nextPollAt).toBeUndefined();
    expect(store.recentEvents().some((e) => /No registration was submitted/.test(e.message))).toBe(
      false,
    );
  });

  // Review finding (Claude): the cancel token was only honoured on the happy path.
  it('a cancelled cycle cannot overwrite a pause through the failure breaker', async () => {
    const store = new Store(dir);
    let releaseCheck!: () => void;
    const gate = new Promise<void>((r) => (releaseCheck = r));
    let entered!: () => void;
    const enteredGate = new Promise<void>((r) => (entered = r));
    // `entered` is all this test awaits (not the promise), but binding it keeps the
    // resolver referenced until the watcher calls it.
    void enteredGate;
    let checkCalls = 0;
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher: {
        checkCourse: async () => {
          checkCalls += 1;
          // Let this test drive the failing check instead of the runOnce calls that
          // bank the first two failures below — `gate` is a one-shot promise.
          if (checkCalls > 2) {
            entered();
            await gate;
          }
          throw new Error('query exploded'); // the failure branch
        },
      },
      actor: new FakeActor({ kind: 'registered', crn: '1814' }),
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });

    // Two failures already banked, so the next one would be the third → 'error'.
    // `runOnce` does not reject here: the query-throw branch is handled inside the cycle
    // (that is the Q1 fix — an exception must never escape and kill the process), so the
    // observable signal is the recorded streak, not a rejection.
    for (let i = 0; i < 2; i++) {
      await scheduler.runOnce(t.id);
    }
    expect(store.getTarget(t.id)!.status).toBe('watching');
    expect(store.recentEvents().filter((e) => /Query failed/.test(e.message))).toHaveLength(2);

    scheduler.start();
    const cycle = scheduler.runOnce(t.id);
    await entered;
    store.updateTarget(t.id, { status: 'paused' }); // the user hits Pause
    scheduler.stop();
    releaseCheck();
    await cycle;

    // The pre-fix failure branch called noteFailure unconditionally, so the third
    // strike overwrote the user's 'paused' with 'error' — the same silent status
    // overwrite Q9 is about, reached through an error path instead of a submission.
    expect(store.getTarget(t.id)!.status).toBe('paused');
  });
});

describe('Scheduler recovery helpers (Q3)', () => {
  it('clearFailures + scheduleNow put an errored target back to work immediately', async () => {
    const store = new Store(dir);
    const watcher = new FakeWatcher(null); // CRN never found → the breaker trips
    const scheduler = new Scheduler({
      store,
      budget: new Budget(store),
      watcher,
      actor: new FakeActor({ kind: 'registered', crn: '1814' }),
      session: new FakeSession(true),
      now: () => NOW,
      random: () => 0.5,
    });
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '9999',
      mode: 'auto',
    });
    for (let i = 0; i < 3; i++) await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('error');

    // The user clicks Resume: the route PATCHes status, clears the streak and makes
    // the target due. Without clearFailures the very next blip parks it straight
    // back in 'error' — 1 failure looking like 3.
    store.updateTarget(t.id, { status: 'watching' });
    store.updateTarget(t.id, { nextPollAt: NOW + 60 * 60 * 1000 }); // stale schedule
    scheduler.clearFailures(t.id);
    scheduler.scheduleNow(t.id);
    expect(store.getTarget(t.id)!.nextPollAt).toBe(NOW); // due on the next tick

    await scheduler.runOnce(t.id);
    expect(store.getTarget(t.id)!.status).toBe('watching'); // failure 1/3, not stopped
    expect(store.recentEvents().some((e) => /failure 1\/3/.test(e.message))).toBe(true);
  });

  it('scheduleNow is a no-op for an unknown target', () => {
    const { scheduler } = setup({ decision: { action: 'NOOP', reason: 'x' } });
    expect(() => scheduler.scheduleNow('nope')).not.toThrow();
  });
});
