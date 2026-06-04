import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNow } from './useNow';

afterEach(() => vi.useRealTimers());

describe('useNow', () => {
  it('refreshes the timestamp on its interval', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    const { result } = renderHook(() => useNow(30_000));
    expect(result.current).toBe(t0);

    // advanceTimersByTime advances the fake clock and fires the interval.
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(t0 + 30_000);

    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe(t0 + 60_000);
  });
});
