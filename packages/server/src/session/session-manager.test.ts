import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { SessionManager } from './session-manager';
import { QueryClient } from '../minerva/query-client';
import { RegisterClient } from '../minerva/register-client';

// Real pacing is 3s ± 1s of deliberate human-like delay; irrelevant here.
vi.mock('../util/pacing', () => ({ humanPause: async () => undefined }));

/** Fake page: records every operation the automation performs on it. */
class FakePage {
  readonly log: string[] = [];
  private url_ = 'https://horizon.mcgill.ca/pban1/twbkwbis.P_GenMenu';

  isClosed(): boolean {
    return false;
  }
  url(): string {
    return this.url_;
  }
  async goto(url: string): Promise<void> {
    this.log.push(`goto ${url}`);
    this.url_ = url;
  }
  async innerText(): Promise<string> {
    return 'Minerva menu';
  }
  async evaluate(): Promise<void> {
    this.log.push('evaluate');
  }
  async waitForFunction(): Promise<unknown> {
    this.log.push('waitForFunction');
    return true; // the submit's response replaced the document
  }
  async waitForLoadState(): Promise<void> {
    this.log.push('waitForLoadState');
  }
  async waitForSelector(selector: string): Promise<null> {
    this.log.push(`waitForSelector ${selector}`);
    return null;
  }
  async content(): Promise<string> {
    this.log.push('content');
    return '<html><body>No classes found</body></html>';
  }
  async fill(selector: string, value: string): Promise<void> {
    this.log.push(`fill ${selector}=${value}`);
  }
  async click(selector: string): Promise<void> {
    this.log.push(`click ${selector}`);
  }
  async selectOption(selector: string, value: string): Promise<string[]> {
    this.log.push(`selectOption ${selector}=${value}`);
    return [];
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

async function makeSession(): Promise<{ session: SessionManager; page: FakePage }> {
  const page = new FakePage();
  const context = {
    pages: () => [page],
    newPage: async () => page,
    on: () => undefined,
    close: async () => undefined,
  } as unknown as BrowserContext;
  const session = new SessionManager(async () => context);
  await session.launch();
  return { session, page };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SessionManager.runExclusive (Q2 — one shared page, one operation at a time)', () => {
  it('runs whole operations strictly one after another, never interleaved', async () => {
    const { session, page } = await makeSession();
    const op = (name: string) => async (p: Page) => {
      expect(p).toBe(page); // every caller gets the same shared page
      page.log.push(`${name}:start`);
      await p.goto(`https://example.test/${name}`);
      await p.selectOption('select[name="x"]', name);
      await p.click(`${name}-submit`);
      page.log.push(`${name}:end`);
      return name;
    };

    const [a, b] = await Promise.all([
      session.runExclusive(op('a')),
      session.runExclusive(op('b')),
    ]);

    expect([a, b]).toEqual(['a', 'b']);
    expect(page.log).toEqual([
      'a:start',
      'goto https://example.test/a',
      'selectOption select[name="x"]=a',
      'click a-submit',
      'a:end',
      'b:start',
      'goto https://example.test/b',
      'selectOption select[name="x"]=b',
      'click b-submit',
      'b:end',
    ]);
  });

  it('queues a waiting operation instead of dropping it', async () => {
    const { session, page } = await makeSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = session.runExclusive(async (p) => {
      page.log.push('first:start');
      await gate;
      await p.goto('https://example.test/first');
      page.log.push('first:end');
    });
    await tick();
    const second = session.runExclusive(async () => {
      page.log.push('second');
      return 'ran';
    });
    await tick();

    // The second operation is waiting, not lost and not running.
    expect(session.queueDepth).toBe(2);
    expect(page.log).toEqual(['first:start']);

    release();
    await first;
    await expect(second).resolves.toBe('ran');
    expect(page.log).toEqual([
      'first:start',
      'goto https://example.test/first',
      'first:end',
      'second',
    ]);
    expect(session.queueDepth).toBe(0);
  });

  it('a throwing operation releases the queue for the next one', async () => {
    const { session } = await makeSession();
    await expect(
      session.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(session.runExclusive(async () => 'ok')).resolves.toBe('ok');
    expect(session.queueDepth).toBe(0);
  });

  it('the isLoggedIn probe queues behind a running operation (same page, same lock)', async () => {
    const { session, page } = await makeSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const running = session.runExclusive(async () => {
      page.log.push('query:start');
      await gate;
      page.log.push('query:end');
    });
    await tick();
    const probe = session.isLoggedIn();
    await tick();

    // The probe must not navigate the page out from under the query.
    expect(page.log).toEqual(['query:start']);

    release();
    await running;
    await expect(probe).resolves.toBe(true);
    expect(page.log).toEqual([
      'query:start',
      'query:end',
      'goto https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin',
    ]);
  });

  it('the login flow holds the queue for its whole duration', async () => {
    const { session, page } = await makeSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const running = session.runExclusive(async () => {
      page.log.push('register:start');
      await gate;
      page.log.push('register:end');
    });
    await tick();
    const login = session.ensureLoggedIn();
    await tick();

    expect(page.log).toEqual(['register:start']);

    release();
    await running;
    await login;
    expect(page.log).toEqual([
      'register:start',
      'register:end',
      'goto https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin',
    ]);
  });
});

describe('SessionManager serializes the real Minerva clients (Q2 regression)', () => {
  const query = {
    term: '202701',
    subject: 'COMP',
    faculty: 'Faculty of Science',
    courseNumber: '551',
    targetCrn: '1814',
  };

  /** Page operations of one query, run alone. */
  async function soloQuery(): Promise<string[]> {
    const { session, page } = await makeSession();
    await new QueryClient(session).getSections(query);
    return [...page.log];
  }

  /** Page operations of one registration, run alone. */
  async function soloRegister(): Promise<string[]> {
    const { session, page } = await makeSession();
    await new RegisterClient(session).act('202701', '1814', 'REGISTER');
    return [...page.log];
  }

  it('two concurrent cycles produce the two solo sequences back to back, with no interleaving', async () => {
    const soloQ = await soloQuery();
    const soloR = await soloRegister();
    expect(soloQ.length).toBeGreaterThan(4);
    expect(soloR.length).toBeGreaterThan(4);

    const { session, page } = await makeSession();
    await Promise.all([
      new QueryClient(session).getSections(query),
      new RegisterClient(session).act('202701', '1814', 'REGISTER'),
    ]);

    // Before the fix the two flows drove the one shared page step by step in
    // parallel (`goto query-term`, `goto add-drop-term`, `selectOption p_term`,
    // `fill CRN_IN`, …), i.e. one cycle's navigation was interrupted by the
    // other's. Now each flow runs to completion before the next starts.
    expect(page.log).toEqual([...soloQ, ...soloR]);
  });

  it('two concurrent registrations for different CRNs never fill each other’s worksheet', async () => {
    const { session, page } = await makeSession();
    await Promise.all([
      new RegisterClient(session).act('202701', '1111', 'REGISTER'),
      new RegisterClient(session).act('202701', '2222', 'REGISTER'),
    ]);

    const crnFills = page.log.filter((l) => l.startsWith('fill input[type="text"][name="CRN_IN"]'));
    expect(crnFills).toEqual([
      'fill input[type="text"][name="CRN_IN"]=1111',
      'fill input[type="text"][name="CRN_IN"]=2222',
    ]);
    // Each submit follows its own fill: no worksheet is submitted carrying the
    // other cycle's CRN (the Quick Add/Drop form posts the whole worksheet).
    const submits = page.log
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('click input[name="REG_BTN"]'))
      .map(({ i }) => i);
    const fills = page.log
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('fill input[type="text"][name="CRN_IN"]'))
      .map(({ i }) => i);
    expect(fills.length).toBe(2);
    expect(submits.length).toBe(2);
    expect(submits[0]).toBeGreaterThan(fills[0]);
    expect(submits[1]).toBeGreaterThan(fills[1]);
    expect(submits[0]).toBeLessThan(fills[1]); // the first submit precedes the second fill
  });
});
