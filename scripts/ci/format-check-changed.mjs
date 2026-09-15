#!/usr/bin/env node
/**
 * Prettier check limited to the files a branch/PR changed — and scoped to violations the
 * change actually *introduces*.
 *
 * The repo-wide `npm run format:check` is red: ~37 files predate the current Prettier
 * config. Reformatting them is a separate, deliberate task (it would bury any feature diff
 * and destroy `git blame`), so CI must not require it. But "only check changed files" is
 * not enough either: several of those dirty files are exactly the ones product branches
 * touch (Settings.tsx, i18n/index.ts, api/server.ts…), so a plain changed-files check would
 * fail any PR that so much as opens one of them.
 *
 * The rule is therefore: **no newly-introduced formatting violations.**
 *   - new file (absent on the base)        → must be formatted
 *   - modified file, clean on the base     → must stay clean
 *   - modified file, already dirty on base → reported as pre-existing debt, NOT blocking
 *
 * Usage:
 *   node scripts/ci/format-check-changed.mjs [--base <ref>] [--ext .ts,.tsx,...] [--list]
 *                                            [--no-base-compare]
 * Env:
 *   BASE_REF          base revision/branch (wins over --base)
 *   CI_REPORT_PATH    write a JSON report (new violations + pre-existing debt) here
 *
 * Exit codes: 0 = no newly-introduced violations (pre-existing debt is still reported),
 * 1 = a newly-introduced violation, or a hard failure (unresolvable base, Prettier crash).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG_PATH = `${REPO_ROOT}.prettierrc.json`;
const SCRATCH_ROOT = join(tmpdir(), `format-check-changed-${process.pid}`);

const DEFAULT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
];
const BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/dev',
  'origin/staging',
  'origin/prod',
  'origin/main',
  'origin/master',
  'HEAD~1',
];
const DIFF_FILTER = 'ACMR'; // Added, Copied, Modified, Renamed — deleted files have nothing to format.

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const BASE_COMPARE = !process.argv.includes('--no-base-compare');
const MODE = BASE_COMPARE ? 'no-new-violations' : 'strict';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

/** First candidate ref that actually resolves in this clone. */
function resolveBaseRef(explicit) {
  const candidates = explicit ? [explicit] : [];
  if (process.env.BASE_REF) candidates.unshift(process.env.BASE_REF);
  candidates.push(...BASE_CANDIDATES);

  for (const ref of candidates) {
    const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (probe.status === 0) return ref;
  }
  return null;
}

function changedFiles(baseRef) {
  // Three-dot diff: changes on this branch relative to the merge base with the base ref.
  const raw = git(['diff', '--name-only', `--diff-filter=${DIFF_FILTER}`, `${baseRef}...HEAD`]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** True when the path is excluded by .prettierignore (or any other gitignore-style rule). */
function isIgnored(path) {
  const res = spawnSync('git', ['check-ignore', '--quiet', '--', path], { cwd: REPO_ROOT });
  return res.status === 0;
}

/**
 * Writes `content` to a scratch file preserving the repo-relative directory shape and the
 * original file name, then runs Prettier on it with an explicit config.
 *
 * All three details matter, and each was learned the hard way while building this:
 *   1. without `--config`, a scratch file outside the repo makes Prettier fall back to its
 *      defaults (double quotes, 80 columns) and flags every single file;
 *   2. even with `--config`, JSON is only treated as package.json when the file is *named*
 *      `package.json` — a renamed copy is flagged as unformatted forever;
 *   3. the base version of a file needs the same treatment, otherwise "was it clean before?"
 *      is answered with the wrong config and every file looks dirty on the base.
 *
 * @returns {'clean' | 'unformatted'}
 */
function checkContent(relPath, content) {
  const target = join(SCRATCH_ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);

  const res = spawnSync('npx', ['prettier', '--check', '--config', CONFIG_PATH, target], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.error) throw new Error(`could not run Prettier: ${res.error.message}`);
  if (res.status === 0) return 'clean';
  // Prettier exits 1 for "needs formatting" and 2 for a real error (parse failure, bad
  // config). Both mean "not known-good", so both count against the file.
  return 'unformatted';
}

/** Base revision content of `relPath`, or null when the path does not exist there. */
function baseContent(baseRef, relPath) {
  const res = spawnSync('git', ['show', `${baseRef}:${relPath}`], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  return res.stdout;
}

function writeReport(payload) {
  if (!process.env.CI_REPORT_PATH) return;
  writeFileSync(process.env.CI_REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[format:check:changed] Prettier config not found at ${CONFIG_PATH}.`);
    process.exit(1);
  }

  const baseRef = resolveBaseRef(argValue('--base'));
  if (!baseRef) {
    const tried = [...BASE_CANDIDATES, argValue('--base'), process.env.BASE_REF]
      .filter(Boolean)
      .join(', ');
    console.error(
      `[format:check:changed] could not resolve a base revision to diff against (tried: ${tried}).`,
    );
    console.error('[format:check:changed] pass --base <ref> or set BASE_REF.');
    process.exit(1);
  }

  const extensions = (argValue('--ext') ?? DEFAULT_EXTENSIONS.join(','))
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  let changed;
  try {
    changed = changedFiles(baseRef);
  } catch (err) {
    console.error(`[format:check:changed] git diff failed: ${err.message}`);
    process.exit(1);
  }

  const files = changed
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .filter((f) => !isIgnored(f));

  console.log(
    `[format:check:changed] base=${baseRef}, mode=${MODE}, ${changed.length} changed path(s), ${files.length} to check`,
  );

  if (process.argv.includes('--list')) {
    for (const f of files) console.log(`  ${f}`);
  }

  if (!files.length) {
    console.log('[format:check:changed] nothing to check — no changed source files.');
    writeReport({
      base: baseRef,
      mode: MODE,
      files: [],
      newFiles: [],
      violations: [],
      preExisting: [],
      ok: true,
    });
    process.exit(0);
  }

  const violations = [];
  const preExisting = [];
  const newFiles = [];
  const hardErrors = [];

  try {
    for (const file of files) {
      const current = execFileSync('git', ['show', `:${file}`], {
        cwd: REPO_ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
      const currentClean = checkContent(file, current) === 'clean';

      // Strict mode: no base comparison, so anything unformatted is a violation.
      const base = BASE_COMPARE ? baseContent(baseRef, file) : null;
      if (base === null) {
        // Not on the base (new file), or strict mode with no baseline available.
        newFiles.push(file);
        if (currentClean) {
          console.log(`  ✓ ${file}${BASE_COMPARE ? ' (new file, formatted)' : ''}`);
        } else {
          violations.push({
            file,
            reason: BASE_COMPARE ? 'newly added file is not formatted' : 'not formatted',
          });
          console.error(
            `  ✗ ${file} — ${BASE_COMPARE ? 'newly added file is not formatted' : 'not formatted'}`,
          );
        }
        continue;
      }

      const baseClean = checkContent(file, base) === 'clean';
      if (currentClean) {
        console.log(`  ✓ ${file}`);
      } else if (!baseClean) {
        preExisting.push(file);
        console.log(
          `  ⚠ ${file} — not formatted, but already unformatted on ${baseRef} (pre-existing debt)`,
        );
      } else {
        violations.push({ file, reason: `formatted on ${baseRef}, broken by this change` });
        console.error(`  ✗ ${file} — was formatted on ${baseRef}, this change breaks it`);
      }
    }
  } catch (err) {
    hardErrors.push(err.message);
  } finally {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }

  console.log('');
  writeReport({
    base: baseRef,
    mode: MODE,
    files,
    newFiles,
    violations,
    preExisting,
    hardErrors,
    ok: violations.length === 0 && hardErrors.length === 0,
  });

  if (hardErrors.length) {
    for (const message of hardErrors) console.error(`[format:check:changed] ${message}`);
    process.exit(1);
  }

  if (violations.length) {
    console.error(
      `[format:check:changed] ${violations.length} newly-introduced formatting violation(s):`,
    );
    for (const v of violations) console.error(`  - ${v.file} (${v.reason})`);
    console.error(
      `[format:check:changed] fix with:\n  npx prettier --write ${violations.map((v) => v.file).join(' ')}`,
    );
    if (preExisting.length) {
      console.error(
        `[format:check:changed] (plus ${preExisting.length} pre-existing debt file(s), not blocking: ${preExisting.join(', ')})`,
      );
    }
    process.exit(1);
  }

  if (preExisting.length) {
    console.log(
      `[format:check:changed] ${preExisting.length} file(s) carry pre-existing formatting debt (not blocking):`,
    );
    for (const file of preExisting) console.log(`  - ${file}`);
    console.log(
      '[format:check:changed] these predate the current Prettier config; do not reformat them in a feature PR.',
    );
  }

  console.log(
    `[format:check:changed] no newly-introduced violations across ${files.length} changed file(s)` +
      (newFiles.length ? ` (${newFiles.length} new file(s), all formatted)` : '') +
      '.',
  );
  process.exit(0);
}

main();
