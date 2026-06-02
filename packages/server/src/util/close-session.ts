import type { SessionManager } from '../session/session-manager';

/**
 * Close the browser session without hanging forever. Playwright's headful
 * close() can be slow on Windows; if it doesn't finish within `timeoutMs`, warn
 * (an orphaned Chromium process may remain) and let the caller proceed.
 */
export async function closeSession(session: SessionManager, timeoutMs = 5000): Promise<void> {
  const closed = session
    .close()
    .then(() => true)
    .catch(() => true);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  if (!(await Promise.race([closed, timedOut]))) {
    console.warn(
      `Browser did not close within ${timeoutMs}ms; an orphaned Chromium process may remain.`,
    );
  }
}
