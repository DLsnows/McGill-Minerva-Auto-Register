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
  /** Called the moment a cycle finds the session unusable (the `isLoggedIn`
   * check returned false or threw). This is the earliest reliable observation
   * that the session is gone — the API uses it to correct what `GET /api/session`
   * reports, so the UI can't keep showing "Active" over an engine that has
   * stopped polling. */
  onSessionLost?: (reason: string) => void;
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

/** Minimum gap between two manual forced runs of the same target ("⚡ Register
 * now"). Manual runs deliberately skip `nextPollAt`, so without this a user
 * tapping the button in a row would fire a real Minerva query every time — the
 * only other brake is the shared daily query budget. 60s is long enough to stop
 * double-clicks and button-mashing while still letting someone retry after
 * reading the result of the previous cycle. It is deliberately NOT persisted as
 * a setting: the point is a floor on human-triggered pacing, not a knob. */
export const MANUAL_RUN_COOLDOWN_MS = 60_000;

/** What a manual "run this target now" request actually did. Returned all the
 * way to the HTTP layer so the UI can tell "accepted" apart from "dropped"
 * (audit Q16/Q60) — before this existed both cases returned `{started: true}`. */
export interface ForcedRunResult {
  started: boolean;
  /** Why nothing was started. `'in progress'` = a cycle is already running for
   * this target; `'cooldown'` = the manual cooldown has not elapsed;
   * `'target is <status>'` = the target left the watching state. */
  reason?: string;
  /** Milliseconds until the caller may try again: the remaining part of the
   * manual cooldown, so a client can drive its countdown from a *duration*
   * anchored to its own clock. Sent on rejections and (as the full window) on
   * acceptance; `0`/absent means no cooldown applies to this answer. */
  retryAfterMs?: number;
  /** The target's current `lastForcedRunAt` (epoch ms, absent if it never had a
   * forced run). Informational for the client — it lets a freshly-loaded page
   * show that a window is still running without asking again. The countdown uses
   * `retryAfterMs` instead, which does not mix the server's clock with the
   * client's. */
  lastForcedRunAt?: number;
}

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
  /** Set by `stop()`, cleared by `start()`. A running round checks it between targets so
   * a stop mid-round does not start the remaining ones. Kept separate from the timer
   * because a directly-invoked `tick()` has no timer and must still run. */
  private stopRequested = false;
  /** Set after construction by the API process (see `setSessionLostHandler`). */
  private sessionLostHandler: ((reason: string) => void) | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.sessionLostHandler = deps.onSessionLost;
  }

  /** Register (or replace) the "the session is gone" callback after construction.
   * `createRuntime` builds the scheduler long before the HTTP layer exists, so the
   * API process wires this up once it has something to notify. */
  setSessionLostHandler(handler: (reason: string) => void): void {
    this.sessionLostHandler = handler;
  }

  private reportSessionLost(reason: string): void {
    this.sessionLostHandler?.(reason);
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
   * failure can never starve the rest of the round.
   *
   * Returns false when the guard dropped this call (a cycle was already running)
   * so a caller can report the drop instead of pretending it was accepted. The
   * guard itself is intentionally kept: it is what stops a manual run and the
   * tick loop from double-registering the same course. */
  async runOnce(targetId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    if (this.inFlight.has(targetId)) {
      this.log(
        'info',
        'Run already in progress for this target — skipping concurrent run',
        targetId,
      );
      return false;
    }
    this.inFlight.add(targetId);
    try {
      // The `guard` is this branch's cancellation token: the cycle captures the
      // generation it started under and aborts as soon as `stop()` bumps it (Q9/Q14).
      // The base's boolean return is kept alongside it.
      await this.runCycle(targetId, { ...opts, guard: { generation: this.generation } });
      return true;
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

    // A throwing session probe counts as "cannot poll" (the same pause path as a
    // false answer) — but it must not silently look like a deliberate logout, so
    // the reason carries the error. This is also where the API learns the session
    // is gone, before any UI ever asks.
    let loggedIn = false;
    let sessionError: string | undefined;
    try {
      loggedIn = await this.deps.session.isLoggedIn();
    } catch (e) {
      sessionError = errMsg(e);
    }
    if (!loggedIn) {
      this.reportSessionLost(sessionError ?? 'session check returned not-logged-in');
      store.updateTarget(targetId, { status: 'paused' });
      this.log(
        'warn',
        sessionError
          ? `Session check failed (${sessionError}) — paused; please re-login`
          : 'Session not active (logged out / evicted) — paused; please re-login',
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
      // The user may have paused/stopped while the query was in flight. The failure
      // bookkeeping below writes state (a poll time, and `error` on the third strike), so
      // it must not run against a target the user has just parked — that is the same
      // silent status-overwrite this change exists to remove, on the error path.
      const aborted = this.cancelReason(targetId, guard);
      if (aborted) return this.abortCycle(target, aborted);
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
      // Same reasoning as the query-throw branch: do not write state onto a target the
      // user paused mid-cycle.
      const aborted = this.cancelReason(targetId, guard);
      if (aborted) return this.abortCycle(target, aborted);
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
      // The attempt reached Minerva and then threw, so a submission may well have landed
      // even though no outcome came back. If the user paused/stopped during it, do not
      // run the failure bookkeeping (`noteFailure` writes `error` on the third strike and
      // `scheduleNext` writes a poll time onto a target they just parked) and do not
      // claim "no registration was submitted" — we cannot know that here.
      const abortedAfterAct = this.cancelReason(targetId, guard);
      if (abortedAfterAct) {
        this.deps.store.updateTarget(targetId, { nextPollAt: undefined });
        this.log(
          'warn',
          `Cycle cancelled in flight after the registration attempt threw — check your Minerva schedule, the submission may or may not have landed. ${
            abortedAfterAct === 'paused'
              ? "The course is left paused as you set it."
              : 'The scheduler was stopped.'
          }`,
          targetId,
        );
        return;
      }
      if (this.noteFailure(target, `Registration attempt threw: ${errMsg(e)}`)) return;
      this.scheduleNext(target);
      return;
    }
    budget.recordRegister(now);

    // Deliberately NOT cancelled here when `outcome` reports an actual enrolment.
    // `act()` has already returned, so the submission happened — Minerva processed it
    // and the user *is* registered or waitlisted. Dropping the outcome would throw away
    // a fact: the store would keep the target `paused`, the budget would have been spent
    // on a registration nobody records, and the stale card would invite a duplicate
    // attempt on Resume. The gate above (`cancelReason`) genuinely prevents a
    // submission; a gate here could only suppress *recording* one. `applyOutcome`
    // honours the pause by not touching the status itself.
    // `cancelReason` rather than `isCanceled`: the latter only covers the scheduler being
    // stopped, while pausing *this* course during the submission is the more likely
    // interaction and would otherwise be overwritten by `applyOutcome`.
    const postActCancel = this.cancelReason(targetId, guard);
    if (postActCancel && outcome.kind !== 'registered' && outcome.kind !== 'waitlisted') {
      return this.abortCycle(target, postActCancel);
    }

    this.applyOutcome(target, outcome, { respectPause: postActCancel !== undefined });
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
   * Fire-and-forget; results surface via the event stream like a normal tick.
   * Returns what happened so the HTTP layer can answer honestly: a request that
   * was dropped by the in-flight guard or blocked by the manual cooldown is
   * reported as `started: false` instead of the blanket `started: true` the API
   * used to return (audit Q16/Q23/Q60). */
  runTarget(id: string): ForcedRunResult {
    const target = this.deps.store.getTarget(id);
    // The window's authority is the stored value; the client renders its
    // countdown from this rather than from its own clock.
    const lastForcedRunAt = target?.lastForcedRunAt;
    // Re-read the status here (not only in the route): a target can be paused
    // between the check and this call, and claiming "in progress" for a paused
    // course would be exactly the kind of dishonest answer this fix removes.
    if (!target) return { started: false, reason: 'target not found' };
    if (target.status !== 'watching') {
      return { started: false, reason: `target is ${target.status}`, lastForcedRunAt };
    }

    if (this.inFlight.has(id)) {
      // Logged here, not left to `runOnce`: this branch returns before `runOnce`
      // is ever called, and the guard's info line is the only trace a dropped
      // click leaves. (`runOnce` logs the same message for its own callers.)
      this.log('info', 'Run already in progress for this target — skipping concurrent run', id);
      return { started: false, reason: 'in progress', lastForcedRunAt };
    }

    const now = this.now();
    const remaining = this.manualCooldownRemaining(target, now);
    if (remaining > 0) {
      this.log(
        'info',
        `Manual run ignored — ${Math.ceil(remaining / 1000)}s of the ${MANUAL_RUN_COOLDOWN_MS / 1000}s cooldown between manual runs is left`,
        id,
      );
      return { started: false, reason: 'cooldown', retryAfterMs: remaining, lastForcedRunAt };
    }

    // Start the cooldown when the run is *accepted* (not when it finishes), so
    // mashing the button during a slow cycle cannot queue up back-to-back runs.
    this.deps.store.updateTarget(id, { lastForcedRunAt: now });
    void this.runOnce(id, { force: true }).catch((e) =>
      this.log('error', `Forced run failed: ${errMsg(e)}`, id),
    );
    // `retryAfterMs` is the full window here: a *duration* the client can anchor
    // to its own receive time, so its countdown needs no clock agreement at all.
    return { started: true, retryAfterMs: MANUAL_RUN_COOLDOWN_MS, lastForcedRunAt: now };
  }

  /** Milliseconds left of the manual-run cooldown, 0 when a forced run is allowed. */
  private manualCooldownRemaining(target: WatchTarget, now: number): number {
    if (target.lastForcedRunAt === undefined) return 0;
    const elapsed = now - target.lastForcedRunAt;
    return elapsed >= MANUAL_RUN_COOLDOWN_MS ? 0 : MANUAL_RUN_COOLDOWN_MS - Math.max(0, elapsed);
  }
  /**
   * Record the result of an `act()` that already happened.
   *
   * `respectPause` is set when the user paused/stopped the target *during* the
   * submission. The enrolment is then still reported — it is a fact the user needs to
   * know, and suppressing it is what made "Stop" look like it had also un-registered
   * them — but the target's status is left as the user set it, and no further poll is
   * scheduled.
   */
  private applyOutcome(
    target: WatchTarget,
    outcome: RegisterOutcome,
    opts: { respectPause?: boolean } = {},
  ): void {
    const label = target.label ?? target.targetCrn;
    const paused = opts.respectPause === true;
    const pausedSuffix = ' (you paused this course while the submission was in flight)';
    switch (outcome.kind) {
      case 'registered':
        this.noteSuccess(target.id);
        if (!paused) this.deps.store.updateTarget(target.id, { status: 'registered' });
        this.log('ok', `Registered ${label}! 🎉${paused ? pausedSuffix : ''}`, target.id, outcome);
        return; // stop watching
      case 'waitlisted':
        this.noteSuccess(target.id);
        if (!paused) this.deps.store.updateTarget(target.id, { status: 'waitlisted' });
        this.log('ok', `Joined waitlist for ${label}.${paused ? pausedSuffix : ''}`, target.id, outcome);
        return; // stop watching
      case 'waitlist-full':
      case 'closed':
      case 'not-found':
        this.noteSuccess(target.id);
        this.log('info', `No action taken (${outcome.kind})`, target.id, outcome);
        if (!paused) this.scheduleNext(target);
        return;
      case 'waitlist-available':
        this.noteSuccess(target.id);
        this.log(
          'warn',
          'Open-space reserved for waitlist; will reassess next cycle',
          target.id,
          outcome,
        );
        if (!paused) this.scheduleNext(target);
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
    this.stopRequested = false;
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
    this.stopRequested = true;
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
      // The round is a snapshot taken above, so a `stop()` that lands while an earlier
      // target is mid-cycle would otherwise still have us start every remaining target in
      // it — each of which would run a query and only then notice the cancel token.
      // Checking here stops the round at the point the user asked it to stop, and means a
      // target that was never queried is not marked as polled or scheduled.
      //
      // Deliberately not `isRunning()`: the timer is also absent when `tick()` is invoked
      // directly (tests, and any future manual round), which must keep working.
      if (this.stopRequested) {
        this.log(
          'info',
          'Scheduler stopped mid-round — the remaining due targets are left for the next start.',
        );
        return;
      }
      try {
        // `runOnce` returns false when the in-flight guard dropped this cycle (the
        // manual "Register now" path got there first) and has already logged why.
        // Both outcomes mean "move on to the next target", so the value is not used
        // here — the caller that needs it is the `/run` route, which reports it.
        await this.runOnce(t.id);
      } catch (e) {
        this.log('error', `Cycle failed for this target: ${errMsg(e)}`, t.id);
      }
    }
  }
}
