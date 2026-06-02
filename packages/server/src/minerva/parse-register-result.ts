import * as cheerio from 'cheerio';
import type { RegisterOutcome } from '@autoregister/shared';

/**
 * Classify the outcome of a Quick Add/Drop submit for a specific CRN, by parsing
 * the result page (bwckcoms.P_Regs). Pure: no IO. Header-driven column lookup.
 *
 * Success is keyed on the EXACT target CRN appearing in "Current Schedule" — so
 * registering other courses the same day can never cause a false positive.
 */
export function parseRegisterResult(html: string, crn: string): RegisterOutcome {
  const $ = cheerio.load(html);

  const headerIndex = (rows: ReturnType<typeof $>): Record<string, number> => {
    const idx: Record<string, number> = {};
    rows
      .find('tr')
      .filter((_, tr) => $(tr).find('th.ddheader').length > 0)
      .first()
      .find('th')
      .each((i, th) => {
        const k = $(th).text().trim().toLowerCase().replace(/\s+/g, ' ');
        if (k) idx[k] = i;
      });
    return idx;
  };

  // 1. Current Schedule → registered / waitlisted.
  const sched = $('table.datadisplaytable[summary="Current Schedule"]').first();
  if (sched.length) {
    const idx = headerIndex(sched);
    const crnCol = idx['crn'] ?? 2;
    const statusCol = idx['status'] ?? 0;
    let found: RegisterOutcome | null = null;
    sched.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length <= Math.max(crnCol, statusCol)) return;
      if ($(tds[crnCol]).text().trim() !== crn) return;
      const status = $(tds[statusCol]).text().trim();
      // Order matters: a waitlist status must be checked before "registered".
      if (/waitlist/i.test(status)) found = { kind: 'waitlisted', crn, message: status };
      else if (/registered/i.test(status)) found = { kind: 'registered', crn, message: status };
      if (found) return false; // stop at the first matching row
      return undefined;
    });
    if (found) return found;
  }

  // 2. Registration Add Errors → classify by status message / waitlist option.
  const errs = $('table.datadisplaytable[summary*="Registration Errors"]').first();
  if (errs.length) {
    const idx = headerIndex(errs);
    const crnCol = idx['crn'] ?? 2;
    const statusCol = idx['status'] ?? 0;
    const actionCol = idx['action'] ?? 1;
    let found: RegisterOutcome | null = null;
    errs.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length <= Math.max(crnCol, statusCol, actionCol)) return;
      if ($(tds[crnCol]).text().trim() !== crn) return;
      const message = $(tds[statusCol]).text().trim();
      const canWaitlist = $(tds[actionCol]).find('option[value="LW"]').length > 0;
      if (canWaitlist || /reserved for waitlist/i.test(message)) {
        found = { kind: 'waitlist-available', crn, message };
      } else if (/waitlist full/i.test(message)) {
        found = { kind: 'waitlist-full', crn, message };
      } else if (/closed|class full/i.test(message)) {
        found = { kind: 'closed', crn, message };
      } else {
        found = { kind: 'error', crn, message };
      }
      return false; // a matched CRN is always classified — stop here
    });
    if (found) return found;
  }

  return { kind: 'not-found', crn };
}
