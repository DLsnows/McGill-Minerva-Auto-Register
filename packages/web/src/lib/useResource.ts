import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;
}

/** Run `fetcher` on mount; expose data/loading/error + a manual refetch.
 * A generation counter discards stale overlapping responses, and a mounted
 * ref avoids state updates after unmount. */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const genRef = useRef(0);
  const mountedRef = useRef(true);

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
      const result = await fetcher();
      if (live()) {
        setData(result);
        setError(undefined);
      }
    } catch (e) {
      if (live()) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (live()) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
