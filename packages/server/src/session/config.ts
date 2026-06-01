import { resolve } from 'node:path';

/** Authenticated Minerva base path. */
export const MINERVA_BASE = 'https://horizon.mcgill.ca/pban1';

/** A protected page used to probe auth state; redirects to login when not authenticated. */
export const PROTECTED_PROBE_URL = `${MINERVA_BASE}/bwskfreg.P_AltPin`;

/** Persistent browser profile dir (gitignored). Override with AUTOREG_PROFILE_DIR. */
export const PROFILE_DIR = resolve(process.env.AUTOREG_PROFILE_DIR ?? '.browser-profile');

/** Max time (ms) to wait for the user to complete manual login. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
