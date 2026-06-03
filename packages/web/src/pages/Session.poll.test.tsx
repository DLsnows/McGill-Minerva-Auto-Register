import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

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
  it('keeps polling past the retry threshold and stops only at the ~6 min hard cap', () => {
    vi.useFakeTimers();
    render(<Session />);
    refetchSpy.mockClear(); // ignore any call during mount
    act(() => {
      vi.advanceTimersByTime(3000 * 20); // well past the old 36s give-up point
    });
    expect(refetchSpy).toHaveBeenCalledTimes(20); // still polling — slow logins are caught
    act(() => {
      vi.advanceTimersByTime(3000 * 200); // far past the 120-tick hard stop
    });
    expect(refetchSpy).toHaveBeenCalledTimes(120); // capped at ~6 min
  });

  it('re-enables the login button after ~40s so a stuck login can be retried', () => {
    vi.useFakeTimers();
    render(<Session />);
    expect(screen.getByRole('button')).toBeDisabled(); // disabled while logging-in
    act(() => {
      vi.advanceTimersByTime(3000 * 13); // ~40s
    });
    expect(screen.getByRole('button')).toBeEnabled(); // re-enabled for retry (polling continues)
  });
});
