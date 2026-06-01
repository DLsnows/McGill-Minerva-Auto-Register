import type { Decision, SectionStats } from './types';

/**
 * Decide what to do for a single course section based on its seat stats.
 *
 * Rules (confirmed with user):
 *  - hasWaitlist          = wlcap is an integer > 0
 *  - canRegisterDirectly  = rem > 0 AND (no waitlist OR waitlist empty)
 *  1. canRegisterDirectly        -> REGISTER
 *  2. hasWaitlist && wlrem > 0    -> WAITLIST
 *  3. otherwise                   -> NOOP
 */
export function decide(s: SectionStats): Decision {
  const hasWaitlist = Number.isInteger(s.wlcap) && s.wlcap > 0;
  const canRegisterDirectly = s.rem > 0 && (!hasWaitlist || s.wlact === 0);

  if (canRegisterDirectly) {
    return {
      action: 'REGISTER',
      reason: hasWaitlist
        ? `Waitlist empty (wlact=0) and rem=${s.rem}>0 — register directly`
        : `No waitlist and rem=${s.rem}>0 — register directly`,
    };
  }

  if (hasWaitlist && s.wlrem > 0) {
    return {
      action: 'WAITLIST',
      reason:
        s.wlact > 0
          ? `Waitlist active (wlact=${s.wlact}) with room (wlrem=${s.wlrem}) — join waitlist`
          : `Class full (rem=0), waitlist empty with room (wlrem=${s.wlrem}) — join waitlist to be first`,
    };
  }

  return {
    action: 'NOOP',
    reason: hasWaitlist
      ? `No seat and waitlist full (wlrem=0) — wait`
      : `No waitlist and class full (rem=0) — wait`,
  };
}
