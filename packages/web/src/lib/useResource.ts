import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Outcome of one `refetch()` call, told apart explicitly because callers act on
 * it: `ok` is the only outcome that means "the list on screen is current again".
 * Collapsing these into a single `Error | undefined` is exactly the ambiguity
 * that lets a superseded or failed refresh be mistaken for a successful one. */
export type RefetchResult =
  | { ok: true }
  | { ok: false; error: Error }
  /** A newer call started first, so this one's result was discarded. Neither a
   * success nor a failure — the caller must not claim either. */
  | { ok: false; superseded: true };

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  /** A read has completed at least once — successfully or not. Together with
   * `data`/`error` this separates the three states a consumer must render
   * differently: nothing read yet (`!settled`), a read that failed with nothing to
   * show (`data === undefined && error`), and a failure *after* a successful read
   * (`data !== undefined && error`, i.e. stale data still on hand). */
  settled: boolean;
  /** Bumped every time a read's result is actually applied. A consumer holding a
   * note about a *failed* refresh watches this to retire it: the revision moving
   * proves the data was re-read for real, whichever part of the tree (or which
   * user gesture) triggered that re-read. */
  revision: number;
  /** Re-run the fetcher. Never rejects: the outcome is both recorded on the
   * resource AND returned, so an action that must report a failed refresh
   * (e.g. "saved settings, but the budget refresh failed") can act on it —
   * reading `resource.error` right after awaiting is unreliable because the
   * value captured by the closure is the one from the render that started it. */
  refetch: () => Promise<RefetchResult>;
}

/** Run `fetcher` on mount; expose data/loading/error/settled/revision + a manual
 * refetch. The fetcher is read through a ref so `refetch` stays stable across
 * renders — callers can pass an inline (non-memoized) fetcher without causing a
 * refetch loop. A generation counter discards stale overlapping responses, and a
 * mounted ref avoids state updates after unmount. */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [settled, setSettled] = useState(false);
  const [revision, setRevision] = useState(0);
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

  const refetch = useCallback(async (): Promise<RefetchResult> => {
    const gen = ++genRef.current;
    const live = () => mountedRef.current && gen === genRef.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (!live()) return { ok: false, superseded: true };
      setData(result);
      setSettled(true);
      setError(undefined);
      setRevision((n) => n + 1);
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!live()) return { ok: false, superseded: true };
      setError(err);
      // A *failed* read is still a completed read. Without this, a first read that fails
      // leaves `settled` false, and consumers read `!settled` as "never read" — so the
      // failure would render exactly like an unresolved resource, which is the state this
      // workstream exists to stop conflating. `data === undefined` is what tells a failed
      // first read apart from a failed refetch (the latter keeps the last good data).
      setSettled(true);
      return { ok: false, error: err };
    } finally {
      if (live()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Stable identity unless data/loading/error actually change (refetch is already
  // stable) — lets consumers like DataProvider memoize without churn.
  return useMemo(
    () => ({ data, loading, error, settled, revision, refetch }),
    [data, loading, error, settled, revision, refetch],
  );
}
