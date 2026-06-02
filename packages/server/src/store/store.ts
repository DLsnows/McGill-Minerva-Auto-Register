import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DailyOps,
  LogEvent,
  Settings,
  WatchStatus,
  WatchTarget,
} from '@autoregister/shared';
import { DEFAULT_SETTINGS } from '@autoregister/shared';

const DEFAULT_MAX_EVENTS = 2000;

interface StoreData {
  targets: WatchTarget[];
  events: LogEvent[];
  settings: Settings;
  dailyOps: DailyOps;
}

/** Local YYYY-MM-DD for a timestamp. */
function localDate(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function freshDailyOps(now: number): DailyOps {
  return { date: localDate(now), queryCount: 0, registerCount: 0 };
}

/**
 * Tiny atomic JSON-file store (no native deps). Holds watch targets, a capped
 * event log, settings, and daily op-counts. Every mutation persists immediately
 * via write-temp + rename. Data dir is gitignored (`data/` by default).
 */
export class Store {
  private readonly file: string;
  private readonly maxEvents: number;
  private data: StoreData;

  constructor(dir = process.env.AUTOREG_DATA_DIR ?? 'data', opts: { maxEvents?: number } = {}) {
    const d = resolve(dir);
    mkdirSync(d, { recursive: true });
    this.file = join(d, 'store.json');
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.data = this.load();
  }

  private load(): StoreData {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
        return {
          targets: parsed.targets ?? [],
          events: parsed.events ?? [],
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
          dailyOps: parsed.dailyOps ?? freshDailyOps(Date.now()),
        };
      } catch {
        // corrupt file — start fresh rather than crash
      }
    }
    return {
      targets: [],
      events: [],
      settings: { ...DEFAULT_SETTINGS },
      dailyOps: freshDailyOps(Date.now()),
    };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  // --- targets ---
  listTargets(): WatchTarget[] {
    return [...this.data.targets];
  }

  getTarget(id: string): WatchTarget | undefined {
    return this.data.targets.find((t) => t.id === id);
  }

  addTarget(
    input: Omit<WatchTarget, 'id' | 'createdAt' | 'status'> & { status?: WatchStatus },
  ): WatchTarget {
    for (const field of ['term', 'subject', 'courseNumber', 'targetCrn'] as const) {
      if (!input[field] || String(input[field]).trim() === '') {
        throw new Error(`addTarget: missing required field "${field}"`);
      }
    }
    const target: WatchTarget = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
      status: input.status ?? 'watching',
    };
    this.data.targets.push(target);
    this.save();
    return target;
  }

  updateTarget(id: string, patch: Partial<WatchTarget>): WatchTarget | undefined {
    const target = this.data.targets.find((t) => t.id === id);
    if (!target) return undefined;
    Object.assign(target, patch);
    this.save();
    return target;
  }

  removeTarget(id: string): void {
    this.data.targets = this.data.targets.filter((t) => t.id !== id);
    this.save();
  }

  // --- events (capped, newest last) ---
  appendEvent(event: Omit<LogEvent, 'id' | 'ts'> & { ts?: number }): LogEvent {
    const ev: LogEvent = { ...event, id: randomUUID(), ts: event.ts ?? Date.now() };
    this.data.events.push(ev);
    if (this.data.events.length > this.maxEvents) {
      this.data.events = this.data.events.slice(-this.maxEvents);
    }
    this.save();
    return ev;
  }

  recentEvents(limit = 200): LogEvent[] {
    return this.data.events.slice(-limit);
  }

  // --- settings ---
  getSettings(): Settings {
    return { ...this.data.settings };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }

  // --- daily ops (resets on local date change) ---
  getDailyOps(now = Date.now()): DailyOps {
    if (this.data.dailyOps.date !== localDate(now)) {
      this.data.dailyOps = freshDailyOps(now);
      this.save();
    }
    return { ...this.data.dailyOps };
  }

  incrementQuery(now = Date.now()): void {
    this.getDailyOps(now);
    this.data.dailyOps.queryCount += 1;
    this.save();
  }

  incrementRegister(now = Date.now()): void {
    this.getDailyOps(now);
    this.data.dailyOps.registerCount += 1;
    this.save();
  }
}
