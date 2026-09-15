import { useEffect, useState } from 'react';

/** Current epoch-ms that refreshes every `intervalMs`, so relative timestamps
 * (e.g. "5m ago") keep ticking without waiting for a data refetch.
 *
 * The interval is re-applied immediately on change: a caller that shortens it
 * because something started (e.g. a countdown) gets a fresh `now` on that same
 * render, instead of a value left over from the previous, slower interval —
 * which would briefly over-state the countdown. Pass a short interval only while
 * something genuinely needs it; each tick re-renders the whole component. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now()); // no-op when unchanged; refreshes on an interval change
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
