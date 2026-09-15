#!/usr/bin/env node
/**
 * Behavioural test for the promotion gate in `.github/workflows/branch-gate.yml`.
 *
 * The gate *is* shell, so the honest way to test it is to run it. Rather than copying the
 * rules into a second file (which would silently drift from the workflow), this test
 * **extracts the `run:` script straight out of the YAML** at test time, substitutes the
 * `${{ ... }}` expressions with fixture values, and executes it with `bash` for a matrix of
 * (base, head, head-repo) triples.
 *
 * The case that motivated this file: Dependabot branches (`dependabot/npm_and_yarn/...`)
 * must be allowed to merge into `dev`, otherwise every dependency PR is guaranteed to fail
 * the gate while still burning a full CI run.
 *
 * Usage: npm run test:ci-scripts
 * Skips (exit 0 with a notice) when no `bash` is available — CI runs on Linux, where the
 * script itself is the thing being tested.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOW = `${REPO_ROOT}.github/workflows/branch-gate.yml`;
const THIS_REPO = 'DLsnows/McGill-Minerva-Auto-Register';
const FORK = 'attacker/McGill-Minerva-Auto-Register';

function findBash() {
  const candidates = [
    '/usr/bin/bash',
    '/bin/bash',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const bash = findBash();
if (!bash) {
  console.log('[test-ci-scripts] branch gate: no bash found — skipping (CI runs on Linux).');
  process.exit(0);
}

/** The `run:` body of the gate step, read from the workflow so it cannot drift. */
function gateScript() {
  const doc = load(readFileSync(WORKFLOW, 'utf8'));
  const steps = doc?.jobs?.['branch-gate']?.steps ?? [];
  const step = steps.find((s) => s.name === 'Check source branch');
  if (!step?.run)
    throw new Error('could not find the "Check source branch" step in branch-gate.yml');
  // Replace the GitHub expressions with the env vars the test sets.
  return step.run
    .replaceAll('${{ github.base_ref }}', '${BASE}')
    .replaceAll('${{ github.head_ref }}', '${HEAD}')
    .replaceAll('${{ github.event.pull_request.head.repo.full_name }}', '${HEAD_REPO}')
    .replaceAll('${{ github.repository }}', '${THIS_REPO}');
}

function runGate(script, base, head, headRepo = THIS_REPO) {
  try {
    const stdout = execFileSync(bash, ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, BASE: base, HEAD: head, HEAD_REPO: headRepo, THIS_REPO },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// [base, head, headRepo, expected, why]
const CASES = [
  // ── the promotion chain ────────────────────────────────────────────────────────────
  ['dev', 'feat/ci-quality-gates', THIS_REPO, 0, 'feature branch -> dev'],
  ['dev', 'feature/thing', THIS_REPO, 0, 'legacy feature/* prefix -> dev'],
  [
    'dev',
    'dependabot/npm_and_yarn/fastify-5.12.4',
    THIS_REPO,
    0,
    'Dependabot -> dev (must be allowed)',
  ],
  ['dev', 'dependabot/npm_and_yarn/multi-2181bdc769', THIS_REPO, 0, 'grouped Dependabot -> dev'],
  ['dev', 'chore/cleanup', THIS_REPO, 1, 'arbitrary branch -> dev is rejected'],
  ['dev', 'dev', THIS_REPO, 1, 'dev -> dev is rejected'],

  ['staging', 'dev', THIS_REPO, 0, 'dev -> staging'],
  ['staging', 'feat/x', THIS_REPO, 1, 'feature branch cannot skip straight to staging'],
  ['staging', 'prod', THIS_REPO, 1, 'prod -> staging is rejected'],

  ['prod', 'dev', THIS_REPO, 0, 'dev -> prod'],
  ['prod', 'staging', THIS_REPO, 0, 'staging -> prod'],
  ['prod', 'feat/x', THIS_REPO, 1, 'feature branch -> prod is rejected'],
  [
    'prod',
    'dependabot/npm_and_yarn/x-1.0.0',
    THIS_REPO,
    1,
    'Dependabot -> prod is rejected (target-branch is dev)',
  ],

  // ── fork rejection, including the name-collision case ──────────────────────────────
  ['dev', 'feat/x', FORK, 1, 'fork PR -> dev is rejected'],
  ['dev', 'dev', FORK, 1, "fork's own `dev` branch cannot impersonate a promotion"],
  ['prod', 'dev', FORK, 1, "fork's `dev` cannot be promoted to prod"],
  ['staging', 'dev', FORK, 1, "fork's `dev` cannot be promoted to staging"],
];

const script = gateScript();
const failures = [];
console.log('[test-ci-scripts] branch-gate promotion rules');
console.log(`  (executing the step extracted from ${WORKFLOW.replace(REPO_ROOT, '')})`);

for (const [base, head, headRepo, expected, why] of CASES) {
  const { code, out } = runGate(script, base, head, headRepo);
  const ok = code === expected;
  // A rejection must explain itself — a bare exit 1 is unhelpful in the PR checks UI.
  const explained = expected === 0 || out.includes('::error::');
  const pass = ok && explained;
  if (!pass) failures.push({ base, head, headRepo, expected, code, out, why });
  console.log(
    `  ${pass ? '✓' : '✗'} ${base} <- ${head}${headRepo === FORK ? ' (fork)' : ''} → expected ${expected}, got ${code} — ${why}`,
  );
}

if (failures.length) {
  console.error('');
  for (const f of failures) {
    console.error(`  ✗ ${f.base} <- ${f.head}: expected ${f.expected}, got ${f.code} (${f.why})`);
    if (f.out.trim()) console.error(`      ${f.out.trim()}`);
  }
  console.error(`[test-ci-scripts] ${failures.length}/${CASES.length} branch-gate case(s) failed`);
  process.exit(1);
}

console.log(`[test-ci-scripts] ${CASES.length}/${CASES.length} branch-gate case(s) passed`);
