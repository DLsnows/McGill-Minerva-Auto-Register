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
 * Orchestrates a single watch cycle per target: session check → query → decide
 * → auto-act or notify → update state → schedule next (jittered, budget-aware).
 * Pure orchestration; the real timer loop (`start`/`stop`) is a thin wrapper.
 */
export class Scheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  private log(level: LogLevel, message: string, targetId?: string, data?: unknown): void {
    const ev = this.deps.store.appendEvent({ level, message, targetId, data });
    this.deps.onEvent?.(ev);
  }

  /** Run a single cycle for one target. */
  async runOnce(targetId: string): Promise<void> {
    const { store, budget } = this.deps;
    const target = store.getTarget(targetId);
    if (!target || target.status !== 'watching') return;
    const now = this.now();

    if (!budget.canQuery(now)) {
      this.log('warn', 'Daily query budget reached — backing off until tomorrow', targetId);
      this.scheduleAfterReset(target, now);
      return;
    }

    if (!(await this.deps.session.isLoggedIn())) {
      store.updateTarget(targetId, { status: 'paused' });
      this.log('warn', 'Session not active (logged out / evicted) — paused; please re-login', targetId);
      return;
    }

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
      this.log('error', `Query failed: ${errMsg(e)}`, targetId);
      this.scheduleNext(target);
      return;
    }
    budget.recordQuery(now);

    if (!check) {
      this.log('warn', `Target CRN ${target.targetCrn} not found in results`, targetId);
      this.scheduleNext(target);
      return;
    }
    store.updateTarget(targetId, { lastStats: check.stats, lastPolledAt: now });

    const { action } = check.decision;
    if (action === 'NOOP') {
      this.log('info', `No opening — ${check.decision.reason}`, targetId);
      this.scheduleNext(target);
      return;
    }

    this.log('action', `Opening found (${action}) — ${check.decision.reason}`, targetId, {
      stats: check.stats,
      decision: check.decision,
    });

    if (target.mode === 'notify') {
      this.log('ok', `Notify-only: ${action} available — awaiting your go.`, targetId, { action });
      this.scheduleNext(target);
      return;
    }

    // auto mode → act
    if (!budget.canRegister(now)) {
      this.log('warn', 'Daily register budget reached — will retry next cycle', targetId);
      this.scheduleNext(target);
      return;
    }

    let outcome: RegisterOutcome;
    try {
      outcome = await this.deps.actor.act(target.term, target.targetCrn, action);
    } catch (e) {
      budget.recordRegister(now);
      this.log('error', `Registration attempt threw: ${errMsg(e)}`, targetId);
      this.scheduleNext(target);
      return;
    }
    budget.recordRegister(now);

    this.applyOutcome(target, outcome);
  }

  private applyOutcome(target: WatchTarget, outcome: RegisterOutcome): void {
    const label = target.label ?? target.targetCrn;
    switch (outcome.kind) {
      case 'registered':
        this.deps.store.updateTarget(target.id, { status: 'registered' });
        this.log('ok', `Registered ${label}! 🎉`, target.id, outcome);
        return; // stop watching
      case 'waitlisted':
        this.deps.store.updateTarget(target.id, { status: 'waitlisted' });
        this.log('ok', `Joined waitlist for ${label}.`, target.id, outcome);
        return; // stop watching
      case 'waitlist-full':
      case 'closed':
      case 'not-found':
        this.log('info', `No action taken (${outcome.kind})`, target.id, outcome);
        this.scheduleNext(target);
        return;
      case 'waitlist-available':
        this.log('warn', 'Open-space reserved for waitlist; will reassess next cycle', target.id, outcome);
        this.scheduleNext(target);
        return;
      case 'error':
      default:
        this.log('error', `Registration error: ${outcome.message ?? 'unknown'}`, target.id, outcome);
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
      baseMin = Math.max(baseMin * 3, 60); // at least hourly, 3× the query-based interval
    }
    const jitter = (this.random() * 2 - 1) * s.jitterMinutes;
    const nextMin = Math.max(1, baseMin + jitter);
    store.updateTarget(target.id, { nextPollAt: now + nextMin * 60_000 });
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
      void this.tick().finally(() => {
        this.ticking = false;
      });
    }, tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run a cycle for every watching target whose nextPollAt is due. Sequential. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.deps.store
      .listTargets()
      .filter((t) => t.status === 'watching' && (t.nextPollAt ?? 0) <= now);
    for (const t of due) {
      await this.runOnce(t.id);
    }
  }
}
