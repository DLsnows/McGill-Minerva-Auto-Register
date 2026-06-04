import { useEffect, useState } from 'react';

/** Current epoch-ms that refreshes every `intervalMs`, so relative timestamps
 * (e.g. "5m ago") keep ticking without waiting for a data refetch. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
