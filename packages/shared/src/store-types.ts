import type { CourseQuery } from './query';
import type { SectionStats } from './types';

export type WatchMode = 'auto' | 'notify';
export type WatchStatus =
  | 'watching'
  | 'paused'
  | 'registered'
  | 'waitlisted'
  | 'stopped'
  | 'error';

/** A configured course the user wants watched: a query plus policy + live state. */
export interface WatchTarget extends CourseQuery {
  id: string;
  /** Display label, e.g. "COMP 551". */
  label?: string;
  mode: WatchMode;
  status: WatchStatus;
  lastStats?: SectionStats;
  lastPolledAt?: number;
  nextPollAt?: number;
  /** When the user last asked for an immediate forced cycle ("Register now").
   * Manual runs bypass the `nextPollAt` cadence by design, so this is the only
   * throttle on them: the server refuses another forced run until the manual
   * cooldown has elapsed (see MANUAL_RUN_COOLDOWN_MS in the scheduler). Kept on
   * the target rather than in memory so the throttle survives a restart, and so a
   * freshly-loaded client can tell a window is still running. The UI counts down
   * from the `retryAfterMs` duration the API returns, not from this epoch, to
   * stay independent of clock skew. */
  lastForcedRunAt?: number;
  createdAt: number;
}

export type LogLevel = 'info' | 'action' | 'ok' | 'warn' | 'error';

export interface LogEvent {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
  targetId?: string;
  data?: unknown;
}

export interface Settings {
  /** Base poll interval in minutes (default 30). */
  pollIntervalMinutes: number;
  /** +/- jitter in minutes applied to each poll (default 3). */
  jitterMinutes: number;
  /** Base pause between two browser operations *inside* one poll cycle, in
   * milliseconds (default 3000). Distinct from `pollIntervalMinutes`, which
   * decides *how often* a cycle runs — this one decides how fast each click /
   * navigation of a single cycle happens. */
  opPauseMs: number;
  /** Uniform +/- jitter in milliseconds applied to `opPauseMs` (default 1000). */
  opJitterMs: number;
  /** Max queries per day (default 100). */
  queryBudget: number;
  /** Max registration submits per day (default 20). */
  registerBudget: number;
  /** Which notification channels are enabled (in-app log is always on). */
  notify: NotifyChannels;
  /**
   * SMTP config for email notifications (absent/empty = email disabled).
   * Kept for the email feature even though it is temporarily sunset — the UI no
   * longer renders it and the server forces `notify.email` to false (see
   * `packages/server/src/scheduler/runtime.ts`).
   */
  email?: EmailConfig;
  /** Rehearsal mode: poll + decide normally but never actually submit a
   * registration (logs "would register" instead). Default false. */
  dryRun?: boolean;
  /** Windows only: hold the machine awake (sleep disabled) while the app runs.
   * The display still turns off; on a laptop this only applies on AC power.
   * Default false — it changes machine behaviour, so it is opt-in. */
  keepAwake?: boolean;
}

export interface NotifyChannels {
  desktop: boolean;
  sound: boolean;
  email: boolean;
}

/** SMTP settings for email notifications, edited in the UI (stored locally). */
export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
}

export interface DailyOps {
  /** Local date, YYYY-MM-DD. */
  date: string;
  queryCount: number;
  registerCount: number;
}

/** One half of a daily budget, read atomically so the three numbers can never
 * contradict each other:
 * - `used` is clamped to `[0, limit]` — lowering the limit below what has
 *   already been spent reports `used = limit`, never a used-count above it.
 * - `remaining` is therefore always `limit - used` (never negative), so a
 *   consumer that renders `used / limit` can never show a numerator larger
 *   than its denominator. */
export interface BudgetCount {
  used: number;
  limit: number;
  remaining: number;
}

/** A coherent snapshot of both daily budgets, taken from one read of the
 * settings + daily op-counts (see `Budget.snapshot()` on the server). */
export interface BudgetSnapshot {
  query: BudgetCount;
  register: BudgetCount;
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMinutes: 30,
  jitterMinutes: 3,
  opPauseMs: 3000,
  opJitterMs: 1000,
  queryBudget: 100,
  registerBudget: 20,
  notify: { desktop: true, sound: true, email: false },
  dryRun: false,
  keepAwake: false,
};

/**
 * Hard floor for the pause between browser operations, in milliseconds.
 *
 * Anti-detection / respectful-pacing requirement: even a user setting of 0 can
 * never make the automation click flat-out. Enforced twice — rejected by the
 * API schema, and clamped again where the pause is actually applied.
 */
export const MIN_OP_PAUSE_MS = 250;
/** Upper bound accepted for the operation-pause settings, in milliseconds. */
export const MAX_OP_PAUSE_MS = 60_000;
