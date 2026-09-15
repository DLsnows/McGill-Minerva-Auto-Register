#!/usr/bin/env node
/**
 * Preview end-to-end acceptance suite.
 *
 * Runs the real production web bundle against an in-memory fake API (e2e/fake-server.mjs)
 * in a real Chromium. No Minerva, no Playwright session, no disk store, no scheduler —
 * which is exactly what makes it safe to run on every PR against `dev`.
 *
 * Usage:
 *   npm run e2e                                  # uses the default port/url
 *   npm run e2e -- --url http://127.0.0.1:4575   # against an already-running server
 *   npm run e2e -- --only language-switch        # run one case
 *   E2E_SKIP=1 npm run e2e                       # skip (exit 0) — documented escape hatch
 *
 * Env:
 *   E2E_SKIP=1            skip entirely with a clear notice (exit 0)
 *   E2E_ALLOW_SKIP=1      exit 0 instead of 1 when the browser binary is missing
 *   PLAYWRIGHT_BROWSERS_PATH  browser cache; auto-detected for this repo (see below)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS_DIR = fileURLToPath(new URL('artifacts/', import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const PORT = Number(process.env.E2E_PORT ?? 4575);
const EXTERNAL_URL = argValue('--url') ?? process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`;
const ONLY = argValue('--only');

// Mirrors `state` in e2e/fake-server.mjs (DEFAULT_SETTINGS + the seeded op-counts).
// Declared here so the ticker assertion can pin the *exact* expected `used / limit`
// text rather than merely "some digit is on screen" — the latter stays green even
// when both budget cells render "NaN / undefined" after an /api/budget shape change.
const FAKE_QUERY_USED = 2;
const FAKE_REGISTER_USED = 0;
const FAKE_QUERY_BUDGET = 100;
const FAKE_REGISTER_BUDGET = 20;

// ── skip switch ────────────────────────────────────────────────────────────────────────
if (process.env.E2E_SKIP === '1') {
  console.log('[e2e] E2E_SKIP=1 — skipping the preview end-to-end suite.');
  process.exit(0);
}

// ── browser cache detection ────────────────────────────────────────────────────────────
// `npm run e2e:install` puts the pinned build in <repo>/.pw-browsers. A candidate only
// counts if it actually holds a Chromium build: a directory created by an interrupted
// download (or by a `PLAYWRIGHT_BROWSERS_PATH` that only ever received helpers such as
// winldd) would otherwise be selected and make the launch fail with a confusing
// "Executable doesn't exist" pointing at the per-user cache.
function hasChromium(dir) {
  try {
    return readdirSync(dir).some((entry) => /^chromium(_headless_shell)?-\d+$/.test(entry));
  } catch {
    return false;
  }
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const candidate of ['.pw-browsers', '.ms-playwright']) {
    const dir = `${REPO_ROOT}${candidate}`;
    if (hasChromium(dir)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
      break;
    }
  }
}

// Imported only AFTER the cache path is decided: Playwright resolves the browser registry
// from `PLAYWRIGHT_BROWSERS_PATH` when its module is first evaluated, so a static import
// would freeze the per-user default before the detection above could run.
const { chromium } = await import('playwright');

// ── tiny assertion helpers (keeps the suite dependency-free: `playwright`, not test-runner) ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Matches the manual "Register now" POST (used to await its response/request). */
const isRunPost = (r) => r.url().includes('/api/targets/') && r.url().endsWith('/run');

async function waitFor(fn, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`,
      );
    }
    await sleep(150);
  }
}

// ── console-error watchdog ─────────────────────────────────────────────────────────────
/**
 * Console errors are a *supplementary* sentinel, not the main one — see the endpoint
 * coverage assertions below, which is what actually proves the app talked to the API
 * successfully.
 *
 * The ignore list is deliberately narrow. An earlier version dropped every
 * "Failed to load resource" and every `net::ERR_`, which also swallowed the exact symptom
 * of a broken backend (`/api/targets` returning 500 renders as "Failed to load resource:
 * the server responded with a status of 500") — the app could be completely broken and the
 * "no console errors" assertion would still pass.
 *
 * What is tolerated, and how it is scoped:
 *   - the Google Fonts stylesheet (index.html loads it; the runner has no external network)
 *     and the favicon (the fixture build ships none) — matched by *host/filename*;
 *   - connection-level `net::ERR_*` failures — but only for an external host. A
 *     `net::ERR_CONNECTION_REFUSED` on `/api/*` is a real failure and must not be swallowed;
 *     the coverage assertions would catch it as a count of 0, but the sentinel should not be
 *     lying about it either.
 *
 * Classification must look at BOTH `msg.text()` and `msg.location().url`, because Chromium
 * does not put the failing URL in the text. Measured:
 *   text:           "Failed to load resource: net::ERR_NAME_NOT_RESOLVED"
 *   location().url: "https://fonts.googleapis.com/css2?family=Inter&display=swap"
 * Matching only the text would leave the offline font failure unfiltered and turn every case
 * red on a runner without external network — the exact environment this list exists for.
 */
const IGNORED_CONSOLE = [/fonts\.googleapis\.com/i, /fonts\.gstatic\.com/i, /favicon/i];
const EXTERNAL_HOST = /^https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//i;

function watchConsole(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const locationUrl = msg.location()?.url ?? '';
    const matches = (re) => re.test(text) || (locationUrl !== '' && re.test(locationUrl));

    if (IGNORED_CONSOLE.some(matches)) return;
    if (/net::ERR_/i.test(text) && matches(EXTERNAL_HOST)) return;
    errors.push(`console.error: ${text}${locationUrl ? ` [${locationUrl}]` : ''}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  // A connection-level failure that never reaches the console would otherwise be silent.
  // Only genuine network errors count — `net::ERR_ABORTED` is what a normal cancelled or
  // superseded request looks like, and it is not an app failure.
  page.on('requestfailed', (request) => {
    const url = request.url();
    const errorText = request.failure()?.errorText ?? '';
    if (EXTERNAL_HOST.test(url)) return;
    if (!errorText.startsWith('net::ERR_') || errorText === 'net::ERR_ABORTED') return;
    errors.push(`requestfailed: ${url} (${errorText})`);
  });
  return errors;
}

// ── endpoint coverage ─────────────────────────────────────────────────────────────────
/**
 * Absolute per-route counters from the fake backend, at the moment of the call.
 *
 * Called from the *runner* rather than from the page: a baseline is needed before a case
 * has navigated anywhere, and a page-level fetch from `about:blank` cannot resolve a
 * relative URL. The probe endpoint exists for the runner's benefit.
 */
async function fetchLedger() {
  const res = await fetch(`${BASE_URL}/api/__requests`);
  if (!res.ok) throw new Error(`coverage probe failed: GET /api/__requests returned ${res.status}`);
  return res.json();
}

function deltaCount(before, after, route) {
  return Math.max(0, (after.routes?.[route]?.count ?? 0) - (before.routes?.[route]?.count ?? 0));
}

/** Failure statuses a route produced *within* this window (counts are cumulative). */
function deltaFailures(before, after, route) {
  const seen = before.routes?.[route]?.statuses ?? {};
  const now = after.routes?.[route]?.statuses ?? {};
  return Object.entries(now)
    .filter(([status, count]) => status >= 400 && count > (seen[status] ?? 0))
    .map(([status]) => Number(status));
}

function renderDelta(before, after) {
  return Object.fromEntries(
    Object.keys(after.routes ?? {})
      .map((route) => [route, deltaCount(before, after, route)])
      .filter(([, count]) => count > 0),
  );
}

/**
 * Asserts the API calls a case depends on, scoped to *that case*.
 *
 * The ledger itself is cumulative (the fake backend outlives every case), so both
 * assertions work on a before/after diff taken around the case:
 *   - `>= N` means "this case issued at least N calls", which a cumulative counter could
 *     not express — an earlier case's traffic would satisfy a later case's minimum;
 *   - a 5xx is only charged to the case that caused it, so one broken endpoint no longer
 *     re-fails every subsequent case with the same message.
 *
 * Liveness of the fake backend is enforced by `fetchLedger()` itself: it throws when the
 * probe request fails or answers non-2xx, so a dead backend fails the case here rather than
 * being misread as "the case never called its endpoints". There is deliberately no separate
 * probe-counter assertion — both snapshots come from `fetchLedger()`, so that delta is
 * always exactly 1 and could never fail.
 */
async function assertEndpoints(expected, before) {
  const after = await fetchLedger();
  const problems = [];

  for (const [route, min] of Object.entries(expected)) {
    const count = deltaCount(before, after, route);
    if (count < min) problems.push(`expected >=${min} call(s) to ${route}, saw ${count}`);
  }
  for (const route of Object.keys(after.routes ?? {})) {
    const failures = deltaFailures(before, after, route);
    if (failures.length) problems.push(`${route} returned ${[...new Set(failures)].join('/')}`);
  }
  const newServerErrors = after.serverErrors.length - before.serverErrors.length;
  if (newServerErrors > 0)
    problems.push(`fake backend produced ${newServerErrors} new 5xx response(s)`);

  assert(
    problems.length === 0,
    `endpoint coverage failed: ${problems.join('; ')} (this case: ${JSON.stringify(renderDelta(before, after))})`,
  );
}

// ── test cases ────────────────────────────────────────────────────────────────────────
const CASES = [
  {
    name: 'home-renders',
    title: 'Home renders title + ticker with no console errors',
    // Endpoints the dashboard must have talked to, with a minimum call count. The counts are
    // *minimums*, not exact matches, so an extra fetch won't fail the case — but each one is
    // justified here, because "why ≥3?" is otherwise unanswerable for the next reader:
    //   targets 1   — DataProvider's initial GET; renders the watched-course list
    //   settings 1  — DataProvider's initial GET; drives the ticker interval + budgets
    //   budget 1    — DataProvider's initial GET; drives the ticker counters
    //   session 1   — DataProvider's initial GET; drives the ticker session cell
    //   scheduler 1 — DataProvider's initial GET; the engine's running state
    // These can legitimately grow (the dashboard live-refetches budget/targets when a stream
    // event arrives); the assertion is that they never shrink or disappear.
    endpoints: {
      '/api/targets': 1,
      '/api/settings': 1,
      '/api/budget': 1,
      '/api/session': 1,
      '/api/scheduler': 1,
    },
    async run({ page, errors }) {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ticker', { timeout: 15_000 });
      await page.waitForSelector('.ticker .cell', { timeout: 15_000 });

      const title = await page.title();
      assert(title.includes('MMAR'), `document title should mention MMAR, got "${title}"`);

      const heading = (await page.locator('h1').first().innerText()).trim();
      assertEqual(heading, 'MMAR', 'h1 brand heading');

      // Guards the locale assumption the rest of this file is written against: if the
      // context ever stops rendering English, every selector below fails with a confusing
      // "input not found" instead of pointing at i18n.
      assertEqual(
        (await page.locator('.nav .pill').first().innerText()).trim(),
        'Dashboard',
        'nav should render in English (context locale)',
      );

      // Ticker content: labels + rendered values for the watched/interval/session cells.
      // The ticker labels are uppercased by CSS (`text-transform`), so compare case-insensitively.
      const tickerText = (await page.locator('.ticker').innerText()).toLowerCase();
      for (const label of [
        'watching',
        'interval',
        'today · query',
        'today · register',
        'session',
      ]) {
        assert(
          tickerText.includes(label),
          `ticker should render the "${label}" cell (got "${tickerText}")`,
        );
      }
      assert(/\d/.test(tickerText), `ticker should render numeric values (got "${tickerText}")`);

      // Budget cells specifically: `used / limit`, both halves real numbers. A bare
      // `/\d/` over the whole ticker passes even when these two cells render
      // "NaN / undefined" (the watching/interval cells supply the digits), which is
      // exactly what happened when the fake backend still served the old
      // `{ query: <remaining>, register: <remaining> }` shape after the snapshot
      // change. Pin the contract here instead of trusting the aggregate match.
      // Regex (not substring) matching so "Today · Query" can't also select the
      // "Today · Register" cell.
      const budgetCell = (label) =>
        page
          .locator('.ticker .cell')
          .filter({ has: page.locator('.k', { hasText: label }) })
          .locator('.v');
      for (const [label, expected] of [
        [/^Today · Query$/i, `${FAKE_QUERY_USED} / ${FAKE_QUERY_BUDGET}`],
        [/^Today · Register$/i, `${FAKE_REGISTER_USED} / ${FAKE_REGISTER_BUDGET}`],
      ]) {
        // Polled, not read once. `Ticker` renders a `— / —` placeholder until the
        // `/api/budget` fetch resolves, and the element is already visible then, so a
        // single `innerText()` races that fetch and fails on a slower CI even though
        // nothing is wrong. (`waitFor` also lets the failure message carry the last
        // observed text rather than just "timed out".)
        const value = await waitFor(async () => {
          const text = (await budgetCell(label).innerText()).trim();
          return /^\d+ \/ \d+$/.test(text) && text === expected ? text : false;
        }, `budget cell "${label}" to render "${expected}" (it renders a placeholder until /api/budget resolves)`);
        assertEqual(value, expected, `budget cell "${label}" value`);
      }

      // The WebSocket stream is up and seeded by the fake backend's `recent` frame.
      await waitFor(
        async () => (await page.locator('.console .bar .t').innerText()).includes('live stream'),
        'console websocket to report "live stream"',
      );
      const logLines = await page.locator('.console .log .ln').count();
      assert(logLines > 0, 'console should show the seeded log events from the fake backend');

      // Dashboard loaded its resources (empty state renders once /api/targets resolves).
      await page.waitForSelector('.empty', { timeout: 15_000 });

      assertEqual(errors.length, 0, `unexpected browser errors: ${errors.join(' | ')}`);
    },
  },
  {
    name: 'add-course',
    title: 'Courses page — adding a course shows it in the list',
    // targets >=2, and the key counts BOTH the GETs and the POST (they share one ledger key,
    // since the route template is derived from the path without the method). So the real
    // traffic is 3: initial list GET (1), POST the new course (1), refetch after the add (1).
    // The minimum stays at 2 rather than 3 on purpose: what must never disappear is the
    // post-add refetch, and pinning the exact number would make the case fail on any future
    // extra fetch. If the refetch stops happening the count drops to 2 and this still passes
    // -- which is why the visible assertion below ("the new course appears in the list") is
    // the real guard for that regression; this endpoint check exists to catch the endpoint
    // erroring or never being called at all.
    endpoints: { '/api/targets': 2, '/api/settings': 1 },
    async run({ page, errors }) {
      await page.goto(`${BASE_URL}/courses`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[aria-label="Term"]', { timeout: 15_000 });

      await page.fill('input[aria-label="Term"]', '202701');
      await page.fill('input[aria-label="Subject"]', 'COMP');
      await page.fill('input[aria-label="Faculty"]', 'Faculty of Science');
      await page.fill('input[aria-label="Course #"]', '551');
      await page.fill('input[aria-label="Target CRN"]', '2347');
      await page.fill('input[aria-label="Label"]', 'COMP 551');
      await page.getByRole('button', { name: 'Add course', exact: true }).click();

      await page.waitForSelector('.cards .card .title', { timeout: 15_000 });
      const titles = await page.locator('.cards .card .title').allInnerTexts();
      assert(
        titles.includes('COMP 551'),
        `course list should contain "COMP 551", got ${JSON.stringify(titles)}`,
      );

      const crn = await page.locator('.cards .card .crn').first().innerText();
      assert(crn.includes('CRN 2347'), `course card should show the CRN, got "${crn}"`);

      // The add form is reset after a successful add (no stale values in the grid).
      assertEqual(
        await page.inputValue('input[aria-label="Term"]'),
        '',
        'term field should reset after add',
      );

      assertEqual(errors.length, 0, `unexpected browser errors: ${errors.join(' | ')}`);
    },
  },
  {
    name: 'run-cooldown-feedback',
    title: 'Dashboard — a dropped "Register now" is visible, and the manual cooldown is throttled',
    // The whole point of the Q16/Q23 fix: the second request inside the manual
    // cooldown must be answered `{started:false, reason:'cooldown'}` and the UI
    // must render that verdict on the card, instead of the button flashing and
    // the click vanishing. This case needs the fake backend to implement the same
    // cooldown contract the real server does — otherwise it would assert UI
    // feedback no backend ever produces.
    //
    // targets >=3: this case's own POST + the list refetch + the dashboard GET.
    endpoints: { '/api/targets': 3, '/api/targets/:id/run': 1 },
    async run({ page, errors }) {
      // The fake backend reports `logged-out` (nothing is logged in), which
      // disables every action button — including the one under test. Opt this
      // case into a truthful-looking session so the click exercises the real
      // path (disabled logic → POST → rendered verdict) instead of a raw fetch.
      await page.request.post(`${BASE_URL}/api/__session`, { data: { status: 'authenticated' } });

      // Add a course of this case's own so its cooldown state is untouched by
      // whatever earlier cases did to their targets.
      await page.goto(`${BASE_URL}/courses`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[aria-label="Term"]', { timeout: 15_000 });
      await page.fill('input[aria-label="Term"]', '202701');
      await page.fill('input[aria-label="Subject"]', 'COMP');
      await page.fill('input[aria-label="Faculty"]', 'Faculty of Science');
      await page.fill('input[aria-label="Course #"]', '551');
      await page.fill('input[aria-label="Target CRN"]', '2347');
      await page.fill('input[aria-label="Label"]', 'W6 COOLDOWN');
      await page.getByRole('button', { name: 'Add course', exact: true }).click();
      await page.waitForSelector('text=W6 COOLDOWN', { timeout: 15_000 });

      await page.getByRole('link', { name: 'Dashboard' }).click();
      const card = page.locator('.cards .card').filter({ hasText: 'W6 COOLDOWN' });
      await card.getByRole('button', { name: '⚡ Register now' }).waitFor({ timeout: 15_000 });

      // First accepted run: the button shows the in-flight label, then returns.
      // Acceptance itself already starts the window, so the button must go
      // straight to disabled — not stay clickable until a rejection teaches it.
      const firstResponse = page.waitForResponse(isRunPost);
      await card.getByRole('button', { name: '⚡ Register now' }).click();
      const firstBody = await (await firstResponse).json();
      assertEqual(firstBody.started, true, 'first manual run should be accepted');
      // The countdown is driven by this duration, anchored on the client's own
      // clock — not by subtracting a server epoch from `Date.now()`.
      assertEqual(firstBody.retryAfterMs, 60_000, 'an accepted run reports the full window');
      const notice = card.getByTestId('run-notice');
      await notice.waitFor({ timeout: 15_000 });
      assert(
        /Try again in \d+s/i.test(await notice.innerText()),
        `an accepted run should show the cooldown immediately, got "${await notice.innerText()}"`,
      );

      // Second click inside the cooldown window: the button must already be
      // disabled, so drive the request directly to pin the contract too.
      await waitFor(
        async () => await card.locator('button.btn-accent').isDisabled(),
        'the run button to be disabled for the rest of the cooldown',
      );
      const noticeBefore = await notice.innerText();
      await waitFor(
        async () => (await notice.innerText()) !== noticeBefore,
        'the cooldown notice to count down instead of staying frozen',
      );
      const noticeText = await notice.innerText();
      assert(
        /throttled to one per minute/i.test(noticeText),
        `the cooldown verdict should be visible on the card, got "${noticeText}"`,
      );
      const shownSecs = Number(/Try again in (\d+)s/i.exec(noticeText)?.[1]);
      assert(
        Number.isFinite(shownSecs) && shownSecs > 0 && shownSecs <= 60,
        `the cooldown notice should count down the remaining seconds, got "${noticeText}"`,
      );

      // The contract itself, straight from the endpoint the app just called.
      const targets = await (await page.request.get(`${BASE_URL}/api/targets`)).json();
      const created = targets.find((t) => t.label === 'W6 COOLDOWN');
      assert(created, 'the case should have created its own target');
      const repeat = await page.request.post(`${BASE_URL}/api/targets/${created.id}/run`);
      const body = await repeat.json();
      assertEqual(body.started, false, 'a repeat manual run inside the cooldown must not start');
      assertEqual(body.reason, 'cooldown', 'repeat manual run reason');
      assert(
        typeof body.retryAfterMs === 'number' &&
          body.retryAfterMs > 0 &&
          body.retryAfterMs <= 60_000,
        `retryAfterMs should be the remaining cooldown, got ${JSON.stringify(body.retryAfterMs)}`,
      );
      // The window's start is echoed too, so the UI counts down from the server's
      // clock. A fresh GET must report the same value (the store is the authority).
      assert(
        typeof created.lastForcedRunAt === 'number' &&
          body.lastForcedRunAt === created.lastForcedRunAt,
        `lastForcedRunAt should be the stored start of the window, got ${JSON.stringify(body.lastForcedRunAt)} vs ${JSON.stringify(created.lastForcedRunAt)}`,
      );

      assertEqual(errors.length, 0, `unexpected browser errors: ${errors.join(' | ')}`);
    },
  },
  {
    name: 'settings-persist',
    title: 'Settings page — poll interval saves and survives a reload',
    // settings ≥4: initial GET (1) + the PUT that saves the new interval (1) + the
    // explicit refetch Settings.tsx performs after a successful save (1) + the GET after
    // the page reload (1). Fewer than 4 means the save never reached the server, or the
    // reload did not re-read it — i.e. the value shown afterwards is stale local state.
    endpoints: { '/api/settings': 4 },
    async run({ page, errors }) {
      const NEW_INTERVAL = 17;

      await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
      const pollInput = 'input[aria-label="Poll interval (min)"]';
      await page.waitForSelector(pollInput, { timeout: 15_000 });

      assertEqual(await page.inputValue(pollInput), '30', 'default poll interval');
      assertEqual(await page.inputValue('input[aria-label="Jitter (min)"]'), '3', 'default jitter');

      await page.fill(pollInput, String(NEW_INTERVAL));
      await page.getByRole('button', { name: 'Save settings' }).click();

      await page.waitForSelector('text=Saved ✓', { timeout: 15_000 });

      // Reload: the value must come back from the API, not from a form default.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(pollInput, { timeout: 15_000 });
      await waitFor(
        async () => (await page.inputValue(pollInput)) === String(NEW_INTERVAL),
        'poll interval to persist across a reload',
      );

      // The ticker reads the same setting, so it must show the new cadence too.
      const tickerText = await page.locator('.ticker').innerText();
      assert(
        tickerText.includes(String(NEW_INTERVAL)),
        `ticker should show interval ${NEW_INTERVAL}, got "${tickerText}"`,
      );

      assertEqual(errors.length, 0, `unexpected browser errors: ${errors.join(' | ')}`);
    },
  },
  {
    name: 'language-switch',
    title: 'Language switch — zh → en → fr each render the nav copy',
    // targets ≥1: the initial DataProvider GET. Language switching is purely client-side,
    // so this exists to prove the page really loaded the app shell rather than to check
    // any i18n-specific traffic.
    endpoints: { '/api/targets': 1 },
    async run({ page, errors }) {
      const languageButton = (label) => page.getByRole('button', { name: label, exact: true });

      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.nav .pill', { timeout: 15_000 });

      await languageButton('中文').click();
      await waitFor(
        async () => (await page.locator('.nav .pill').first().innerText()) === '主控台',
        'zh nav copy',
      );

      await languageButton('EN').click();
      await waitFor(
        async () => (await page.locator('.nav .pill').first().innerText()) === 'Dashboard',
        'en nav copy',
      );
      const en = await page.locator('.nav').first().innerText();
      for (const label of ['Dashboard', 'Courses', 'Session', 'Settings']) {
        assert(en.includes(label), `en nav should include "${label}", got "${en}"`);
      }

      await languageButton('FR').click();
      await waitFor(
        async () => (await page.locator('.nav .pill').first().innerText()) === 'Tableau de bord',
        'fr nav copy',
      );
      const fr = await page.locator('.nav').first().innerText();
      for (const label of ['Tableau de bord', 'Cours', 'Session', 'Paramètres']) {
        assert(fr.includes(label), `fr nav should include "${label}", got "${fr}"`);
      }

      // The heading is translated too — proves the whole page re-rendered, not just a swap.
      await page.getByRole('link', { name: 'Cours' }).click();
      await waitFor(
        async () => (await page.locator('h2').first().innerText()) === 'Ajouter un cours',
        'fr courses heading',
      );

      assertEqual(errors.length, 0, `unexpected browser errors: ${errors.join(' | ')}`);
    },
  },
];

// ── fake backend lifecycle ────────────────────────────────────────────────────────────
function startFakeServer() {
  console.log(`[e2e] starting fake backend on port ${PORT} ...`);
  return spawn(process.execPath, [`${REPO_ROOT}e2e/fake-server.mjs`, '--port', String(PORT)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
    await sleep(300);
  }
}

function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  try {
    server.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────
function writeSummary(results, startedAt, extra = {}) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const durationMs = Date.now() - startedAt;
  const failed = results.filter((r) => r.status === 'failed').length;

  writeFileSync(
    `${ARTIFACTS_DIR}summary.json`,
    `${JSON.stringify(
      {
        baseUrl: BASE_URL,
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        passed: results.length - failed,
        failed,
        skipped: extra.skipped ?? false,
        note: extra.note ?? null,
        results,
      },
      null,
      2,
    )}\n`,
  );

  const lines = [];
  lines.push('<!-- section:preview-e2e -->', '## :theater: Preview end-to-end (Playwright)');
  lines.push('');
  if (extra.skipped) {
    lines.push(`:warning: **Skipped** — ${extra.note ?? 'skipped'}`);
    writeFileSync(`${ARTIFACTS_DIR}summary.md`, `${lines.join('\n')}\n`);
    return failed;
  }
  lines.push(
    failed === 0
      ? `:white_check_mark: **All ${results.length} end-to-end checks passed** (${(durationMs / 1000).toFixed(1)}s)`
      : `:x: **${failed}/${results.length} end-to-end checks failed** (${(durationMs / 1000).toFixed(1)}s)`,
  );
  lines.push('');
  lines.push('| Check | Result | Time |');
  lines.push('|---|---|---|');
  for (const r of results) {
    const icon = r.status === 'passed' ? ':white_check_mark:' : ':x:';
    lines.push(
      `| ${r.title} | ${icon} ${r.status}${r.error ? ` — ${r.error}` : ''} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push('');
  lines.push(
    `Ran the production bundle against an in-memory fake API (no Minerva session, no scheduler). Screenshots and traces: \`preview-e2e-artifacts\` artifact.`,
  );
  writeFileSync(`${ARTIFACTS_DIR}summary.md`, `${lines.join('\n')}\n`);
  return failed;
}

async function main() {
  const startedAt = Date.now();
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let server;
  if (!EXTERNAL_URL) {
    server = startFakeServer();
    try {
      await waitForServer(BASE_URL);
    } catch (err) {
      stopServer(server);
      console.error(`[e2e] ${err.message}`);
      process.exit(1);
    }
  }

  const selected = ONLY ? CASES.filter((c) => c.name === ONLY) : CASES;
  if (!selected.length) {
    stopServer(server);
    console.error(
      `[e2e] no test case named "${ONLY}". Available: ${CASES.map((c) => c.name).join(', ')}`,
    );
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    stopServer(server);
    const hint = [
      `[e2e] could not launch Chromium: ${err.message.split('\n')[0]}`,
      '[e2e] install the pinned build with: npm run e2e:install',
      '[e2e] (locally you can also set PLAYWRIGHT_BROWSERS_PATH to an existing cache)',
    ].join('\n');
    if (process.env.E2E_ALLOW_SKIP === '1') {
      console.warn(`${hint}\n[e2e] E2E_ALLOW_SKIP=1 — continuing without running the suite.`);
      writeSummary([], startedAt, {
        skipped: true,
        note: 'Chromium unavailable and E2E_ALLOW_SKIP=1',
      });
      process.exit(0);
    }
    console.error(hint);
    writeSummary([], startedAt, { skipped: true, note: 'Chromium unavailable' });
    process.exit(1);
  }

  console.log(`[e2e] Chromium ${browser.version()} → ${BASE_URL}`);
  const results = [];

  for (const testCase of selected) {
    const caseStart = Date.now();
    // Fixed locale + English strings throughout: the app picks its initial language from
    // `navigator.language` (packages/web/src/i18n), so an unpinned context renders in
    // whatever the host happens to be set to (a zh-CN runner renders 中文 and every
    // English selector below would miss). `language-switch` is what covers zh/en/fr.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    const errors = watchConsole(page);
    const result = { name: testCase.name, title: testCase.title, status: 'passed', durationMs: 0 };
    try {
      // Snapshot the cumulative ledger before the case runs so its coverage assertions can
      // be scoped to this case's own traffic (see assertEndpoints). At this point the page is
      // still `about:blank`, so the snapshot cannot include this case's traffic.
      //
      // Inside the try on purpose: if the fake backend died between cases, `fetchLedger()`
      // throws, and this becomes a normal per-case failure with a screenshot and a written
      // summary — instead of aborting the whole run before any artifact exists.
      const ledgerBefore = await fetchLedger();
      await testCase.run({ page, context, errors });
      // Runs after the case's own assertions so the ledger has seen every call the case
      // makes — including the ones triggered by a page reload.
      if (testCase.endpoints) {
        await assertEndpoints(testCase.endpoints, ledgerBefore);
        result.endpoints = testCase.endpoints;
      }
      console.log(`  ✓ ${testCase.name} — ${testCase.title}`);
    } catch (err) {
      result.status = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${testCase.name} — ${result.error}`);
      try {
        await page.screenshot({
          path: `${ARTIFACTS_DIR}${testCase.name}-failure.png`,
          fullPage: true,
        });
      } catch {
        /* screenshot is best-effort */
      }
    }
    try {
      await page.screenshot({ path: `${ARTIFACTS_DIR}${testCase.name}.png`, fullPage: true });
    } catch {
      /* best-effort */
    }
    try {
      await context.tracing.stop({ path: `${ARTIFACTS_DIR}trace-${testCase.name}.zip` });
    } catch {
      /* best-effort */
    }
    result.durationMs = Date.now() - caseStart;
    results.push(result);
    await context.close();
  }

  await browser.close();
  stopServer(server);

  const failed = writeSummary(results, startedAt);
  console.log(
    `[e2e] ${results.length - failed}/${results.length} passed. Artifacts: ${ARTIFACTS_DIR}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e] unexpected failure:', err);
  process.exit(1);
});
