import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// Mock useData so status is pinned to 'logging-in' and refetch is observable.
const { refetchSpy } = vi.hoisted(() => ({ refetchSpy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/DataContext', () => ({
  useData: () => ({
    session: { data: { status: 'logging-in' }, loading: false, error: undefined, refetch: refetchSpy },
  }),
}));

import Session from './Session';

afterEach(() => {
  vi.useRealTimers();
  refetchSpy.mockClear();
});

describe('Session login polling', () => {
  it('caps status polling at 12 ticks while logging in', () => {
    vi.useFakeTimers();
    render(<Session />);
    refetchSpy.mockClear(); // ignore any call during mount
    act(() => {
      vi.advanceTimersByTime(3000 * 20); // far past the 12-tick cap
    });
    expect(refetchSpy).toHaveBeenCalledTimes(12);
  });
});
