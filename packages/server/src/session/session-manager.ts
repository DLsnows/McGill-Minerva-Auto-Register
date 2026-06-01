import { chromium, type BrowserContext, type Page } from 'playwright';
import { LOGIN_TIMEOUT_MS, PROFILE_DIR, PROTECTED_PROBE_URL } from './config';
import { classifySession } from './session-status';
import type { SessionStatus } from './types';

/**
 * Owns a persistent, headful Chromium context whose cookies survive restarts.
 * The student logs in once (Duo) in the launched window; later phases reuse it.
 */
export class SessionManager {
  private context: BrowserContext | null = null;

  /** Launch (or relaunch) the persistent browser context. */
  async launch(): Promise<void> {
    if (this.context) return;
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('SessionManager not launched — call launch() first');
    return this.context;
  }

  /** Get a working (non-closed) page, reusing an existing one if present. */
  async getPage(): Promise<Page> {
    const ctx = this.requireContext();
    const existing = ctx.pages().find((p) => !p.isClosed());
    return existing ?? (await ctx.newPage());
  }

  /** Classify session from the page's CURRENT location — does NOT navigate. */
  private async readStatus(page: Page): Promise<SessionStatus> {
    const bodyText = await page.innerText('body').catch(() => '');
    return classifySession({ url: page.url(), bodyText });
  }

  /**
   * Active probe: navigate to a protected page and classify. Use for health
   * checks when NOT in the middle of a manual login.
   */
  async checkStatus(): Promise<SessionStatus> {
    const page = await this.getPage();
    await page.goto(PROTECTED_PROBE_URL, { waitUntil: 'domcontentloaded' });
    return this.readStatus(page);
  }

  /** True if currently authenticated (navigates to probe). */
  async isLoggedIn(): Promise<boolean> {
    return (await this.checkStatus()) === 'authenticated';
  }

  /**
   * Ensure we are logged in. Navigates ONCE to a protected page (triggering the
   * login redirect), then waits PASSIVELY — re-reading the page without
   * navigating — so the user's manual Duo login is never interrupted. Success is
   * detected when the post-login redirect lands back on an authenticated page.
   */
  async ensureLoggedIn(onPrompt?: () => void): Promise<void> {
    const page = await this.getPage();
    await page.goto(PROTECTED_PROBE_URL, { waitUntil: 'domcontentloaded' });
    if ((await this.readStatus(page)) === 'authenticated') return;

    onPrompt?.();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (page.isClosed()) {
        throw new Error('Browser window was closed before login completed');
      }
      if ((await this.readStatus(page)) === 'authenticated') return;
    }
    throw new Error('Login not completed within timeout');
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }
}
