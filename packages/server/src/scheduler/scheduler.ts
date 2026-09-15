import type {
  ActionKind,
  CourseQuery,
  Decision,
  LogEvent,
  LogLevel,
  RegisterOutcome,
  SectionStats,
  WatchTarget,
} from '@autoregister/shared';
import type { Budget } from '../budget/budget';
import type { Store } from '../store/store';

export interface Watcher {
  checkCourse(q: CourseQuery): Promise<{ stats: SectionStats; decision: Decision } | null>;
}
export interface Actor {
  act(term: string, crn: string, action: ActionKind): Promise<RegisterOutcome>;
}
export interface SessionGuard {
  isLoggedIn(): Promise<boolean>;
}

export interface SchedulerDeps {
  store: Store;
  budget: Budget;
  watcher: Watcher;
  actor: Actor;
  session: SessionGuard;
  /** Injectable clock/RNG for tests. */
  now?: () => number;
  random?: () => number;
  /** Relay each persisted log event (for desktop/sound/email/WS in P5b/P6). */
  onEvent?: (e: LogEvent) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Why an in-flight cycle refused to continue. `paused` covers both Stop-all and a
 * single card's Pause (both flip the status); `scheduler-stopped` is `stop()` —
 * used by the master toggle and the standalone Stop button.
 */
type CancelReason = 'paused' | 'scheduler-stopped';

/** Passed down a cycle so it can ask "was I cancelled while I was awaiting?". */
interface CycleGuard {
  generation: number;
}

/** Consecutive failed cycles a target may have before we stop watching it. Any
 * error counts: a query/parse exception, the CRN missing from the results, a
 * registration exception, or a registration error outcome. After this many
 * consecutive failures something is persistently wrong (bad CRN / course
 * details, an eligibility restriction, a Minerva change…) and retrying only
 * burns the daily budget. A small streak (not 1) absorbs a transient blip; any
 * clean cycle resets it. */
const FAILURE_LIMIT = 3;

/**
 * Orchestrates a single watch cycle per target: session check → query → decide
 * → auto-act or notify → update state → schedule next (jittered, budget-aware).
 * Pure orchestration; the real timer loop (`start`/`stop`) is a thin wrapper.
 */
export class Scheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Targets with a runOnce currently executing — prevents the tick loop and a
   * manual `runTarget` (or two manual runs) from double-acting the same course. */
  private readonly inFlight = new Set<string>();
  /** Per-target count of consecutive failed cycles (any error kind). */
  private readonly failureStreak = new Map<string, number>();
  /**
   * Bumped by `stop()`. A cycle captures the value when it starts and aborts as
   * soon as it changes, so "Stop all"/Stop cancels *in-flight* work instead of
   * only clearing the interval (Q9/Q14). Without this, a cycle that had already
   * passed the status check would keep going for up to a minute — past several
   * `humanPause()`s and a real Minerva navigation — and still submit a
   * registration the user had just cancelled.
   */
  private generation = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /** Append a log event AND surface it. Never throws: the scheduler's whole job
   * is to keep running, and a store that cannot persist (disk full, AV lock —
   * see `Store.save`) must not take the process down with it. Falling back to
   * stderr keeps the event visible even when the event log itself is broken. */
  private log(level: LogLevel, message: string, targetId?: string, data?: unknown): void {
    let ev: LogEvent;
    try {
      ev = this.deps.store.appendEvent({ level, message, targetId, data });
    } catch (e) {
      console.error(`[scheduler] ${level}: ${message} (event log unavailable: ${errMsg(e)})`);
      return;
    }
    try {
      this.deps.onEvent?.(ev);
    } catch (e) {
      console.error(`[scheduler] event relay failed: ${errMsg(e)}`);
    }
  }

  /** True once this cycle's generation is stale (i.e. `stop()` ran). */
  private isCanceled(guard: CycleGuard): boolean {
    return guard.generation !== this.generation;
  }

  /** Say why a cycle stopped short, and drop its pending poll time so a later
   * Resume doesn't inherit a schedule from the run that was just cancelled. */
  private abortCycle(target: WatchTarget, reason: CancelReason): void {
    this.deps.store.updateTarget(target.id, { nextPollAt: undefined });
    if (reason === 'paused') {
      this.log(
        'info',
        `Cycle cancelled in flight — target is no longer 'watching' (paused / stopped from the UI). No registration was submitted.`,
        target.id,
      );
    } else {
      this.log(
        'warn',
        `Cycle cancelled in flight — the scheduler was stopped. No registration was submitted.`,
        target.id,
      );
    }
  }

  /** Forget a target's consecutive-failure streak. Called when the user supplies
   * new input (resume after `error`, editing the query fields), so the first
   * genuine blip after an explicit retry doesn't trip the breaker immediately. */
  clearFailures(targetId: string): void {
    this.failureStreak.delete(targetId);
  }

  /** Make a target due on the very next tick, instead of waiting for whatever
   * `nextPollAt` a previous cycle wrote (which can be hours away after a budget
   * back-off). Used by the resume / edit-recovery paths so "Resume" actually
   * means "poll again soon" rather than "poll at some point". */
  scheduleNow(targetId: string): void {
    if (this.deps.store.getTarget(targetId)) {
      this.deps.store.updateTarget(targetId, { nextPollAt: this.now() });
    }
  }

  /** Run a single cycle for one target. With `{ force: true }` the auto/notify
   * mode gate is bypassed (notify-mode courses still act on an opening) — used
   * by the one-click "Register now" path. Budgets + session checks still apply.
   * A per-target in-flight guard prevents concurrent runs of the same target.
   * Rejects only for errors the caller should surface (a watcher/actor exception
   * is handled inside the cycle); `tick()` wraps each call so one target's
   * failure can never starve the rest of the round. */
  async runOnce(targetId: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.inFlight.has(targetId)) {
      this.log(
        'info',
        'Run already in progress for this target — skipping concurrent run',
        targetId,
      );
      return;
    }
    this.inFlight.add(targetId);
    try {
      await this.runCycle(targetId, { ...opts, guard: { generation: this.generation } });
    } finally {
      this.inFlight.delete(targetId);
    }
  }

  private async runCycle(
    targetId: string,
    opts: { force?: boolean; guard: CycleGuard },
  ): Promise<void> {
    const { store, budget } = this.deps;
    const guard = opts.guard;
    const target = store.getTarget(targetId);
    if (!target || target.status !== 'watching') return;
    const now = this.now();

    if (!budget.canQuery(now)) {
      this.log('warn', 'Daily query budget reached — backing off until tomorrow', targetId);
      this.scheduleAfterReset(target, now);
      return;
    }

    // Session probe. This is the *only* awaited call before the query that had
    // no protection, and the real-world trigger is mundane: the user closes the
    // automation's Chromium window, `getPage()` then throws
    // ("SessionManager not launched", or Target-closed while it is closing).
    // Treat any throw as "session unavailable" — the same outcome as a `false`
    // return — instead of letting it escape and kill the whole process.
    let loggedIn: boolean;
    try {
      loggedIn = await this.deps.session.isLoggedIn();
    } catch (e) {
      store.updateTarget(targetId, { status: 'paused' });
      this.log('warn', `Session check failed (${errMsg(e)}) — paused; please re-login`, targetId);
      return;
    }
    if (!loggedIn) {
      store.updateTarget(targetId, { status: 'paused' });
      this.log(
        'warn',
        'Session not active (logged out / evicted) — paused; please re-login',
        targetId,
      );
      return;
    }
    if (this.isCanceled(guard)) return this.abortCycle(target, 'scheduler-stopped');

    const query: CourseQuery = {
      term: target.term,
      subject: target.subject,
      courseNumber: target.courseNumber,
      faculty: target.faculty,
      targetCrn: target.targetCrn,
    };

    let check: Awaited<ReturnType<Watcher['checkCourse']>>;
    try {
      check = await this.deps.watcher.checkCourse(query);
    } catch (e) {
      budget.recordQuery(now);
      if (this.noteFailure(target, `Query failed: ${errMsg(e)}`)) return;
      this.scheduleNext(target);
      return;
    }
    budget.recordQuery(now);
    if (this.isCanceled(guard)) return this.abortCycle(target, 'scheduler-stopped');

    if (!check) {
      // The query ran but the target CRN isn't among this course's sections.
      // (A real network/parse failure throws above and is handled there.)
      const where = `${target.subject} ${target.courseNumber} (${target.term})`;
      const msg = `CRN ${target.targetCrn} not found in search results for ${where} — check the CRN, term, subject, course number and faculty`;
      if (this.noteFailure(target, msg)) return;
      this.scheduleNext(target);
      return;
    }
    store.updateTarget(targetId, { lastStats: check.stats, lastPolledAt: now });

    const { action } = check.decision;
    if (action === 'NOOP') {
      this.noteSuccess(targetId);
      this.log('info', `No opening — ${check.decision.reason}`, targetId);
      this.scheduleNext(target);
      return;
    }

    this.log('action', `Opening found (${action}) — ${check.decision.reason}`, targetId, {
      stats: check.stats,
      decision: check.decision,
    });

    if (!opts.force && target.mode === 'notify') {
      this.noteSuccess(targetId);
      this.log('ok', `Notify-only: ${action} available — awaiting your go.`, targetId, { action });
      this.scheduleNext(target);
      return;
    }

    if (store.getSettings().dryRun) {
      this.noteSuccess(targetId);
      this.log(
        'action',
        `DRY-RUN: would ${action} ${target.targetCrn} — ${check.decision.reason}`,
        targetId,
        { stats: check.stats, decision: check.decision },
      );
      this.scheduleNext(target);
      return;
    }

    // auto mode → act
    if (!budget.canRegister(now)) {
      this.noteSuccess(targetId);
      this.log('warn', 'Daily register budget reached — will retry next cycle', targetId);
      this.scheduleNext(target);
      return;
    }

    // Last gate before the irreversible step. The query + decision above took
    // tens of seconds (9 humanPause()s and several navigations), which is ample
    // time for the user to have hit Pause / Stop all. Re-read the status here and
    // honour the cancel token: a submission that the user has already cancelled
    // would otherwise still land — and overwrite their 'paused' back to
    // 'registered', leaving them to drop the course by hand (Q9/Q14).
    const cancelReason = this.cancelReason(targetId, guard);
    if (cancelReason) return this.abortCycle(target, cancelReason);

    let outcome: RegisterOutcome;
    try {
      outcome = await this.deps.actor.act(target.term, target.targetCrn, action);
    } catch (e) {
      budget.recordRegister(now);
      if (this.noteFailure(target, `Registration attempt threw: ${errMsg(e)}`)) return;
      this.scheduleNext(target);
      return;
    }
    budget.recordRegister(now);
    if (this.isCanceled(guard)) return this.abortCycle(target, 'scheduler-stopped');

    this.applyOutcome(target, outcome);
  }

  /** Why the current cycle must not continue, or undefined if it may. Reads the
   * target's status fresh: the status captured at cycle start is stale by now,
   * because the query/decision phase above takes tens of seconds during which
   * the user can pause this course (Q9). `stop()` bumps the generation, which
   * covers the master "Stop all"/Stop path (Q14). */
  private cancelReason(targetId: string, guard: CycleGuard): CancelReason | undefined {
    if (guard.generation !== this.generation) return 'scheduler-stopped';
    if (this.deps.store.getTarget(targetId)?.status !== 'watching') return 'paused';
    return undefined;
  }

  /** Record a failed cycle for one target and log `message` at error level (with
   * the running failure count). Returns true if this was the FAILURE_LIMIT-th
   * consecutive failure — the target is then set to 'error' and the caller must
   * NOT reschedule it (only this one target stops; others keep polling). */
  private noteFailure(target: WatchTarget, message: string, data?: unknown): boolean {
    const streak = (this.failureStreak.get(target.id) ?? 0) + 1;
    if (streak >= FAILURE_LIMIT) {
      this.failureStreak.delete(target.id);
      this.deps.store.updateTarget(target.id, { status: 'error' });
      this.log(
        'error',
        `${message} — stopped watching after ${streak} consecutive failures.`,
        target.id,
        data,
      );
      return true;
    }
    this.failureStreak.set(target.id, streak);
    this.log(
      'error',
      `${message} (failure ${streak}/${FAILURE_LIMIT}) — will retry.`,
      target.id,
      data,
    );
    return false;
  }

  /** Clear a target's consecutive-failure streak after a clean cycle. */
  private noteSuccess(targetId: string): void {
    this.failureStreak.delete(targetId);
  }

  /** Trigger an immediate forced run for one target (one-click "Register now").
   * Fire-and-forget; results surface via the event stream like a normal tick. */
  runTarget(id: string): void {
    void this.runOnce(id, { force: true }).catch((e) =>
      this.log('error', `Forced run failed: ${errMsg(e)}`, id),
    );
  }
  private applyOutcome(target: WatchTarget, outcome: RegisterOutcome): void {
    const label = target.label ?? target.targetCrn;
    switch (outcome.kind) {
      case 'registered':
        this.noteSuccess(target.id);
        this.deps.store.updateTarget(target.id, { status: 'registered' });
        this.log('ok', `Registered ${label}! 🎉`, target.id, outcome);
        return; // stop watching
      case 'waitlisted':
        this.noteSuccess(target.id);
        this.deps.store.updateTarget(target.id, { status: 'waitlisted' });
        this.log('ok', `Joined waitlist for ${label}.`, target.id, outcome);
        return; // stop watching
      case 'waitlist-full':
      case 'closed':
      case 'not-found':
        this.noteSuccess(target.id);
        this.log('info', `No action taken (${outcome.kind})`, target.id, outcome);
        this.scheduleNext(target);
        return;
      case 'waitlist-available':
        this.noteSuccess(target.id);
        this.log(
          'warn',
          'Open-space reserved for waitlist; will reassess next cycle',
          target.id,
          outcome,
        );
        this.scheduleNext(target);
        return;
      case 'error':
      default:
        if (
          this.noteFailure(target, `Registration error: ${outcome.message ?? 'unknown'}`, outcome)
        )
          return;
        this.scheduleNext(target);
        return;
    }
  }

  /** Compute and persist the next poll time: jittered base interval, stretched
   * so the remaining daily query budget lasts across active targets. */
  scheduleNext(target: WatchTarget): void {
    const { store, budget } = this.deps;
    const s = store.getSettings();
    const now = this.now();
    const activeCount = store.listTargets().filter((t) => t.status === 'watching').length || 1;
    const rem = budget.remaining(now);
    const remainingQuery = rem.query;

    let baseMin = s.pollIntervalMinutes;
    if (remainingQuery > 0) {
      const minutesUntilMidnight = this.msUntilLocalMidnight(now) / 60_000;
      const pollsPerTarget = remainingQuery / activeCount;
      if (pollsPerTarget > 0) {
        baseMin = Math.max(baseMin, minutesUntilMidnight / pollsPerTarget);
      }
    }
    // When register budget is exhausted, stretch the interval (can only notify, not act)
    if (rem.register <= 0 && remainingQuery > 0) {
      baseMin = Math.max(baseMin * 3, 60); // 3× the query interval, floored at 60 min
    }
    const jitter = (this.random() * 2 - 1) * s.jitterMinutes;
    const nextMin = Math.max(1, baseMin + jitter);
    store.updateTarget(target.id, { nextPollAt: now + nextMin * 60_000 });
  }

  /** Recompute the next poll time for every watching target. Called after a
   * settings change (interval / jitter) so the new cadence takes effect
   * immediately instead of only from each target's next cycle. */
  rescheduleWatching(): void {
    for (const t of this.deps.store.listTargets()) {
      if (t.status === 'watching') this.scheduleNext(t);
    }
  }

  /** Schedule the next poll just after the local-midnight daily budget reset. */
  private scheduleAfterReset(target: WatchTarget, now: number): void {
    const buffer = Math.round(this.random() * 5 + 1) * 60_000; // 1–6 min past midnight
    this.deps.store.updateTarget(target.id, {
      nextPollAt: now + this.msUntilLocalMidnight(now) + buffer,
    });
  }

  private msUntilLocalMidnight(now: number): number {
    const d = new Date(now);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return midnight - now;
  }

  /** Thin timer loop: every `tickMs`, run cycles for due watching targets. */
  start(tickMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // skip if the previous tick is still running
      this.ticking = true;
      void this.tick()
        // `.finally()` alone does not consume a rejection — the derived promise
        // stayed unhandled, and Node ≥22 turns an unhandled rejection into a
        // process exit (exit code 1). One target erroring used to take the API,
        // the WebSocket and all polling down together, with the UI stuck on
        // "reconnecting…". `tick()` already isolates each target; this is the
        // last-resort net so nothing can escape the timer callback.
        .catch((e) => {
          this.log('error', `Scheduler tick failed: ${errMsg(e)}`);
        })
        .finally(() => {
          this.ticking = false;
        });
    }, tickMs);
  }

  /** Stop the loop AND cancel every in-flight cycle (Q9/Q14). `clearInterval`
   * alone left a cycle that had already started running for up to a minute —
   * through several humanPause()s and a real Minerva navigation — so it could
   * still submit a registration after the user pressed "Stop all". */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Run a cycle for every watching target whose nextPollAt is due. Sequential,
   * and each target is isolated: an unexpected throw from one target's cycle is
   * logged and the round continues. Without that, a single bad target would
   * starve every later target in the same round — and, before the `.catch()`
   * above, would have rejected `tick()` itself. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.deps.store
      .listTargets()
      .filter((t) => t.status === 'watching' && (t.nextPollAt ?? 0) <= now);
    for (const t of due) {
      try {
        await this.runOnce(t.id);
      } catch (e) {
        this.log('error', `Cycle failed for this target: ${errMsg(e)}`, t.id);
      }
    }
  }
}
