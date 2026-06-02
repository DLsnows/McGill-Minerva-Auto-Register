import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;
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

  const refetch = useCallback(async () => {
    const gen = ++genRef.current;
    const live = () => mountedRef.current && gen === genRef.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (live()) {
        setData(result);
        setError(undefined);
      }
    } catch (e) {
      if (live()) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (live()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
