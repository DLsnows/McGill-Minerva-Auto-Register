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
  queryBudget: 100,
  registerBudget: 20,
  notify: { desktop: true, sound: true, email: false },
  dryRun: false,
};
