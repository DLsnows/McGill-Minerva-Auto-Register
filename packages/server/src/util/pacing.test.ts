import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MAX_OP_PAUSE_MS, MIN_OP_PAUSE_MS } from '@autoregister/shared';
import { applyPacingSettings, configurePacing, getPacing, humanPause, resetPacing } from './pacing';

/**
 * Delay `humanPause()` actually scheduled, without waiting for it. Fake timers
 * keep the (up to 60s) pending timer from outliving the test.
 */
function scheduledDelay(): number {
  const spy = vi.spyOn(globalThis, 'setTimeout');
  try {
    void humanPause();
    const call = spy.mock.calls.at(-1);
    if (!call) throw new Error('humanPause did not schedule a timer');
    return Number(call[1]);
  } finally {
    spy.mockRestore();
  }
}

/** Pin `Math.random()` so the jitter term is predictable. */
function withRandom(value: number, run: () => void): void {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(value);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetPacing();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPacing();
});

describe('humanPause', () => {
  it('defaults to the settings defaults (3000 ± 1000 ms)', () => {
    expect(getPacing()).toEqual({ baseMs: 3000, jitterMs: 1000 });
    expect(getPacing()).toEqual({
      baseMs: DEFAULT_SETTINGS.opPauseMs,
      jitterMs: DEFAULT_SETTINGS.opJitterMs,
    });
  });

  it('stays inside [base - jitter, base + jitter] for a configured 500 ± 100', () => {
    configurePacing({ baseMs: 500, jitterMs: 100 });
    expect(scheduledDelay()).toBeGreaterThanOrEqual(400);
    expect(scheduledDelay()).toBeLessThanOrEqual(600);
    // Extremes of the uniform jitter hit the exact bounds.
    withRandom(0, () => expect(scheduledDelay()).toBe(400));
    withRandom(0.5, () => expect(scheduledDelay()).toBe(500));
    withRandom(1, () => expect(scheduledDelay()).toBe(600));
  });

  it('never goes below the 250 ms floor, even when configured to 0', () => {
    configurePacing({ baseMs: 0, jitterMs: 0 });
    withRandom(0, () => expect(scheduledDelay()).toBe(MIN_OP_PAUSE_MS));
    // A hand-edited store.json with a negative value cannot beat the floor either.
    configurePacing({ baseMs: -5000, jitterMs: 0 });
    withRandom(0, () => expect(scheduledDelay()).toBe(MIN_OP_PAUSE_MS));
  });

  it('lets explicit arguments override the runtime configuration', () => {
    configurePacing({ baseMs: 500, jitterMs: 100 });
    withRandom(0.5, () => {
      const spy = vi.spyOn(globalThis, 'setTimeout');
      void humanPause(1000, 0);
      expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(1000);
      spy.mockRestore();
    });
    // …and the floor applies to explicit arguments too.
    withRandom(0, () => {
      const spy = vi.spyOn(globalThis, 'setTimeout');
      void humanPause(0, 0);
      expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(MIN_OP_PAUSE_MS);
      spy.mockRestore();
    });
  });

  it('ignores non-finite configuration and clamps oversized values', () => {
    configurePacing({ baseMs: 1000, jitterMs: 200 });
    configurePacing({ baseMs: Number.NaN, jitterMs: Number.POSITIVE_INFINITY });
    expect(getPacing()).toEqual({ baseMs: 1000, jitterMs: 200 });
    configurePacing({ baseMs: 10 ** 9 });
    expect(getPacing().baseMs).toBe(MAX_OP_PAUSE_MS);
  });
});

describe('pacing configuration', () => {
  it('applyPacingSettings applies the persisted operation-speed fields', () => {
    expect(applyPacingSettings({ opPauseMs: 4000, opJitterMs: 500 })).toEqual({
      baseMs: 4000,
      jitterMs: 500,
    });
    expect(getPacing()).toEqual({ baseMs: 4000, jitterMs: 500 });
    withRandom(1, () => expect(scheduledDelay()).toBe(4500));
  });

  it('configurePacing keeps unspecified fields', () => {
    configurePacing({ baseMs: 1200, jitterMs: 300 });
    configurePacing({ baseMs: 800 });
    expect(getPacing()).toEqual({ baseMs: 800, jitterMs: 300 });
    configurePacing({});
    expect(getPacing()).toEqual({ baseMs: 800, jitterMs: 300 });
    expect(resetPacing()).toEqual({ baseMs: 3000, jitterMs: 1000 });
  });
});
