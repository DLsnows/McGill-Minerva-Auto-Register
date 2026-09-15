#!/usr/bin/env node
/**
 * YAML syntax + shape check for `.github/workflows/*.yml` and `.github/dependabot.yml`.
 *
 * GitHub only reports a malformed workflow when the file is pushed, and the message points
 * at the trigger rather than the bad line. This parses every workflow locally instead and
 * asserts the handful of keys that make a workflow actually runnable.
 *
 * js-yaml (a transitive dependency, already present) is used in its default schema, so
 * `on:` stays the string `on` instead of being coerced to a boolean by YAML 1.1 rules.
 *
 * Usage: node scripts/ci/validate-workflows.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOW_DIR = `${REPO_ROOT}.github/workflows`;
const DEPENDABOT = `${REPO_ROOT}.github/dependabot.yml`;

const problems = [];

function check(condition, file, message) {
  if (!condition) problems.push(`${file}: ${message}`);
}

function validateWorkflow(file) {
  const label = `.github/workflows/${file}`;
  let doc;
  try {
    doc = load(readFileSync(`${WORKFLOW_DIR}/${file}`, 'utf8'));
  } catch (err) {
    problems.push(`${label}: YAML parse error — ${err.message}`);
    return;
  }

  check(doc && typeof doc === 'object', label, 'document is empty or not a mapping');
  if (!doc || typeof doc !== 'object') return;

  check(typeof doc.name === 'string' && doc.name.length > 0, label, 'missing `name`');
  // `on` must stay a string key; a YAML 1.1 parser would turn it into `true`.
  check(Object.hasOwn(doc, 'on'), label, 'missing `on` trigger (did YAML coerce it to a boolean?)');

  const jobs = doc.jobs;
  check(
    jobs && typeof jobs === 'object' && Object.keys(jobs).length > 0,
    label,
    'missing or empty `jobs`',
  );
  if (!jobs || typeof jobs !== 'object') return;

  for (const [jobId, job] of Object.entries(jobs)) {
    check(job && typeof job === 'object', label, `job \`${jobId}\` is not a mapping`);
    if (!job || typeof job !== 'object') continue;
    check(typeof job['runs-on'] === 'string', label, `job \`${jobId}\` is missing \`runs-on\``);
    check(Array.isArray(job.steps) && job.steps.length > 0, label, `job \`${jobId}\` has no steps`);
    for (const [i, step] of (job.steps ?? []).entries()) {
      const hasRun = typeof step?.run === 'string';
      const hasUses = typeof step?.uses === 'string';
      check(
        hasRun || hasUses,
        label,
        `job \`${jobId}\` step #${i + 1} has neither \`run\` nor \`uses\``,
      );
      check(
        !(hasRun && hasUses),
        label,
        `job \`${jobId}\` step #${i + 1} has both \`run\` and \`uses\``,
      );
    }
  }

  validateForkGuard(label, jobs);

  console.log(`  ✓ ${label} (jobs: ${Object.keys(jobs).join(', ')})`);
  return doc;
}

/**
 * Jobs that execute repository code MUST be gated behind the `guard` job, otherwise a fork
 * PR runs its own `package.json` scripts (preinstall hooks, test/build) on our runner —
 * `branch-gate.yml` refusing it later is too late, because both workflows start together.
 *
 * Exemptions:
 *   - `guard` itself (it is the gate, and runs no repo code);
 *   - workflows that never check out or install anything (`WORKFLOWS_WITHOUT_GUARD`).
 */
const WORKFLOWS_WITHOUT_GUARD = new Set(['branch-gate.yml']);
const CODE_RUNNING_STEP = /npm (ci|install|test|run)|node |npx |vitest|tsc /;
const GUARDED_JOB = /needs\.guard\.outputs\.same_repo\s*==\s*'true'/;

function validateForkGuard(label, jobs) {
  const file = label.replace('.github/workflows/', '');
  if (WORKFLOWS_WITHOUT_GUARD.has(file)) return;
  if (!('guard' in jobs)) return; // a workflow that runs no repo code needs no guard

  check(
    Array.isArray(jobs.guard?.steps),
    label,
    'job `guard` must declare steps that publish `same_repo`',
  );
  check(
    Boolean(jobs.guard?.outputs?.same_repo),
    label,
    'job `guard` must expose the `same_repo` output',
  );

  for (const [jobId, job] of Object.entries(jobs)) {
    if (jobId === 'guard') continue;
    const runsCode = (job?.steps ?? []).some((step) => {
      if (typeof step?.run === 'string' && CODE_RUNNING_STEP.test(step.run)) return true;
      // Any third-party action runs code from the (untrusted) PR checkout in the common case.
      return typeof step?.uses === 'string';
    });
    if (!runsCode) continue;
    check(
      String(job?.if ?? '').includes(`needs.guard.outputs.same_repo == 'true'`) ||
        GUARDED_JOB.test(String(job?.if ?? '')),
      label,
      `job \`${jobId}\` runs repository code but is not gated on \`needs.guard.outputs.same_repo == 'true'\` (fork PRs would execute untrusted code)`,
    );
    check(
      String(job?.needs ?? '').includes('guard'),
      label,
      `job \`${jobId}\` must declare \`needs: guard\` so it is skipped for forks`,
    );
  }
}

function validateDependabot() {
  const label = '.github/dependabot.yml';
  let doc;
  try {
    doc = load(readFileSync(DEPENDABOT, 'utf8'));
  } catch (err) {
    problems.push(`${label}: YAML parse error — ${err.message}`);
    return;
  }
  check(doc?.version === 2, label, '`version` must be 2');
  check(
    Array.isArray(doc?.updates) && doc.updates.length > 0,
    label,
    '`updates` must be a non-empty list',
  );
  for (const [i, entry] of (doc?.updates ?? []).entries()) {
    const where = `${label} (updates[${i}])`;
    check(typeof entry['package-ecosystem'] === 'string', where, 'missing `package-ecosystem`');
    check(typeof entry.directory === 'string', where, 'missing `directory`');
    check(typeof entry.schedule?.interval === 'string', where, 'missing `schedule.interval`');
  }
  console.log(
    `  ✓ ${label} (ecosystems: ${(doc?.updates ?? []).map((u) => u['package-ecosystem']).join(', ')})`,
  );
  return doc;
}

/**
 * `dependabot.yml` and `branch-gate.yml` have to agree: if Dependabot opens its PRs against
 * `dev` (target-branch), the gate must let `dependabot/*` into `dev`. Otherwise every
 * dependency PR is born red — gate failure plus a full CI run — which is the same
 * "unmanaged dependency PR" problem this repository just set out to fix, only louder.
 *
 * The behavioural matrix lives in `branch-gate.test.mjs`; this is the static half, so a
 * cross-file inconsistency is caught even where bash is unavailable.
 */
function validateDependabotGateAgreement(dependabotDoc, branchGateDoc) {
  const label = '.github/dependabot.yml + .github/workflows/branch-gate.yml';
  const target = dependabotDoc?.updates?.[0]?.['target-branch'];
  if (target !== 'dev') return; // nothing to reconcile

  const steps = branchGateDoc?.jobs?.['branch-gate']?.steps ?? [];
  const gateRun = steps.map((s) => s?.run ?? '').join('\n');
  check(
    gateRun.includes('dependabot/*'),
    label,
    '`dependabot.yml` sets `target-branch: dev`, so branch-gate.yml must allow `dependabot/*` into `dev` (otherwise every dependency PR is guaranteed to fail the gate)',
  );
}

console.log(`[validate-workflows] parsing ${WORKFLOW_DIR}`);
const docs = new Map();
for (const file of readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort()) {
  docs.set(file, validateWorkflow(file));
}
const dependabotDoc = validateDependabot();
validateDependabotGateAgreement(dependabotDoc, docs.get('branch-gate.yml'));

if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`[validate-workflows] ${problems.length} problem(s) found.`);
  process.exitCode = 1;
} else {
  console.log('[validate-workflows] all workflow files parsed and passed the shape checks.');
}
