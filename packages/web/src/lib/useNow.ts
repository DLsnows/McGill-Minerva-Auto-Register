import { useEffect, useState } from 'react';

/** Current epoch-ms that refreshes every `intervalMs`, so relative timestamps
 * (e.g. "5m ago") keep ticking without waiting for a data refetch. Pass a smaller
 * interval only while something genuinely needs it (e.g. a countdown) — the
 * interval drives a re-render of the whole component. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
