/** Seat statistics for a single course section (one CRN), as read from Minerva. */
export interface SectionStats {
  /** 4-digit Course Reference Number. */
  crn: string;
  /** Capacity. */
  cap: number;
  /** Actual enrolled. */
  act: number;
  /** Remaining seats (cap - act). */
  rem: number;
  /** Waitlist capacity. */
  wlcap: number;
  /** Waitlist actual (people currently waitlisted). */
  wlact: number;
  /** Waitlist remaining. */
  wlrem: number;
}

/** The action the watcher should take for a section. */
export type ActionKind = 'REGISTER' | 'WAITLIST' | 'NOOP';

/** Result of the decision engine. */
export interface Decision {
  action: ActionKind;
  reason: string;
}
