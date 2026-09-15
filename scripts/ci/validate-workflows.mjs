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

  console.log(`  ✓ ${label} (jobs: ${Object.keys(jobs).join(', ')})`);
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
}

console.log(`[validate-workflows] parsing ${WORKFLOW_DIR}`);
for (const file of readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort()) {
  validateWorkflow(file);
}
validateDependabot();

if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`[validate-workflows] ${problems.length} problem(s) found.`);
  process.exitCode = 1;
} else {
  console.log('[validate-workflows] all workflow files parsed and passed the shape checks.');
}
