import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  /** Re-run the fetcher. Never rejects: the outcome is both recorded on the
   * resource AND returned, so an action that must report a failed refresh
   * (e.g. "saved settings, but the budget refresh failed") can act on it —
   * reading `resource.error` right after awaiting is unreliable because the
   * value captured by the closure is the one from the render that started it. */
  refetch: () => Promise<Error | undefined>;
}

/** Run `fetcher` on mount; expose data/loading/error + a manual refetch.
 * The fetcher is read through a ref so `refetch` stays stable across renders —
 * callers can pass an inline (non-memoized) fetcher without causing a refetch
 * loop. A generation counter discards stale overlapping responses, and a
 * mounted ref avoids state updates after unmount. */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher; // keep latest fetcher without changing refetch identity
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async (): Promise<Error | undefined> => {
    const gen = ++genRef.current;
    const live = () => mountedRef.current && gen === genRef.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (live()) {
        setData(result);
        setError(undefined);
      }
      return undefined;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (live()) setError(err);
      return err;
    } finally {
      if (live()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Stable identity unless data/loading/error actually change (refetch is already
  // stable) — lets consumers like DataProvider memoize without churn.
  return useMemo(() => ({ data, loading, error, refetch }), [data, loading, error, refetch]);
}
