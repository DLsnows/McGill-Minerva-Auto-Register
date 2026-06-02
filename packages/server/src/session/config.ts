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

/** Quick Add/Drop term selection (select[name="term_in"] -> P_StoreTerm). */
export const ADD_DROP_TERM_URL = `${MINERVA_BASE}/bwskflib.P_SelDefTerm`;

/** Quick Add/Drop worksheet (enter CRNs, Submit Changes). */
export const QUICK_ADD_URL = `${MINERVA_BASE}/bwskfreg.P_AltPin`;

/** Persistent browser profile dir (gitignored). Override with AUTOREG_PROFILE_DIR. */
export const PROFILE_DIR = resolve(process.env.AUTOREG_PROFILE_DIR ?? '.browser-profile');

/** Max time (ms) to wait for the user to complete manual login. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Max time (ms) to wait for the SSO redirect chain after clicking Login. */
export const SSO_NAV_TIMEOUT_MS = 10_000;
