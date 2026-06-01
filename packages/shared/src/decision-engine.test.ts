import { describe, it, expect } from 'vitest';
import { decide } from './decision-engine';
import type { SectionStats } from './types';

function stats(overrides: Partial<SectionStats>): SectionStats {
  return {
    crn: '1234',
    cap: 100,
    act: 100,
    rem: 0,
    wlcap: 0,
    wlact: 0,
    wlrem: 0,
    ...overrides,
  };
}

describe('decide', () => {
  it('REGISTERs when no waitlist and seats remain', () => {
    expect(decide(stats({ wlcap: 0, rem: 5 })).action).toBe('REGISTER');
  });

  it('NOOPs when no waitlist and class is full', () => {
    expect(decide(stats({ wlcap: 0, rem: 0 })).action).toBe('NOOP');
  });

  it('REGISTERs when waitlist exists but is empty and seats remain', () => {
    expect(decide(stats({ wlcap: 30, wlact: 0, wlrem: 30, rem: 2 })).action).toBe('REGISTER');
  });

  it('WAITLISTs when waitlist is empty, class is full, and waitlist has room (grab #1)', () => {
    expect(decide(stats({ wlcap: 30, wlact: 0, wlrem: 30, rem: 0 })).action).toBe('WAITLIST');
  });

  it('WAITLISTs when people are waitlisted, class is full, and waitlist has room', () => {
    expect(decide(stats({ wlcap: 20, wlact: 14, wlrem: 6, rem: 0 })).action).toBe('WAITLIST');
  });

  it('WAITLISTs (not REGISTER) when seats remain but waitlist is active (seats reserved)', () => {
    expect(decide(stats({ wlcap: 20, wlact: 14, wlrem: 6, rem: 3 })).action).toBe('WAITLIST');
  });

  it('NOOPs when waitlist is active but full, even if seats remain', () => {
    expect(decide(stats({ wlcap: 20, wlact: 20, wlrem: 0, rem: 3 })).action).toBe('NOOP');
  });

  it('NOOPs when waitlist is active and full and class is full', () => {
    expect(decide(stats({ wlcap: 20, wlact: 20, wlrem: 0, rem: 0 })).action).toBe('NOOP');
  });

  it('treats non-positive wlcap as no waitlist', () => {
    expect(decide(stats({ wlcap: 0, wlact: 0, wlrem: 0, rem: 1 })).action).toBe('REGISTER');
  });

  it('always returns a non-empty reason', () => {
    expect(decide(stats({ wlcap: 30, wlact: 14, wlrem: 6, rem: 0 })).reason.length).toBeGreaterThan(
      0,
    );
  });
});
