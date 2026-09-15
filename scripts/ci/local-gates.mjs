#!/usr/bin/env node
/**
 * Local quality gate — the same checks `ci.yml` runs on PRs whose base is a long-lived
 * branch, but on your machine and on the *working tree* rather than the pushed commit.
 *
 * This is the gate for sub-task branches: a `feat/*` PR based on another feature branch
 * deliberately does not trigger the full CI matrix (see docs/CI.md), so this script is
 * what proves the branch is green before it is handed over.
 *
 * Usage:
 *   npm run gates                       # lint → typecheck → prettier(changed) → test → build:web
 *   npm run gates -- --e2e              # also run the preview end-to-end suite
 *   npm run gates -- --only lint,test   # run a subset (comma-separated gate ids)
 *   BASE_REF=origin/dev npm run gates   # explicit base for the prettier step
 *
 * NOTE on `--base`: npm 11 parses `--base <value>` itself (it looks like an npm config
 * flag), so `npm run gates -- --base origin/dev` reaches this script as a bare positional
 * and leaks `npm_config_base` into every child process. Both spellings are accepted here —
 * the positional form repairs the npm behaviour — but `BASE_REF=...` is the documented one.
 *
 * Every gate runs even after an earlier one fails, so one invocation reports the complete
 * picture. Exit code is 1 if any gate failed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const isWindows = process.platform === 'win32';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** First bare positional argument (npm turns `--base x` into just `x`). */
function positionalArg() {
  return process.argv.slice(2).find((arg) => !arg.startsWith('-'));
}

const BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/dev',
  'origin/staging',
  'origin/prod',
  'origin/main',
  'origin/master',
  'HEAD~1',
];

function resolveBaseRef(explicit) {
  const candidates = [explicit, process.env.BASE_REF, ...BASE_CANDIDATES].filter(Boolean);
  for (const ref of candidates) {
    const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (probe.status === 0) return ref;
  }
  return null;
}

const baseRef = resolveBaseRef(argValue('--base') ?? positionalArg());

const GATES = [
  {
    id: 'lint',
    label: 'ESLint',
    command: ['npm', ['run', 'lint']],
  },
  {
    id: 'typecheck',
    label: 'TypeScript type check',
    command: ['npm', ['run', 'typecheck']],
  },
  {
    id: 'format:changed',
    label: `Prettier (files changed vs ${baseRef ?? 'unknown'})`,
    command: [
      'node',
      ['scripts/ci/format-check-changed.mjs', ...(baseRef ? ['--base', baseRef] : [])],
    ],
    enabled: Boolean(baseRef),
    skipReason: 'no base revision could be resolved — pass --base <ref> or set BASE_REF',
  },
  {
    id: 'ci-script-tests',
    label: 'CI script policy tests (prettier new-violation policy)',
    command: ['npm', ['run', 'test:ci-scripts']],
  },
  {
    id: 'test',
    label: 'Unit tests (vitest)',
    command: ['npm', ['test']],
  },
  {
    id: 'build:web',
    label: 'Web production build',
    command: ['npm', ['run', 'build:web']],
  },
  {
    id: 'e2e',
    label: 'Preview end-to-end (Playwright, fake backend)',
    command: ['npm', ['run', 'e2e']],
    enabled: process.argv.includes('--e2e'),
    skipReason: 'pass --e2e to include it (it needs a Chromium build: npm run e2e:install)',
  },
];

const only = (
  argValue('--only') ??
  // npm parses `--only a,b` itself as well, leaving a bare positional behind.
  process.argv.slice(2).find((arg) => arg.includes(','))
)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function runGate(gate) {
  return new Promise((resolve) => {
    const [cmd, args] = gate.command;
    // Scrub npm's own `npm_config_base` (left behind by `npm run gates -- --base <ref>`,
    // which npm parses as a config flag) so it cannot leak into child npm invocations and
    // make them warn. The resolved `baseRef` is passed down explicitly instead.
    const env = { ...process.env };
    delete env.npm_config_base;
    if (baseRef) env.BASE_REF = baseRef;

    // On Windows `npm` is a `.cmd` shim, so it must go through a shell — but passing an
    // args array *with* `shell: true` is deprecated (DEP0190: args are concatenated, not
    // escaped). Building the command line explicitly avoids the warning and keeps the
    // escaping obvious; there is no user input in these fixed command strings.
    const child = isWindows
      ? spawn([cmd, ...args].join(' '), { cwd: REPO_ROOT, stdio: 'inherit', shell: true, env })
      : spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', env });

    const started = Date.now();
    child.on('error', (err) =>
      resolve({ gate, ok: false, ms: Date.now() - started, error: err.message }),
    );
    child.on('close', (code) => resolve({ gate, ok: code === 0, ms: Date.now() - started, code }));
  });
}

const line = '─'.repeat(72);

async function main() {
  const selected = GATES.filter((g) => !only || only.includes(g.id));
  if (!selected.length) {
    console.error(`[gates] no gate matched --only=${only?.join(',')}`);
    console.error(`[gates] available: ${GATES.map((g) => g.id).join(', ')}`);
    process.exit(1);
  }

  console.log(line);
  console.log('  LOCAL GATES — same checks as .github/workflows/ci.yml');
  console.log(`  repo: ${REPO_ROOT}`);
  console.log(`  prettier base ref: ${baseRef ?? '(unresolved — that step will be skipped)'}`);
  console.log(`  running: ${selected.map((g) => g.id).join(', ')}`);
  console.log(line);

  const results = [];
  for (const gate of selected) {
    console.log('');
    console.log(line);
    console.log(`▶ ${gate.id} — ${gate.label}`);
    console.log(line);
    if (gate.enabled === false) {
      console.log(`⏭  skipped: ${gate.skipReason}`);
      results.push({
        id: gate.id,
        label: gate.label,
        status: 'skipped',
        ms: 0,
        note: gate.skipReason,
      });
      continue;
    }
    const res = await runGate(gate);
    results.push({
      id: gate.id,
      label: gate.label,
      status: res.ok ? 'passed' : 'failed',
      ms: res.ms,
      note: res.error,
    });
    console.log(
      `${res.ok ? '✔' : '✖'} ${gate.id} ${res.ok ? 'passed' : 'failed'} (${(res.ms / 1000).toFixed(1)}s)`,
    );
  }

  const failed = results.filter((r) => r.status === 'failed');
  console.log('');
  console.log(line);
  console.log('  SUMMARY');
  console.log(line);
  for (const r of results) {
    const icon = r.status === 'passed' ? '✅' : r.status === 'skipped' ? '⏭️' : '❌';
    console.log(
      `  ${icon}  ${r.id.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s${r.note ? `  — ${r.note}` : ''}`,
    );
  }
  console.log(line);
  console.log(
    failed.length
      ? `  ❌ ${failed.length} gate(s) failed: ${failed.map((r) => r.id).join(', ')}`
      : `  ✅ all ${results.filter((r) => r.status === 'passed').length} executed gate(s) passed`,
  );
  if (!process.argv.includes('--e2e')) {
    console.log(
      '  ℹ️  e2e was not run — add `-- --e2e` (after `npm run e2e:install`) to include it.',
    );
  }
  console.log(line);

  if (process.env.CI_REPORT_PATH) {
    writeFileSync(
      process.env.CI_REPORT_PATH,
      `${JSON.stringify({ baseRef, results, ok: failed.length === 0 }, null, 2)}\n`,
    );
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[gates] unexpected failure:', err);
  process.exit(1);
});
