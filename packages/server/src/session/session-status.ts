import type { SessionProbe, SessionStatus } from './types';

/** URL fragments that indicate a login / SSO page (not authenticated). */
const LOGIN_URL_MARKERS = [
  'p_wwwlogin',
  'twbkwbis.p_validate',
  'p_logout',
  'login.microsoftonline.com',
  '/adfs/',
  '/idp/',
  '/cas/',
];

/** Body-text fragments that indicate a login form is being shown. */
const LOGIN_BODY_MARKERS = ['enter your', 'username and password', 'user id', 'sign in', 'duo'];

const AUTH_BASE = 'horizon.mcgill.ca/pban1';

/**
 * Classify whether a probed page means we are authenticated or logged out.
 * Markers are refined against real Minerva behavior during P2 manual verification.
 */
export function classifySession(probe: SessionProbe): SessionStatus {
  const url = probe.url.toLowerCase();
  const body = probe.bodyText.toLowerCase();

  // URL is the most reliable signal. A known login/SSO URL means logged-out;
  // being inside the authenticated pban1 area means authenticated regardless of
  // incidental body text (e.g. a "Sign in as a different user" link).
  if (LOGIN_URL_MARKERS.some((m) => url.includes(m))) return 'logged-out';
  if (url.includes(AUTH_BASE)) return 'authenticated';
  // Fallback for non-pban1 pages (e.g. an SSO landing page).
  if (LOGIN_BODY_MARKERS.some((m) => body.includes(m))) return 'logged-out';
  return 'logged-out';
}
