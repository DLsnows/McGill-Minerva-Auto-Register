import { chromium, type BrowserContext, type Page } from 'playwright';
import { LOGIN_TIMEOUT_MS, LOGIN_URL, PROFILE_DIR, PROTECTED_PROBE_URL } from './config';
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
    // If the context is closed externally (crash, user closes window), drop the
    // stale reference so a later launch() re-creates it instead of silently
    // no-opping and failing later in getPage().
    this.context.on('close', () => {
      this.context = null;
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

    // Surface the login form and attempt auto-login by clicking "Login" — the
    // persistent profile remembers the SSO session, so this usually
    // authenticates with no typing and no 2FA. Manual login is only needed if
    // that doesn't complete (e.g. Duo actually prompts).
    await this.gotoLoginForm(page);
    await this.tryClickLogin(page);

    const start = Date.now();
    const deadline = start + LOGIN_TIMEOUT_MS;
    let prompted = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      if (page.isClosed()) {
        throw new Error('Browser window was closed before login completed');
      }
      if ((await this.readStatus(page)) === 'authenticated') return;
      // Bounce off the MS "signed out" dead-end and retry auto-login.
      if (page.url().toLowerCase().includes('oauth2/logout')) {
        await this.gotoLoginForm(page);
        await this.tryClickLogin(page);
        continue;
      }
      // Give auto-login (+ SSO redirects) a grace period; only then ask the
      // user to log in manually.
      if (!prompted && Date.now() - start > 12000) {
        onPrompt?.();
        prompted = true;
      }
    }
    throw new Error('Login not completed within timeout');
  }

  /** Navigate to the Minerva login form, logging (not swallowing) any failure. */
  private async gotoLoginForm(page: Page): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch((e: unknown) => {
      console.warn('navigation to login form failed:', e instanceof Error ? e.message : e);
    });
  }

  /**
   * Attempt auto-login. Prefer the SAML SSO login link, which authenticates via
   * the profile's remembered SSO session (no credentials, no 2FA). Fall back to
   * a "Login" submit/button if the SSO link isn't present.
   */
  private async tryClickLogin(page: Page): Promise<void> {
    const sso = page.locator('a[href*="saml/login"], a[href*="ssomanager"]').first();
    const btn = page
      .locator('#mcg_id_submit, input[type="submit"][value="Login" i], button:has-text("Login")')
      .first();
    const target = (await sso.count().catch(() => 0)) > 0 ? sso : btn;
    if ((await target.count().catch(() => 0)) === 0) return;
    await page.waitForTimeout(500);
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined),
      target
        .click()
        .catch((e: unknown) =>
          console.warn('login click failed:', e instanceof Error ? e.message : e),
        ),
    ]);
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }
}
