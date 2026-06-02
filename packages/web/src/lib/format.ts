function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local HH:MM:SS for an epoch-ms timestamp. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** MM:SS remaining until `target`; clamps to 00:00 once past. */
export function fmtCountdown(target: number, now = Date.now()): string {
  const ms = Math.max(0, target - now);
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Compact "just now" / "Nm ago" / "Nh ago". */
export function fmtRelative(ts: number, now = Date.now()): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
