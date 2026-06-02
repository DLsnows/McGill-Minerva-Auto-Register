import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEventStream } from './useEventStream';

class FakeWS {
  static last: FakeWS | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    FakeWS.last = this;
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  FakeWS.last = undefined;
});

describe('useEventStream', () => {
  it('seeds from a recent snapshot then appends events; tracks connected', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream(5));

    act(() => FakeWS.last!.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => FakeWS.last!.emit({ type: 'recent', events: [{ id: 'a', ts: 1, level: 'info', message: 'x' }] }));
    expect(result.current.events).toHaveLength(1);

    act(() => FakeWS.last!.emit({ type: 'event', event: { id: 'b', ts: 2, level: 'ok', message: 'y' } }));
    expect(result.current.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('caps the buffer to `max`', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream(2));
    act(() => {
      for (let i = 0; i < 4; i++) FakeWS.last!.emit({ type: 'event', event: { id: `e${i}`, ts: i, level: 'info', message: '' } });
    });
    expect(result.current.events.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('ignores a non-JSON frame and keeps appending afterwards', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream(5));
    expect(() =>
      act(() => FakeWS.last!.onmessage?.({ data: 'not json <html>502</html>' })),
    ).not.toThrow();
    act(() => FakeWS.last!.emit({ type: 'event', event: { id: 'a', ts: 1, level: 'info', message: 'ok' } }));
    expect(result.current.events.map((e) => e.id)).toEqual(['a']);
  });

  it('marks disconnected on close', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream());
    act(() => FakeWS.last!.onopen?.());
    act(() => FakeWS.last!.onclose?.());
    expect(result.current.connected).toBe(false);
  });
});
