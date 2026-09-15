import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MAX_OP_PAUSE_MS, MIN_OP_PAUSE_MS } from '@autoregister/shared';
import {
  applyPacingSettings,
  configurePacing,
  getPacing,
  humanPause,
  jitterOffset,
  resetPacing,
} from './pacing';

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
    // The jitter fits inside the headroom above the floor, so the full symmetric range is
    // preserved and the extremes hit the exact bounds.
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

  /**
   * Regression, in two rounds.
   *
   * Round 1: making the two values independently configurable exposed an interaction the
   * hardcoded 3000 ± 1000 never had. With base = 250 and jitter = 60000, every negative
   * jitter term (Math.random() <= 0.5) collapsed onto the 250ms floor while the rest
   * spread to ~60s — half of all browser pauses sitting on the hard minimum, a bimodal
   * and obviously mechanical distribution.
   *
   * Round 2 (review): the first fix capped the jitter *symmetrically* at
   * `base - MIN_OP_PAUSE_MS`, which cured the spike by silently discarding most of the
   * configured jitter — with base = 3000, jitter = 60000 the pauses actually ranged
   * 250–5750ms, and with base = 250 the jitter vanished entirely (a constant 250ms).
   * Silently ignoring a setting the user chose is its own bug.
   *
   * Current shape: only the half that cannot reach is truncated. The default and every
   * configuration whose jitter fits above the floor keep the documented symmetric `±`.
   */
  describe('jitter cannot make the floor the mode (without shrinking the spread)', () => {
    it('leaves the offset symmetric while it fits above the floor', () => {
      withRandom(0.5, () => expect(jitterOffset(3000, 0)).toBe(0));
      // jitter < headroom (2750): the full range is available.
      withRandom(0, () => expect(jitterOffset(3000, 1000)).toBe(-1000));
      withRandom(0.5, () => expect(jitterOffset(3000, 1000)).toBe(0));
      withRandom(1, () => expect(jitterOffset(3000, 1000)).toBe(1000));
      // jitter == headroom exactly: still symmetric, the floor is just reachable.
      withRandom(0, () => expect(jitterOffset(3000, 2750)).toBe(-2750));
      withRandom(1, () => expect(jitterOffset(3000, 2750)).toBe(2750));
    });

    it('truncates only the unreachable half once the jitter exceeds the headroom', () => {
      // base sits on the floor: nothing may be subtracted, so the draw is [0, jitter].
      // `random = 0` maps to the lower bound, which is 0 here (the floor itself), and
      // `random = 1` still reaches the configured maximum.
      withRandom(0, () => expect(jitterOffset(MIN_OP_PAUSE_MS, 60000)).toBe(0));
      withRandom(1, () => expect(jitterOffset(MIN_OP_PAUSE_MS, 60000)).toBe(60000));
      // Headroom is positive but smaller than the jitter: the low side is cut to the
      // floor, the high side is untouched.
      withRandom(0, () => expect(jitterOffset(1000, 60000)).toBe(MIN_OP_PAUSE_MS - 1000));
      withRandom(1, () => expect(jitterOffset(1000, 60000)).toBe(60000));
    });

    it('honours a large configured jitter instead of silently shrinking it', () => {
      configurePacing({ baseMs: 3000, jitterMs: 60000 });
      // The old symmetric cap produced 250…5750 here; the configured 60s is now reached,
      // and the low side is truncated at the floor rather than at `base - 2750`.
      withRandom(0, () => expect(scheduledDelay()).toBe(MIN_OP_PAUSE_MS));
      withRandom(1, () => expect(scheduledDelay()).toBe(63000));
    });

    it('keeps the default 3000 ± 1000 symmetric and centred', () => {
      // The whole point of truncating only the unreachable half: the shipped default must
      // not change. A reflection-based fix would have made this 3000…4000 (+17% per op).
      // `jitter = 0` is the degenerate case — the offset is 0 for every draw.
      configurePacing({ baseMs: 3000, jitterMs: 0 });
      for (const r of [0, 0.5, 1] as const) {
        withRandom(r, () => expect(scheduledDelay()).toBe(3000));
      }
      // And with the real default jitter the full symmetric range is available.
      resetPacing();
      withRandom(0, () => expect(scheduledDelay()).toBe(2000));
      withRandom(0.5, () => expect(scheduledDelay()).toBe(3000));
      withRandom(1, () => expect(scheduledDelay()).toBe(4000));
    });

    it('keeps every draw at or above the floor when the base sits on it', () => {
      configurePacing({ baseMs: MIN_OP_PAUSE_MS, jitterMs: 60000 });
      // The floor is a single point of the support (`random = 0` maps to the lower bound,
      // which is exactly 0 here), not the mode: every other draw is strictly above it.
      withRandom(0, () => expect(scheduledDelay()).toBe(MIN_OP_PAUSE_MS));
      for (const r of [0.25, 0.5, 0.75, 1] as const) {
        withRandom(r, () => expect(scheduledDelay()).toBeGreaterThan(MIN_OP_PAUSE_MS));
      }
    });
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

  it('sanitizes explicit arguments, so a non-finite value cannot bypass the floor', () => {
    // `Math.max(MIN_OP_PAUSE_MS, NaN)` is NaN and `setTimeout(fn, NaN)` fires
    // immediately — an unsanitized argument would be the one way around the floor.
    configurePacing({ baseMs: 3000, jitterMs: 1000 });
    withRandom(0.5, () => {
      const spy = vi.spyOn(globalThis, 'setTimeout');
      try {
        void humanPause(Number.NaN, Number.NaN);
        // Non-finite arguments fall back to the effective runtime configuration.
        expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(3000);
        void humanPause(Number.POSITIVE_INFINITY, 0);
        expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(3000);
        // A finite-but-oversized argument clamps to the maximum…
        void humanPause(10 ** 9, 0);
        expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(MAX_OP_PAUSE_MS);
        // …and a finite negative argument clamps to 0, still landing on the floor.
        void humanPause(-1000, 0);
        expect(Number(spy.mock.calls.at(-1)?.[1])).toBe(MIN_OP_PAUSE_MS);
      } finally {
        spy.mockRestore();
      }
    });
    // Whatever the argument soup, what is scheduled stays finite and on/above the floor.
    withRandom(0, () => {
      const spy = vi.spyOn(globalThis, 'setTimeout');
      try {
        for (const [base, jitter] of [
          [Number.NaN, 0],
          [0, Number.NaN],
          [-1, -1],
          [Infinity, Infinity],
        ] as const) {
          void humanPause(base, jitter);
          const delay = Number(spy.mock.calls.at(-1)?.[1]);
          expect(Number.isFinite(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(MIN_OP_PAUSE_MS);
        }
      } finally {
        spy.mockRestore();
      }
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
