#!/usr/bin/env node
/**
 * Lighthouse audit for the built web bundle, served locally.
 *
 * Deliberately NOT treosh/lighthouse-ci-action: this repository's Actions allow-list is
 * narrow, and a plain script keeps the threshold policy and the SPA routing explicit and
 * reviewable. Lighthouse itself is invoked through `npx lighthouse@12` (no new dependency).
 *
 * Policy: informational by default. Scores are posted as a PR comment + artifact, but the
 * step does not fail. Flip `--enforce` (or env `LH_ENFORCE=1`) — or GitHub repo variable
 * `LIGHTHOUSE_ENFORCE=1` — to turn the thresholds below into a gate.
 *
 * Usage:
 *   node scripts/ci/lighthouse.mjs [--url http://127.0.0.1:4580] [--enforce]
 *                                  [--min-performance 70] [--min-accessibility 90]
 *                                  [--min-best-practices 90] [--routes /,/courses]
 * Env:
 *   LH_BASE_URL, LH_ENFORCE, LH_MIN_PERFORMANCE, LH_MIN_ACCESSIBILITY,
 *   LH_MIN_BEST_PRACTICES, LH_OUT_DIR, LH_PORT, LH_CHROME_PATH
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_OUT_DIR = fileURLToPath(new URL('../../lighthouse-reports/', import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = num(process.env.LH_PORT, 4580);
const EXTERNAL_URL = argValue('--url') ?? process.env.LH_BASE_URL;
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`;
const OUT_DIR = argValue('--out-dir') ?? process.env.LH_OUT_DIR ?? DEFAULT_OUT_DIR;
const ROUTES = (argValue('--routes') ?? '/,/courses,/session,/settings')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const LIGHTHOUSE_VERSION = process.env.LH_VERSION ?? '12';

// Thresholds are 0..100. Performance has no meaningful score on client-routed pages other
// than the first load, so it is only enforced on `/`; accessibility / best-practices apply
// to every route.
const THRESHOLDS = {
  performance: num(argValue('--min-performance') ?? process.env.LH_MIN_PERFORMANCE, 70),
  accessibility: num(argValue('--min-accessibility') ?? process.env.LH_MIN_ACCESSIBILITY, 90),
  bestPractices: num(argValue('--min-best-practices') ?? process.env.LH_MIN_BEST_PRACTICES, 90),
  enforce:
    argValue('--enforce') !== undefined ||
    ['1', 'true'].includes(String(process.env.LH_ENFORCE).toLowerCase()),
};

const CATEGORIES = ['performance', 'accessibility', 'best-practices'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort Chrome discovery so a failure is reported as a clear message instead of a
 * stack trace from chrome-launcher. Lighthouse launches Chrome itself. */
function findChrome() {
  if (process.env.LH_CHROME_PATH && existsSync(process.env.LH_CHROME_PATH))
    return process.env.LH_CHROME_PATH;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  return candidates.find((c) => c && existsSync(c));
}

function startStaticServer(port, root) {
  console.log(`[lighthouse] serving ${root} on port ${port} ...`);
  return spawn(
    process.execPath,
    [`${REPO_ROOT}e2e/fake-server.mjs`, '--port', String(port), '--web-dist', root],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );
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

function runLighthouse(url, outputPath) {
  const args = [
    '--yes',
    `lighthouse@${LIGHTHOUSE_VERSION}`,
    url,
    `--only-categories=${CATEGORIES.join(',')}`,
    '--output=json',
    '--output-path',
    outputPath,
    '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
    '--quiet',
  ];
  const res = spawnSync('npx', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    shell: process.platform === 'win32',
    env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH ?? chromePath ?? '' },
  });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n');
    // A non-zero exit does not always mean "no data": chrome-launcher's temp-profile
    // cleanup can throw *after* the report was written (observed on Windows as an ENOENT
    // from `Launcher.destroyTmp`). If a readable report exists, use it and warn — dropping
    // a completed audit over a teardown race helps nobody.
    if (existsSync(outputPath)) {
      console.warn(
        `[lighthouse] ${url}: exit ${res.status} after the report was written — using the report.`,
      );
      return {
        ok: true,
        degraded: `lighthouse exited with ${res.status} after writing the report`,
      };
    }
    return {
      ok: false,
      error: `lighthouse exited with ${res.status}${detail ? `\n${detail}` : ''}`,
    };
  }
  return { ok: true };
}

function scoresFrom(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const score = (id) => {
    const value = report.categories?.[id]?.score;
    return typeof value === 'number' ? Math.round(value * 100) : null;
  };
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
  };
}

function violation(route, scores) {
  const problems = [];
  const check = (label, value, min) => {
    if (value !== null && value < min) problems.push(`${label} ${value} < ${min}`);
  };
  check('accessibility', scores.accessibility, THRESHOLDS.accessibility);
  check('best-practices', scores.bestPractices, THRESHOLDS.bestPractices);
  // Only the entry document produces a meaningful performance score for an SPA.
  if (route === '/') check('performance', scores.performance, THRESHOLDS.performance);
  return problems;
}

function emoji(score) {
  if (score === null) return '⚠️';
  if (score >= 90) return '🟢';
  if (score >= 50) return '🟠';
  return '🔴';
}

function cell(score) {
  return score === null ? '⚠️ n/a' : `${emoji(score)} ${score}`;
}

function writeReport(results, startedAt) {
  mkdirSync(OUT_DIR, { recursive: true });
  const violations = results.flatMap((r) => (r.problems ?? []).map((p) => `${r.route}: ${p}`));
  const auditMs = Date.now() - startedAt;

  writeFileSync(
    `${OUT_DIR}summary.json`,
    `${JSON.stringify(
      {
        baseUrl: BASE_URL,
        thresholds: THRESHOLDS,
        violations,
        results,
        reportedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const lines = [];
  lines.push('<!-- section:lighthouse -->', '## ⚡ Lighthouse (preview)');
  lines.push('');
  lines.push(
    THRESHOLDS.enforce
      ? `Audited \`${BASE_URL}\` — **enforcing** thresholds (perf ≥ ${THRESHOLDS.performance} on \`/\`, a11y ≥ ${THRESHOLDS.accessibility}, best-practices ≥ ${THRESHOLDS.bestPractices}).`
      : `Audited \`${BASE_URL}\` — **informational only**, this does not block the PR.`,
  );
  lines.push('');
  lines.push('| Route | Performance | Accessibility | Best Practices |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    if (r.error) {
      lines.push(`| \`${r.route}\` | ⚠️ audit failed | — | — |`);
      continue;
    }
    lines.push(
      `| \`${r.route}\` | ${cell(r.scores.performance)} | ${cell(r.scores.accessibility)} | ${cell(r.scores.bestPractices)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Audit finished in ${(auditMs / 1000).toFixed(0)}s. Full JSON reports: \`lighthouse-reports\` artifact.`,
  );
  const degraded = results.filter((r) => r.degraded);
  if (degraded.length) {
    lines.push('');
    lines.push(
      `> ⚠️ ${degraded.length} audit(s) finished with a non-zero exit *after* the report was written (Chrome teardown race, usually on Windows). The scores above are still valid: ${degraded.map((r) => `\`${r.route}\``).join(', ')}.`,
    );
  }
  lines.push('');
  lines.push(
    '<details><summary>Why this is informational, and how to turn it into a gate</summary>',
    '',
    'This is the first Lighthouse run in this repository, so absolute scores are not yet a known-good baseline.',
    '',
    '- Make it blocking: add `--enforce` to the Lighthouse step, or set the repo variable `LIGHTHOUSE_ENFORCE=1`.',
    '- Change the bars: `--min-performance <n>`, `--min-accessibility <n>`, `--min-best-practices <n>` (or the matching `LH_MIN_*` env vars).',
    '- Re-run locally: `npm run lighthouse` (optionally `-- --url http://127.0.0.1:4580`).',
    '- Re-run in CI: a PR only triggers this on `opened`, so push a new commit or open a fresh PR.',
    '',
    '</details>',
  );
  for (const r of results) {
    if (!r.error) continue;
    lines.push('');
    lines.push(
      `<details><summary>Audit error — \`${r.route}\`</summary>`,
      '',
      '```',
      r.error,
      '```',
      '</details>',
    );
  }
  writeFileSync(`${OUT_DIR}summary.md`, `${lines.join('\n')}\n`);

  return violations;
}

let chromePath;

async function main() {
  const startedAt = Date.now();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const webDist = `${REPO_ROOT}packages/web/dist`;
  const indexPath = `${webDist}/index.html`;
  if (!existsSync(indexPath)) {
    console.error(`[lighthouse] no web build at ${indexPath} — run \`npm run build:web\` first.`);
    process.exit(1);
  }
  // `vite preview` / static hosting must answer a deep link with index.html for the SPA
  // router to work; verify that contract up front instead of auditing a 404.
  const firstRoute = ROUTES[0];
  if (!EXTERNAL_URL && firstRoute !== '/') {
    console.warn(
      `[lighthouse] first route is ${firstRoute}; make sure the SPA fallback is in place.`,
    );
  }

  chromePath = findChrome();
  if (chromePath) {
    process.env.CHROME_PATH = chromePath;
    console.log(`[lighthouse] Chrome: ${chromePath}`);
  } else {
    console.warn(
      '[lighthouse] no Chrome/Chromium found on the usual paths — relying on chrome-launcher discovery.',
    );
  }

  let server;
  if (!EXTERNAL_URL) {
    server = startStaticServer(PORT, webDist);
    try {
      await waitForServer(BASE_URL);
    } catch (err) {
      stopServer(server);
      console.error(`[lighthouse] ${err.message}`);
      process.exit(1);
    }
    // Prove the SPA fallback before spending minutes on audits.
    const deep = await fetch(`${BASE_URL}/courses`);
    const html = await deep.text();
    if (!deep.ok || !html.includes('<div id="root">')) {
      stopServer(server);
      console.error(
        `[lighthouse] /courses did not return the SPA shell (status ${deep.status}) — check the fallback.`,
      );
      process.exit(1);
    }
  }

  const results = [];
  for (const route of ROUTES) {
    const slug = route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const reportPath = `${OUT_DIR}lighthouse-${slug}.json`;
    const url = `${BASE_URL}${route}`;
    console.log(`[lighthouse] auditing ${url} ...`);
    const res = runLighthouse(url, reportPath);
    if (!res.ok) {
      console.error(`[lighthouse] ${route} failed: ${res.error}`);
      results.push({ route, error: res.error, report: null });
      continue;
    }
    try {
      const scores = scoresFrom(reportPath);
      const problems = violation(route, scores);
      results.push({
        route,
        scores,
        problems,
        report: `lighthouse-${slug}.json`,
        degraded: res.degraded,
      });
      console.log(
        `[lighthouse] ${route} → perf ${scores.performance} / a11y ${scores.accessibility} / bp ${scores.bestPractices}`,
      );
    } catch (err) {
      results.push({ route, error: `could not read the report: ${err.message}`, report: null });
    }
  }

  stopServer(server);
  const violations = writeReport(results, startedAt);

  const auditErrors = results.filter((r) => r.error).length;
  if (violations.length && THRESHOLDS.enforce) {
    console.error(`[lighthouse] threshold violations:\n  - ${violations.join('\n  - ')}`);
    process.exit(1);
  }
  if (auditErrors === ROUTES.length) {
    console.error('[lighthouse] every audit failed — treating that as a hard failure.');
    process.exit(1);
  }
  if (violations.length) {
    console.warn(
      `[lighthouse] ${violations.length} threshold violation(s), not enforced (informational mode).`,
    );
  }
  console.log(`[lighthouse] report written to ${OUT_DIR}summary.md`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[lighthouse] unexpected failure:', err);
  process.exit(1);
});
