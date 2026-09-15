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
 *   npm run gates                      # lint → typecheck → prettier(changed) → test → build:web
 *   npm run gates -- --base origin/dev # diff against an explicit base for the prettier step
 *   npm run gates -- --e2e             # also run the preview end-to-end suite
 *   npm run gates -- --only lint,test  # run a subset (comma-separated gate ids)
 *
 * Every gate runs even after an earlier one fails, so one invocation reports the complete
 * picture. Exit code is 1 if any gate failed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
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

const baseRef = resolveBaseRef(argValue('--base'));

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

const only = argValue('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function runGate(gate) {
  return new Promise((resolve) => {
    const [cmd, args] = gate.command;
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
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
