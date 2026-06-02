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
}

export interface DailyOps {
  /** Local date, YYYY-MM-DD. */
  date: string;
  queryCount: number;
  registerCount: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMinutes: 30,
  jitterMinutes: 3,
  queryBudget: 100,
  registerBudget: 20,
};
