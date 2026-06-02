import type { ActionKind, RegisterOutcome } from '@autoregister/shared';
import { ADD_DROP_TERM_URL, QUICK_ADD_URL } from '../session/config';
import type { SessionManager } from '../session/session-manager';
import { humanPause } from '../util/pacing';
import { parseRegisterResult } from './parse-register-result';

/**
 * Performs registration / waitlist actions on Minerva's Quick Add/Drop.
 * Never throws on a normal Minerva error — returns a classified outcome.
 */
export class RegisterClient {
  constructor(private readonly session: SessionManager) {}

  /** Ensure the Quick Add/Drop term matches `term` (term_in -> P_StoreTerm). */
  private async ensureTerm(term: string): Promise<void> {
    const page = await this.session.getPage();
    await humanPause();
    await page.goto(ADD_DROP_TERM_URL, { waitUntil: 'domcontentloaded' });
    if ((await page.locator('select[name="term_in"]').count()) > 0) {
      await humanPause();
      await page.selectOption('select[name="term_in"]', term);
      await humanPause();
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        page.click('form[action*="P_StoreTerm"] input[type="submit"]'),
      ]);
    }
  }

  /**
   * Perform `action` for `crn` in `term`. Handles the waitlist re-submit flow:
   * submit -> if "Open-Space Reserved for Waitlist", pick "Add to Waitlist" (LW)
   * on that row and submit again. Captures a screenshot on unknown errors.
   */
  async act(term: string, crn: string, action: ActionKind): Promise<RegisterOutcome> {
    if (action === 'NOOP') return { kind: 'not-found', crn };

    await this.ensureTerm(term);
    const page = await this.session.getPage();
    await humanPause();
    await page.goto(QUICK_ADD_URL, { waitUntil: 'domcontentloaded' });

    // Enter the CRN in the first empty worksheet field (text inputs only —
    // the Current Schedule rows also carry hidden CRN_IN inputs).
    await humanPause();
    await page.locator('input[type="text"][name="CRN_IN"]').first().fill(crn);
    await humanPause();
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('input[name="REG_BTN"][value="Submit Changes"]'),
    ]);
    let outcome = parseRegisterResult(await page.content(), crn);

    if (action === 'WAITLIST' && outcome.kind === 'waitlist-available') {
      // Pick "Add to Waitlist" (LW) on the errored row for THIS crn, then resubmit.
      await humanPause();
      const ok = await page
        .locator('table[summary*="Registration Errors"] tr')
        .filter({ hasText: new RegExp(`\\b${crn}\\b`) })
        .locator('select[name="RSTS_IN"]')
        .selectOption('LW')
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await humanPause();
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          page.click('input[name="REG_BTN"][value="Submit Changes"]'),
        ]);
        outcome = parseRegisterResult(await page.content(), crn);
      }
    }

    if (outcome.kind === 'error') {
      await this.captureErrorScreenshot(crn).catch(() => undefined);
    }
    return outcome;
  }

  private async captureErrorScreenshot(crn: string): Promise<void> {
    const page = await this.session.getPage();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: `screenshots/register-error-${crn}-${ts}.png`, fullPage: true });
  }
}
