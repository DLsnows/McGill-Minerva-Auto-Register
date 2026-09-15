#!/usr/bin/env node
/**
 * Policy regression test for `scripts/ci/format-check-changed.mjs`.
 *
 * The policy is subtle and easy to break by accident, and a broken policy fails *silently*
 * in the worst direction (either it blocks every product PR that touches a historically
 * unformatted file, or it stops catching real regressions). So it gets an executable test
 * rather than a paragraph in a doc.
 *
 * Rather than committing probe files into this repository, the test builds a throwaway git
 * repository in the OS temp dir and runs the real script against it with `--repo`. Scenarios:
 *
 *   A. a file that was formatted on the base is broken  → must FAIL
 *   B. a file that was already unformatted on the base  → must PASS, reported as debt
 *   C. a newly added file that is unformatted           → must FAIL
 *   D. a change that is entirely well formatted         → must PASS with an empty report
 *   E. a `.prettierignore`d file is changed             → must not appear in the report
 *
 * Usage: npm run test:ci-scripts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/ci/format-check-changed.mjs');

const CONFIG = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
};
const IGNORE = ['README.md'];

// Deliberately not Prettier-formatted (double quotes, over-long line).
const DIRTY = [
  'const config = { alpha: "one", beta: "two", gamma: "three", delta: "four", epsilon: "five", zeta: "six" };',
  'export default config;',
  '',
].join('\n');
const CLEAN = ['const config = { alpha: 1, beta: 2 };', '', 'export default config;', ''].join(
  '\n',
);
const BROKEN = ['const config={alpha:1,    beta:2};', 'export default config;', ''].join('\n');

const results = [];

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd, ...args) {
  return sh(cwd, 'git', args);
}

function write(root, relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=CI Policy Test',
    'commit',
    '-q',
    '-m',
    message,
  );
}

/** Runs the real script against the fixture repo; returns { code, stdout, report }. */
function runCheck(root) {
  const reportPath = join(root, '.report.json');
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT, '--repo', root, '--base', 'HEAD~1', '--ext', '.ts,.md'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CI_REPORT_PATH: reportPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    code = err.status ?? 1;
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  let report = readReport(reportPath);
  return { code, stdout, report };
}

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(
    `  ${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : `\n      ${detail}`}`,
  );
}

/** Builds a fresh fixture repo with a `base` commit and returns { root, cleanup }. */
function makeFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'format-policy-'));
  write(root, '.prettierrc.json', `${JSON.stringify(CONFIG, null, 2)}\n`);
  write(root, '.prettierignore', `${IGNORE.join('\n')}\n`);
  write(root, 'src/clean.ts', CLEAN);
  write(root, 'src/dirty.ts', DIRTY);
  write(root, 'README.md', '# fixture\n\nSome    unformatted     text\n');
  git(root, 'init', '-q');
  git(root, 'config', 'commit.gpgsign', 'false');
  commit(root, 'base');
  mutate(root);
  commit(root, 'change');
  return root;
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // report is optional for the assertions
  }
}

console.log('[test-ci-scripts] format-check-changed policy');

// ── A: a file that was clean on the base is broken ─────────────────────────────────────
{
  const root = makeFixture((r) => write(r, 'src/clean.ts', BROKEN));
  const { code, stdout, report } = runCheck(root);
  check(
    'A. breaking a previously-clean file fails the check',
    code === 1 && report?.violations?.some((v) => v.file === 'src/clean.ts'),
    `exit=${code}, violations=${JSON.stringify(report?.violations)}\n${stdout}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── B: a file that was already dirty on the base must NOT block ────────────────────────
{
  const root = makeFixture((r) => write(r, 'src/dirty.ts', `${DIRTY}// touched\n`));
  const { code, stdout, report } = runCheck(root);
  check(
    'B. touching a pre-existing debt file passes and reports it as debt',
    code === 0 && report?.preExisting?.includes('src/dirty.ts') && report?.violations?.length === 0,
    `exit=${code}, preExisting=${JSON.stringify(report?.preExisting)}, violations=${JSON.stringify(report?.violations)}\n${stdout}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── C: a new file that is unformatted must fail ───────────────────────────────────────
{
  const root = makeFixture((r) => write(r, 'src/brand-new.ts', BROKEN));
  const { code, stdout, report } = runCheck(root);
  check(
    'C. a new unformatted file fails the check',
    code === 1 && report?.violations?.some((v) => v.file === 'src/brand-new.ts'),
    `exit=${code}, violations=${JSON.stringify(report?.violations)}\n${stdout}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── D: an all-clean change passes with an empty report ────────────────────────────────
{
  const root = makeFixture((r) => write(r, 'src/added.ts', CLEAN));
  const { code, stdout, report } = runCheck(root);
  check(
    'D. a clean change passes with no violations and no debt',
    code === 0 && report?.violations?.length === 0 && report?.preExisting?.length === 0,
    `exit=${code}, report=${JSON.stringify(report)}\n${stdout}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── E: .prettierignore'd files are skipped by Prettier itself ──────────────────────────
{
  // README.md is in .prettierignore and is deliberately unformatted. It is listed as a
  // changed candidate, but Prettier honours the ignore rule and reports it clean — which is
  // exactly why this script needs no ignore handling of its own (`git check-ignore` does not
  // read `.prettierignore`, so a filter built on it would have been dead code anyway).
  const root = makeFixture((r) =>
    write(r, 'README.md', '# fixture\n\nSome    unformatted     text\nmore\n'),
  );
  const { code, stdout, report } = runCheck(root);
  check(
    'E. a changed .prettierignore file is skipped by Prettier, not flagged',
    code === 0 && report?.files?.includes('README.md') && report?.violations?.length === 0,
    `exit=${code}, files=${JSON.stringify(report?.files)}, violations=${JSON.stringify(report?.violations)}\n${stdout}`,
  );
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `[test-ci-scripts] ${results.length - failed.length}/${results.length} scenario(s) passed`,
);
process.exit(failed.length ? 1 : 0);
