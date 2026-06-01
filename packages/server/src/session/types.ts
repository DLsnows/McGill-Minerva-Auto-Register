export type SessionStatus = 'authenticated' | 'logged-out';

export interface SessionProbe {
  /** The final URL after navigating to a protected page. */
  url: string;
  /** A lowercased snippet of page text/HTML used for marker detection. */
  bodyText: string;
}
