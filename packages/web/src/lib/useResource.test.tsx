import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource, type RefetchResult } from './useResource';

// helper: pause for any pending microtasks
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('useResource', () => {
  it('loads data and exposes it', async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    const { result } = renderHook(() => useResource(fetcher));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeUndefined();
  });

  it('captures errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toBe('nope');
  });

  it('marks a FAILED first read as settled (a completed read is not an unread one)', async () => {
    // Regression: `settled` was only set on success, so a first read that failed left it
    // false — and consumers read `!settled` as "never read", rendering a failure exactly
    // like an unresolved resource. That is the conflation this workstream exists to
    // remove: `data === undefined` is what tells a failed first read from a failed
    // refetch, not `settled`.
    const fetcher = vi.fn().mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useResource(fetcher));

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.settled).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('refetch re-runs the fetcher', async () => {
    let n = 1;
    const fetcher = vi.fn().mockImplementation(async () => n++);
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.data).toBe(1));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBe(2);
  });

  it('does not refetch in a loop when given a non-memoized fetcher', async () => {
    let calls = 0;
    const { rerender } = renderHook(() =>
      useResource(() => {
        calls++;
        return Promise.resolve('x');
      }),
    );
    await waitFor(() => expect(calls).toBe(1));
    rerender(); // new inline fetcher each render — must NOT trigger more fetches
    rerender();
    await flush();
    expect(calls).toBe(1);
  });

  it('discards a stale in-flight response when a newer refetch resolves first', async () => {
    let resolveSlow!: (v: string) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (resolveSlow = r))) // mount: slow
      .mockImplementationOnce(() => Promise.resolve('fresh')); // refetch: fast
    const { result } = renderHook(() => useResource(fetcher));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBe('fresh');
    // resolve the older, slower request — it must NOT overwrite 'fresh'
    await act(async () => {
      resolveSlow('stale');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('fresh');
  });

  it('refetch reports the outcome (instead of swallowing it) and records the error', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('ok')
      .mockRejectedValue(new Error('refresh nope'));
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.data).toBe('ok'));

    // A caller that must report a failed refresh needs the outcome from the
    // refetch itself — the `error` captured in its closure is the pre-refetch one.
    let outcome!: RefetchResult;
    await act(async () => {
      outcome = await result.current.refetch();
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && 'error' in outcome && outcome.error.message).toBe(
      'refresh nope',
    );
    await waitFor(() => expect(result.current.error?.message).toBe('refresh nope'));

    // A successful refetch reports success — and only success. `ok: false` is
    // never how a landed read is reported.
    fetcher.mockResolvedValueOnce('ok again');
    await act(async () => {
      outcome = await result.current.refetch();
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('bumps `revision` only when a read actually lands', async () => {
    // Consumers retire their "the refresh failed" note by watching this, so a
    // failed or discarded read must not move it — otherwise the note would be
    // cleared by a read that never happened.
    const fetcher = vi.fn().mockResolvedValueOnce('one').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.data).toBe('one'));
    const afterFirstRead = result.current.revision;
    expect(afterFirstRead).toBeGreaterThan(0);

    await act(async () => {
      await result.current.refetch(); // fails
    });
    expect(result.current.revision).toBe(afterFirstRead);

    fetcher.mockResolvedValueOnce('two');
    await act(async () => {
      await result.current.refetch(); // lands
    });
    expect(result.current.revision).toBe(afterFirstRead + 1);
  });

  it('reports a superseded refetch separately from a successful one', async () => {
    // Both used to collapse into `undefined`, which let a caller treat a result
    // that was thrown away as if it had been applied. The superseding call is a
    // *captured* one: the mount read's outcome is discarded by the effect (it is
    // `void refetch()`), so asserting on that would prove nothing — the discarded
    // branch would go untested even if it returned `{ ok: true }`.
    const resolveSlow: Array<(v: string) => void> = [];
    const fetcher = vi.fn(() => new Promise<string>((r) => resolveSlow.push(r)));
    const { result } = renderHook(() => useResource(fetcher));
    // Let the mount effect start its read (call 0).
    await act(async () => {
      await Promise.resolve();
    });

    let slow!: RefetchResult;
    await act(async () => {
      void result.current.refetch().then((o) => (slow = o)); // call 1 — will be superseded
    });
    let fast!: RefetchResult;
    await act(async () => {
      void result.current.refetch().then((o) => (fast = o)); // call 2 — the live one
    });

    // Settle call 2 first, then the call 1 it superseded.
    await act(async () => {
      resolveSlow[2]('fresh');
      await Promise.resolve();
    });
    await act(async () => {
      resolveSlow[1]('stale');
      await Promise.resolve();
    });

    expect(fast).toEqual({ ok: true });
    expect(slow).toEqual({ ok: false, superseded: true });
    expect(result.current.data).toBe('fresh');
    expect(result.current.error).toBeUndefined();
  });
});
