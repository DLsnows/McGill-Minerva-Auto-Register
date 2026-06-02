import { resolve } from 'node:path';

/** Authenticated Minerva base path. */
export const MINERVA_BASE = 'https://horizon.mcgill.ca/pban1';

/** A protected page used to probe auth state; redirects to login when not authenticated. */
export const PROTECTED_PROBE_URL = `${MINERVA_BASE}/bwskfreg.P_AltPin`;

/**
 * A page that shows the Minerva login form when not authenticated. Used to get
 * the user to a real login form instead of getting stuck on the MS "signed out"
 * (oauth2/logout) page after a session eviction.
 */
export const LOGIN_URL = `${MINERVA_BASE}/twbkwbis.P_GenMenu?name=bmenu.P_MainMnu`;

/** Persistent browser profile dir (gitignored). Override with AUTOREG_PROFILE_DIR. */
export const PROFILE_DIR = resolve(process.env.AUTOREG_PROFILE_DIR ?? '.browser-profile');

/** Max time (ms) to wait for the user to complete manual login. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
