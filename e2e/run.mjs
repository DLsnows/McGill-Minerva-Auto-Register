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
/** Failures that are environmental, not app bugs: the headless runner has no network
 * access to Google Fonts, so the font stylesheet fetch reports "Failed to load resource".
 * The app itself must never log an error or throw. */
const IGNORED_CONSOLE = [/Failed to load resource/i, /net::ERR_/i, /favicon/i];

function watchConsole(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// ── test cases ────────────────────────────────────────────────────────────────────────
const CASES = [
  {
    name: 'home-renders',
    title: 'Home renders title + ticker with no console errors',
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
    name: 'settings-persist',
    title: 'Settings page — poll interval saves and survives a reload',
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
      await testCase.run({ page, context, errors });
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
