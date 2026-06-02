import { describe, expect, it } from 'vitest';
import { fmtClock, fmtCountdown, fmtRelative } from './format';

describe('format', () => {
  it('fmtClock renders HH:MM:SS from an epoch ms', () => {
    const ts = new Date(2026, 5, 2, 9, 5, 3).getTime();
    expect(fmtClock(ts)).toBe('09:05:03');
  });

  it('fmtCountdown shows MM:SS until a future time, 00:00 when past', () => {
    const now = 1_000_000;
    expect(fmtCountdown(now + 125_000, now)).toBe('02:05');
    expect(fmtCountdown(now - 5_000, now)).toBe('00:00');
  });

  it('fmtRelative gives compact "Xm ago" / "just now"', () => {
    const now = 1_000_000;
    expect(fmtRelative(now - 5_000, now)).toBe('just now');
    expect(fmtRelative(now - 120_000, now)).toBe('2m ago');
  });
});
