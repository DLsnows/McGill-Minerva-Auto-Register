/** Outcome of a registration/waitlist attempt for a specific CRN. */
export type RegisterOutcomeKind =
  | 'registered' // now in Current Schedule as Web Registered
  | 'waitlisted' // now on the waitlist
  | 'waitlist-available' // open-space reserved for waitlist; can add to waitlist (needs re-submit)
  | 'waitlist-full' // closed - waitlist full
  | 'closed' // closed - class full (no waitlist room)
  | 'error' // other/unknown registration error (captured verbatim)
  | 'not-found'; // CRN not present in schedule or errors

export interface RegisterOutcome {
  kind: RegisterOutcomeKind;
  crn: string;
  /** The verbatim status/error message from Minerva, when present. */
  message?: string;
}
