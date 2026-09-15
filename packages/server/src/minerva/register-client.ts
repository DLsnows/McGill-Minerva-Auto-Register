import type { ActionKind, RegisterOutcome } from '@autoregister/shared';
import type { Page } from 'playwright';
import { ADD_DROP_TERM_URL, QUICK_ADD_URL } from '../session/config';
import type { SessionManager } from '../session/session-manager';
import { humanPause } from '../util/pacing';
import { parseRegisterResult } from './parse-register-result';

/**
 * The tables the post-submit result page must render. Waiting for one of these
 * (instead of `waitForLoadState('domcontentloaded')`, which returns immediately
 * on the pre-submit document) is the fix for audit Q4/Q21.
 */
export const RESULT_ANCHOR =
  'table[summary="Current Schedule"], table[summary*="Registration Errors"]';

/** How long to give the post-submit result page to render its tables. */
const RESULT_TIMEOUT_MS = 10_000;
/** Soft wait for the worksheet's Current Schedule before submitting. */
const PRE_SUBMIT_TIMEOUT_MS = 5_000;
/**
 * How many times to re-read the result page when it doesn't mention our CRN.
 * A single read can land on the PRE-submit document (the click's navigation has
 * not committed yet) or on a half-streamed response body — the auditor measured
 * `page.content()` returning 58 characters of a page still being written.
 */
const RESULT_READ_ATTEMPTS = 3;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Performs registration / waitlist actions on Minerva's Quick Add/Drop.
 * Never throws on a normal Minerva error — returns a classified outcome.
 *
 * A submission is never reported as `not-found`: if the result page cannot be
 * read or does not mention the CRN at all, the outcome is `unverified` — the
 * registration may have gone through, and callers must not treat it as
 * "nothing happened" (audit Q4).
 */
export class RegisterClient {
  constructor(private readonly session: SessionManager) {}

  /**
   * Perform `action` for `crn` in `term`. Handles the waitlist re-submit flow:
   * submit -> if "Open-Space Reserved for Waitlist", pick "Add to Waitlist" (LW)
   * on that row and submit again. Captures a screenshot on unknown errors.
   *
   * The whole action is ONE session operation (audit Q2): Quick Add/Drop submits
   * the entire worksheet, so no other flow may drive the shared page meanwhile.
   */
  async act(term: string, crn: string, action: ActionKind): Promise<RegisterOutcome> {
    if (action === 'NOOP') return { kind: 'not-found', crn };
    return this.session.runExclusive((page) => this.actOnPage(page, term, crn, action));
  }

  private async actOnPage(
    page: Page,
    term: string,
    crn: string,
    action: ActionKind,
  ): Promise<RegisterOutcome> {
    await this.ensureTerm(page, term);
    await humanPause();
    await page.goto(QUICK_ADD_URL, { waitUntil: 'domcontentloaded' });

    // Before touching the worksheet: a CRN that is ALREADY on the schedule must
    // not be submitted again. Re-submitting is how a success we failed to read
    // turns into a "Registration Errors" row and, after three cycles, into a
    // stopped target (audit Q4).
    const already = await this.readCurrentSchedule(page, crn);
    if (already) return already;

    // Enter the CRN in the first empty worksheet field (text inputs only —
    // the Current Schedule rows also carry hidden CRN_IN inputs).
    await humanPause();
    await page.locator('input[type="text"][name="CRN_IN"]').first().fill(crn);
    let outcome = await this.submitChanges(page, crn);

    if (action === 'WAITLIST' && outcome.kind === 'waitlist-available') {
      // Pick "Add to Waitlist" (LW) on the errored row for THIS crn, then resubmit.
      await humanPause();
      const safeCrn = crn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ok = await page
        .locator('table[summary*="Registration Errors"] tr')
        .filter({ hasText: new RegExp(`\\b${safeCrn}\\b`) })
        .locator('select[name="RSTS_IN"]')
        .selectOption('LW')
        .then(() => true)
        .catch(() => false);
      if (ok) outcome = await this.submitChanges(page, crn);
    }

    if (outcome.kind === 'error' || outcome.kind === 'unverified') {
      // Both are "something went wrong that we could not explain" — capture the
      // page so the user can see what Minerva actually rendered.
      await this.captureResultScreenshot(page, crn).catch(() => undefined);
    }
    return outcome;
  }

  /** Ensure the Quick Add/Drop term matches `term` (term_in -> P_StoreTerm). */
  private async ensureTerm(page: Page, term: string): Promise<void> {
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
   * Return the existing registered/waitlisted outcome when the worksheet's
   * Current Schedule already contains `crn`, otherwise null. Unreadable or
   * unparseable documents are ignored (we fall through and submit as before) —
   * this check is a safety net, not the primary path.
   */
  private async readCurrentSchedule(page: Page, crn: string): Promise<RegisterOutcome | null> {
    await page
      .waitForSelector(RESULT_ANCHOR, { timeout: PRE_SUBMIT_TIMEOUT_MS })
      .catch(() => undefined);
    let html: string;
    try {
      html = await page.content();
    } catch {
      return null;
    }
    let outcome: RegisterOutcome;
    try {
      outcome = parseRegisterResult(html, crn);
    } catch {
      return null;
    }
    return outcome.kind === 'registered' || outcome.kind === 'waitlisted' ? outcome : null;
  }

  /**
   * Submit the worksheet and read the result.
   *
   * Two things make an immediate read lie (audit Q4/Q21):
   * - the tables we wait for also exist on the page we submit FROM, so an anchor
   *   wait can resolve against the document we are leaving (this is what made the
   *   waitlist re-submit report the stale offer page as its outcome);
   * - a slow response body is read while it is still streaming — the auditor
   *   measured a 58-character document.
   * So the document is snapshotted before the click and a read is only trusted
   * once it is a DIFFERENT document; otherwise we re-read a bounded number of
   * times. `not-found` is never returned: a submit whose result we could not
   * establish is `unverified`.
   */
  private async submitChanges(page: Page, crn: string): Promise<RegisterOutcome> {
    const submittedFrom = await page.content().catch(() => null);
    await humanPause();
    await page.click('input[name="REG_BTN"][value="Submit Changes"]');

    let lastError: string | undefined;
    for (let attempt = 0; attempt < RESULT_READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await humanPause();
      await page
        .waitForSelector(RESULT_ANCHOR, { timeout: RESULT_TIMEOUT_MS })
        .catch(() => undefined);
      let html: string;
      try {
        html = await page.content();
      } catch (e) {
        lastError = `the result page could not be read: ${errMsg(e)}`;
        continue;
      }
      if (submittedFrom !== null && html === submittedFrom) {
        // Still the document we submitted from: the response has not replaced it
        // yet, so whatever it says is a pre-submit statement, not a result.
        lastError = 'the page still shows the worksheet we submitted from';
        continue;
      }
      let outcome: RegisterOutcome;
      try {
        outcome = parseRegisterResult(html, crn);
      } catch (e) {
        lastError = `the result page could not be parsed: ${errMsg(e)}`;
        continue;
      }
      if (outcome.kind !== 'not-found') return outcome;
      lastError = 'the result page neither confirms the registration nor reports an error for it';
    }

    // Never report a submit we could not read as "not-found": that is what made
    // the old code resubmit a CRN that had in fact been registered.
    return {
      kind: 'unverified',
      crn,
      message: `${lastError ?? 'the result page was not recognized'} — the submission may still have gone through; re-check the schedule before submitting again`,
    };
  }

  private async captureResultScreenshot(page: Page, crn: string): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: `screenshots/register-error-${crn}-${ts}.png`, fullPage: true });
  }
}
