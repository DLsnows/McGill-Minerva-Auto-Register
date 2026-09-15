export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';

/** Whether the automation engine may be started for a given session status. */
export interface SessionReadiness {
  /** Longer, user-facing explanation (English on the wire — the UI localizes
   * per status instead; this covers curl and the e2e fake backend). */
  message: string;
  /** True only for 'authenticated' — the sole status in which a poll cycle can
   * actually reach Minerva. */
  ready: boolean;
}

/**
 * Per-status guidance for `POST /api/scheduler/start*`.
 *
 * 'unknown' is not treated as "try it and see": at process start nothing has
 * proved a browser context exists, and the UI's own Start-all gate
 * (`Dashboard.tsx`) already requires 'authenticated'. Starting the engine in
 * that state is how the user got a green "running" toggle over an engine that
 * could not poll anything.
 */
export function sessionReadiness(status: SessionStatus): SessionReadiness {
  switch (status) {
    case 'authenticated':
      return { ready: true, message: 'Session is active.' };
    case 'logging-in':
      return {
        ready: false,
        message: 'Login is still in progress — wait for it to finish before starting the engine.',
      };
    case 'logged-out':
      return {
        ready: false,
        message: 'Not logged in — open the Session tab and log in before starting the engine.',
      };
    case 'unknown':
    default:
      return {
        ready: false,
        message:
          'Session state is unknown — log in from the Session tab before starting the engine.',
      };
  }
}

/**
 * Owns the API's view of the session, and is the single place that decides when
 * that view actually changed.
 *
 * Two writers, one source of truth:
 *   - the session routes (`/api/session/login`, the lazy re-check on
 *     `GET /api/session`);
 *   - the scheduler, the moment a cycle finds the session unusable.
 *
 * The scheduler writer is what makes the UI honest. Previously the status was a
 * closure variable only the session routes could touch, so when a cycle detected
 * an evicted session it would pause every target and log a warn line while
 * `GET /api/session` kept answering 'authenticated' — the UI then showed a green
 * "Active" dot over an engine that had stopped polling. A status that only ever
 * changes when someone asks is not a status; it is a cache of the last question.
 *
 * Subscribers are notified on real transitions only, so the server can push the
 * new truth to connected clients (and so nothing has to poll for it).
 */
export class SessionTruth {
  private status: SessionStatus = 'unknown';
  private readonly listeners = new Set<(status: SessionStatus) => void>();

  constructor(initial: SessionStatus = 'unknown') {
    this.status = initial;
  }

  get(): SessionStatus {
    return this.status;
  }

  /** Set the status; returns true when it actually changed. */
  set(next: SessionStatus): boolean {
    if (next === this.status) return false;
    this.status = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // A broken listener must never break the writer (or the HTTP response
        // that triggered it) — the status is already updated and readable.
      }
    }
    return true;
  }

  /** Convenience for the scheduler path. */
  markLoggedOut(): boolean {
    return this.set('logged-out');
  }

  /** Subscribe to transitions. Returns an unsubscribe function. */
  onChange(listener: (status: SessionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
