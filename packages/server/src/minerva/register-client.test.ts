import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import { RESULT_ANCHOR, SUBMITTING_ATTR, RegisterClient } from './register-client';
import { SessionManager } from '../session/session-manager';

// Real pacing is 3s ± 1s of deliberate human-like delay; irrelevant here.
vi.mock('../util/pacing', () => ({ humanPause: async () => undefined }));

/** Lets one test make the result parser throw, without changing any other test. */
const parseHook = vi.hoisted(() => ({ throwOnNextParse: false }));
vi.mock('./parse-register-result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parse-register-result')>();
  return {
    parseRegisterResult: (html: string, crn: string) => {
      if (parseHook.throwOnNextParse) {
        parseHook.throwOnNextParse = false;
        throw new Error('parser exploded');
      }
      return actual.parseRegisterResult(html, crn);
    },
  };
});

const QUICK_ADD_URL = 'https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin';

/** The Quick Add/Drop worksheet, before submitting. */
const WORKSHEET_HTML = `
<html><body><h1>Quick Add/Drop</h1>
<form action="/pban1/bwckcoms.P_Regs">
  <input type="text" name="CRN_IN">
  <input type="submit" name="REG_BTN" value="Submit Changes">
</form></body></html>`;

/** The half-received document the auditor measured: 58 characters, no tables. */
const PARTIAL_HTML = '<html><head></head><body><h1>processing</h1></body></html>';

const schedRow = (crn: string, status: string) => `
<tr><td class="dddefault">${status}</td><td class="dddefault">&nbsp;</td>
<td class="dddefault">${crn}</td></tr>`;

const RESULT_REGISTERED = `
<html><body><h1>Registration</h1>
<table class="datadisplaytable" summary="Current Schedule">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
${schedRow('1814', 'Web Registered on Jun 02, 2026')}
</table></body></html>`;

const RESULT_CLOSED = `
<html><body><h1>Registration</h1>
<table class="datadisplaytable" summary="This table is used to present Registration Errors.">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
<tr><td class="dddefault">Closed - Class Full</td><td class="dddefault">&nbsp;</td>
<td class="dddefault">1814</td></tr>
</table></body></html>`;

/** First submit: open seats reserved for the waitlist, so an LW re-submit is needed. */
const RESULT_WAITLIST_OFFER = `
<html><body><h1>Registration</h1>
<table class="datadisplaytable" summary="This table is used to present Registration Errors.">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
<tr><td class="dddefault"><a href="x">Open-Space(s) Reserved for Waitlist</a></td>
<td class="dddefault"><select name="RSTS_IN"><option value="">None</option><option value="LW">(Add(ed) to Waitlist)</option></select></td>
<td class="dddefault">1814</td></tr>
</table></body></html>`;

/** The page the LW re-submit finally renders: the CRN is on the waitlist. */
const RESULT_WAITLISTED = `
<html><body><h1>Registration</h1>
<table class="datadisplaytable" summary="Current Schedule">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
${schedRow('1814', 'Waitlist on Jun 02, 2026')}
</table></body></html>`;

/** Fake page: records operations and serves scripted documents. No browser, no network. */
class FakePage {
  readonly log: string[] = [];
  /** Document served once the scripted reads run out. */
  html = WORKSHEET_HTML;
  /** Documents served by successive reads; the last one repeats. */
  private reads: string[] = [];
  /** Remaining reads that fail the way Playwright does mid-navigation. */
  private failingReads = 0;
  /** Simulates the browser navigating when the worksheet is submitted. */
  onSubmit?: () => void;
  /** Whether the submit's response replaces the page within the wait (a submit
   * whose navigation is still in flight keeps the old document in place). */
  documentReplaced = true;
  /** Whether the "document we submit from" mark is on the CURRENT document. The
   * mark is part of the serialized HTML, exactly as it is in a real browser. */
  private marked = false;

  queueReads(...docs: string[]): void {
    this.reads = docs;
  }
  failReads(n: number): void {
    this.failingReads = n;
  }

  isClosed(): boolean {
    return false;
  }
  url(): string {
    return QUICK_ADD_URL;
  }
  async goto(url: string): Promise<void> {
    this.log.push(`goto ${url}`);
  }
  async evaluate(expression: string): Promise<void> {
    this.log.push('evaluate');
    if (expression.includes('setAttribute')) this.marked = true;
  }
  async waitForFunction(): Promise<unknown> {
    this.log.push('waitForFunction');
    // Nothing marked → the predicate is trivially true, as in the browser.
    if (!this.marked) return true;
    if (!this.documentReplaced) throw new Error('Timeout 10000ms exceeded.'); // still the old document
    this.marked = false; // the response replaced the page, so the mark is gone
    return true;
  }
  async content(): Promise<string> {
    this.log.push('content');
    if (this.failingReads > 0) {
      this.failingReads--;
      throw new Error(
        'Unable to retrieve content because the page is navigating and changing the content.',
      );
    }
    const doc =
      this.reads.length > 1 ? (this.reads.shift() as string) : (this.reads[0] ?? this.html);
    return this.marked ? doc.replace('<html', `<html ${SUBMITTING_ATTR}="1"`) : doc;
  }
  async click(selector: string): Promise<void> {
    this.log.push(`click ${selector}`);
    if (selector.includes('Submit Changes')) this.onSubmit?.();
  }
  async fill(selector: string, value: string): Promise<void> {
    this.log.push(`fill ${selector}=${value}`);
  }
  async selectOption(selector: string, value: string): Promise<string[]> {
    this.log.push(`selectOption ${selector}=${value}`);
    return [];
  }
  async waitForSelector(selector: string): Promise<null> {
    this.log.push(`waitForSelector ${selector}`);
    return null;
  }
  async waitForLoadState(): Promise<void> {
    this.log.push('waitForLoadState');
  }
  async screenshot(): Promise<void> {
    this.log.push('screenshot');
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector);
  }
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}
  first(): FakeLocator {
    return this;
  }
  filter(): FakeLocator {
    return this;
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this.page, selector);
  }
  async count(): Promise<number> {
    return 0; // no term_in select → ensureTerm only navigates
  }
  async fill(value: string): Promise<void> {
    this.page.log.push(`fill ${this.selector}=${value}`);
  }
  async selectOption(value: string): Promise<string[]> {
    this.page.log.push(`selectOption ${this.selector}=${value}`);
    return [];
  }
  async click(): Promise<void> {
    this.page.log.push(`click ${this.selector}`);
  }
}

async function clientFor(page: FakePage): Promise<RegisterClient> {
  const context = {
    pages: () => [page],
    newPage: async () => page,
    on: () => undefined,
    close: async () => undefined,
  } as unknown as BrowserContext;
  const session = new SessionManager(async () => context);
  await session.launch();
  return new RegisterClient(session);
}

const submits = (page: FakePage) =>
  page.log.filter((l) => l.startsWith('click input[name="REG_BTN"]')).length;

describe('RegisterClient.act — reading the result page (Q4 / Q21)', () => {
  it('waits for the result page instead of parsing a half-received document', async () => {
    const page = new FakePage();
    // Slow response body: the first read lands on the pre-submit/partial
    // document, the registration result arrives on the next one.
    page.onSubmit = () => page.queueReads(PARTIAL_HTML, RESULT_REGISTERED);

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    // Before the fix: the immediate page.content() returned PARTIAL_HTML, the
    // parser found no CRN and the caller was told "not-found" — a real
    // registration reported as "nothing happened".
    expect(outcome.kind).toBe('registered');
    expect(submits(page)).toBe(1);
    expect(page.log).toContain(`waitForSelector ${RESULT_ANCHOR}`);
    expect(page.log.filter((l) => l === 'content').length).toBeGreaterThan(1);
  });

  it('reports an unreadable result as unverified — never as not-found', async () => {
    const page = new FakePage();
    page.onSubmit = () => {
      page.html = PARTIAL_HTML; // the full document never arrives
    };

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    expect(outcome.kind).toBe('unverified');
    expect(outcome.kind).not.toBe('not-found');
    expect(outcome.crn).toBe('1814');
    expect(outcome.message).toMatch(/may still have gone through/i);
  });

  it('treats a mid-navigation content() failure as unverified, not as an empty result', async () => {
    const page = new FakePage();
    page.onSubmit = () => page.failReads(10); // every read hits a navigating page

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    expect(outcome.kind).toBe('unverified');
    expect(outcome.message).toMatch(/could not be read/i);
  });

  it('still classifies a real registration error from the result page', async () => {
    const page = new FakePage();
    page.onSubmit = () => page.queueReads(RESULT_CLOSED);

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    expect(outcome.kind).toBe('closed');
  });

  it('does not submit a CRN that is already on the Current Schedule', async () => {
    const page = new FakePage();
    page.html = RESULT_REGISTERED; // the worksheet already shows 1814 as registered
    const client = await clientFor(page);

    const outcome = await client.act('202701', '1814', 'REGISTER');

    // Re-submitting is how a registration that DID succeed turns into a
    // "Registration Errors" row and, three cycles later, into a stopped target.
    expect(outcome.kind).toBe('registered');
    expect(submits(page)).toBe(0);
    expect(page.log.some((l) => l.startsWith('fill input[type="text"][name="CRN_IN"]'))).toBe(
      false,
    );
  });

  it('does not re-submit for the waitlist when the CRN is already waitlisted', async () => {
    const page = new FakePage();
    page.html = `
<html><body>
<table class="datadisplaytable" summary="Current Schedule">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
${schedRow('1814', 'Waitlist on Jun 01, 2026')}
</table></body></html>`;

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'WAITLIST'));

    expect(outcome.kind).toBe('waitlisted');
    expect(submits(page)).toBe(0);
  });

  it('reports the waitlist join itself, not the stale offer page it submitted from', async () => {
    const page = new FakePage();
    let submitCount = 0;
    page.onSubmit = () => {
      submitCount++;
      if (submitCount === 1) {
        page.queueReads(RESULT_WAITLIST_OFFER);
        return;
      }
      // The re-submit's navigation is still in flight when its first read
      // happens, so the page we submitted from (the offer page) is still there —
      // and the CRN sits in its Registration Errors row with an LW option. Only
      // the next read shows the waitlist join.
      page.documentReplaced = false;
      page.queueReads(RESULT_WAITLIST_OFFER, RESULT_WAITLISTED);
    };

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'WAITLIST'));

    expect(submitCount).toBe(2); // the offer really did trigger an LW re-submit
    expect(page.log.some((l) => l.startsWith('selectOption select[name="RSTS_IN"]=LW'))).toBe(true);
    // Reporting the stale page would tell the user "will reassess next cycle"
    // while the waitlist join already happened.
    expect(outcome.kind).toBe('waitlisted');
  });

  it('waits for the result document to commit, not merely for a result table', async () => {
    const page = new FakePage();
    page.onSubmit = () => page.queueReads(RESULT_REGISTERED);

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    expect(outcome.kind).toBe('registered');
    // The anchor also exists on the worksheet, so the client must mark the
    // document it submits from and wait for the response to replace it.
    expect(page.log).toContain('evaluate');
    expect(page.log).toContain('waitForFunction');
  });

  it('falls through to the submission when the worksheet cannot be parsed', async () => {
    const page = new FakePage();
    page.onSubmit = () => page.queueReads(RESULT_REGISTERED);
    parseHook.throwOnNextParse = true; // the pre-submit safety-net read explodes

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    // The safety-net check must not break act()'s "never throws on a normal
    // Minerva error" contract: fall through and submit as before.
    expect(submits(page)).toBe(1);
    expect(outcome.kind).toBe('registered');
  });

  it('keeps reporting the waitlist offer when a rejected re-submit re-renders the same page', async () => {
    const page = new FakePage();
    let submitCount = 0;
    page.onSubmit = () => {
      submitCount++;
      if (submitCount === 1) page.queueReads(RESULT_WAITLIST_OFFER);
      // The LW re-submit changes nothing: Minerva re-renders the very same offer
      // page. That page is a legitimate, readable answer — not an unverified one.
    };

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'WAITLIST'));

    expect(submitCount).toBe(2);
    expect(outcome.kind).toBe('waitlist-available');
  });

  it('does not blame a first submit for an outcome read from the unchanged worksheet', async () => {
    const page = new FakePage();
    page.html = RESULT_CLOSED; // leftover Registration Errors row from an earlier run
    page.onSubmit = () => {
      page.documentReplaced = false; // the response never replaces the page
    };

    const outcome = await clientFor(page).then((c) => c.act('202701', '1814', 'REGISTER'));

    // Attributing the leftover row to this submit would silently report "closed"
    // and skip a registration that may well have gone through.
    expect(outcome.kind).toBe('unverified');
  });
});
