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

/**
 * Strong markers unique to Minerva's login / session-timeout page. Banner serves
 * that page at a pban1 URL (title "User Login"), so these MUST be checked even
 * when the URL looks authenticated — otherwise a timed-out session reads as
 * logged-in. These phrases do not appear on authenticated content pages.
 */
const LOGIN_PAGE_MARKERS = ['login to minerva', 'user login'];

/** Generic login-form hints, used only for non-pban1 pages (e.g. an SSO page). */
const LOGIN_BODY_MARKERS = ['enter your', 'username and password', 'sign in', 'duo'];

const AUTH_BASE = 'horizon.mcgill.ca/pban1';

/**
 * Classify whether a probed page means we are authenticated or logged out.
 */
export function classifySession(probe: SessionProbe): SessionStatus {
  const url = probe.url.toLowerCase();
  const body = probe.bodyText.toLowerCase();

  // 1. Known login/SSO URL → logged out.
  if (LOGIN_URL_MARKERS.some((m) => url.includes(m))) return 'logged-out';
  // 2. Minerva login/timeout page (served at a pban1 URL) → logged out.
  if (LOGIN_PAGE_MARKERS.some((m) => body.includes(m))) return 'logged-out';
  // 3. Otherwise, being inside the authenticated pban1 area → authenticated.
  if (url.includes(AUTH_BASE)) return 'authenticated';
  // 4. Fallback for non-pban1 pages (e.g. an SSO landing page).
  if (LOGIN_BODY_MARKERS.some((m) => body.includes(m))) return 'logged-out';
  return 'logged-out';
}
