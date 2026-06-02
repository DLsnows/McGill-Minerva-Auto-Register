import type { LogEvent, LogLevel } from '@autoregister/shared';

/** Levels significant enough to push externally (routine `info` is in-app only). */
const NOTIFY_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['action', 'ok', 'warn', 'error']);

export function shouldNotify(event: LogEvent): boolean {
  return NOTIFY_LEVELS.has(event.level);
}

const TITLES: Record<LogLevel, string> = {
  info: 'ℹ️ AutoRegister',
  action: '🔔 AutoRegister — opening found',
  ok: '✅ AutoRegister',
  warn: '⚠️ AutoRegister — attention',
  error: '❌ AutoRegister — error',
};

export function buildNotification(event: LogEvent): { title: string; body: string } {
  return { title: TITLES[event.level], body: event.message };
}
