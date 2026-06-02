import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource } from './useResource';

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
});
