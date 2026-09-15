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
 * SCOPE (which revision of a file is judged) — `--mode`, defaulting to `commit` when `CI` is
 * set and `worktree` otherwise:
 *
 *   worktree (local `npm run gates`) — the change set is `<base>` vs the *working tree*,
 *     including staged, unstaged and brand-new untracked files, and the content judged is
 *     what is on disk. A gate that only looked at commits would happily report green for
 *     uncommitted work — the exact failure this mode exists to prevent.
 *
 *   commit (CI) — the change set is `<base>...HEAD` and the content is read from the index:
 *     precisely the commit being pushed, which is also what CI checks out.
 *
 * Usage:
 *   node scripts/ci/format-check-changed.mjs [--base <ref>] [--ext .ts,.tsx,...] [--list]
 *                                            [--repo <dir>] [--mode worktree|commit]
 *                                            [--no-base-compare]
 * Env:
 *   BASE_REF          base revision/branch (wins over --base)
 *   CI                when set, `--mode` defaults to `commit`
 *   CI_REPORT_PATH    write a JSON report (new violations + pre-existing debt) here
 *
 * Exit codes: 0 = no newly-introduced violations (pre-existing debt is still reported),
 * 1 = a newly-introduced violation, or a hard failure (unresolvable base, Prettier crash).
 *
 * `--repo` exists so `format-check-changed.test.mjs` can run this exact script against a
 * throwaway fixture repository instead of committing probe files here.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const REPO_ROOT = resolve(argValue('--repo') ?? fileURLToPath(new URL('../../', import.meta.url)));
const CONFIG_PATH = join(REPO_ROOT, '.prettierrc.json');

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

const BASE_COMPARE = !process.argv.includes('--no-base-compare');
const MODE = BASE_COMPARE ? 'no-new-violations' : 'strict';

// Where the "current" version of a file is read from:
//   worktree — the files on disk, including staged, unstaged and untracked changes.
//              This is what a local `npm run gates` must check: a green light on work that
//              has not been committed yet is worse than no gate at all.
//   commit   — the git index (`:<path>`), i.e. exactly the commit being pushed. That is
//              what CI checks out, so the two agree there.
// Picked by `--mode`, or automatically: CI=true → commit, otherwise worktree.
const CI_MODE = argValue('--mode') ?? (process.env.CI ? 'commit' : 'worktree');
if (!['worktree', 'commit'].includes(CI_MODE)) {
  console.error(`[format:check:changed] --mode must be 'worktree' or 'commit', got '${CI_MODE}'.`);
  process.exit(1);
}

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

function changedFiles(mergeBase) {
  // Changes on this branch relative to the merge base with the base ref.
  const raw = git(['diff', '--name-only', `--diff-filter=${DIFF_FILTER}`, `${mergeBase}...HEAD`]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Paths this check should look at, per mode.
 *
 * worktree — everything the working tree differs by, relative to the **merge base** with the
 *   base ref: committed work on the branch **plus** staged, unstaged and untracked files.
 *   `git diff --name-only <merge-base>` (no `...HEAD`) compares the merge base → working
 *   tree, and `git ls-files --others --exclude-standard` adds brand-new untracked files,
 *   which no `git diff` variant reports. Without the latter, a new unformatted file is
 *   invisible — the blind spot this mode exists to close.
 * commit — what this branch would actually push: `<merge-base>...HEAD`.
 *
 * Both modes anchor on the merge base rather than on the base ref's tip. Diffing against the
 * tip makes every file the base branch has advanced with look like *your* addition: running
 * `BASE_REF=origin/dev npm run gates` on a feature branch would report upstream files as
 * "newly added and unformatted". `git merge-base` is the same anchor `git diff A...B` already
 * uses, so results agree with what the PR page shows.
 */
function listChangedFiles(mergeBase) {
  if (CI_MODE === 'commit') return changedFiles(mergeBase);

  const tracked = git(['diff', '--name-only', `--diff-filter=${DIFF_FILTER}`, mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const all = [...tracked.split('\n'), ...untracked.split('\n')]
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(all)];
}

// NOTE: there is deliberately no `.prettierignore` filter here. `git check-ignore` only
// consults git's own ignore chain — it does NOT read `.prettierignore` — so filtering with
// it is dead code that silently excludes nothing. Prettier applies `.prettierignore` itself,
// and `checkContent` feeds it the repo-relative path so that resolution lands on the repo's
// own rules (see below).

/**
 * Runs Prettier over one file's content, telling it which repo-relative path the content
 * belongs to via `--stdin-filepath`.
 *
 * Why stdin instead of a copy on disk — each reason cost a real bug:
 *   1. A copy in the OS temp dir is outside the repo, so Prettier cannot discover
 *      `.prettierrc.json` (it silently assumes its defaults, double quotes and 80 columns,
 *      and flags every file) and `.prettierignore` patterns never match. Passing
 *      `--config`/`--ignore-path` does not fix the ignore half: those patterns resolve
 *      *relative to the ignore file's directory*, so `docs/plans` still would not match a
 *      temp path.
 *   2. A copy also loses file-name-specific behaviour: JSON is only treated as package.json
 *      when the file is *named* `package.json`.
 *   3. `--stdin-filepath` keeps the real repo-relative path for config, overrides, parser
 *      inference and ignore rules, while letting us judge arbitrary content — which is how
 *      the base revision of a file is checked with `git show`.
 *
 * Note that with `--stdin-filepath` Prettier prints the formatted text on stdout even in
 * `--check` mode; only the exit code is meaningful: 0 = formatted (or ignored), 1 = needs
 * formatting, 2 = real error. Both non-zero cases count as "not known-good".
 *
 * @returns {'clean' | 'unformatted'}
 */
function checkContent(relPath, content) {
  const res = spawnSync(
    'npx',
    ['prettier', '--check', '--config', CONFIG_PATH, '--stdin-filepath', relPath],
    {
      cwd: REPO_ROOT,
      input: content,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (res.error) throw new Error(`could not run Prettier: ${res.error.message}`);
  return res.status === 0 ? 'clean' : 'unformatted';
}

/** Merge base of the base ref and HEAD — the anchor both modes diff against. */
function resolveMergeBase(baseRef) {
  return git(['merge-base', baseRef, 'HEAD']).trim();
}

/** Base revision content of `relPath`, or null when the path does not exist there. */
function baseContent(mergeBase, relPath) {
  const res = spawnSync('git', ['show', `${mergeBase}:${relPath}`], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  return res.stdout;
}

/**
 * Content to validate for `relPath`, or null when there is nothing to validate (the file
 * was deleted in the worktree and still shows up as modified in the diff).
 */
function currentContent(relPath) {
  if (CI_MODE === 'commit') {
    return execFileSync('git', ['show', `:${relPath}`], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  const absolute = join(REPO_ROOT, relPath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute);
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

  let mergeBase;
  try {
    mergeBase = resolveMergeBase(baseRef);
  } catch (err) {
    console.error(
      `[format:check:changed] could not compute the merge base of ${baseRef}: ${err.message}`,
    );
    process.exit(1);
  }

  const extensions = (argValue('--ext') ?? DEFAULT_EXTENSIONS.join(','))
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  let changed;
  try {
    changed = listChangedFiles(mergeBase);
  } catch (err) {
    console.error(`[format:check:changed] git diff failed: ${err.message}`);
    process.exit(1);
  }

  const files = changed.filter((f) => extensions.some((ext) => f.endsWith(ext)));

  console.log(
    `[format:check:changed] base=${baseRef} (merge-base ${mergeBase.slice(0, 8)}), scope=${CI_MODE}, policy=${MODE}, ${changed.length} changed path(s), ${files.length} to check`,
  );

  if (process.argv.includes('--list')) {
    for (const f of files) console.log(`  ${f}`);
  }

  if (!files.length) {
    console.log('[format:check:changed] nothing to check — no changed source files.');
    writeReport({
      base: baseRef,
      mergeBase,
      scope: CI_MODE,
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
      const current = currentContent(file);
      if (current === null) {
        console.log(`  – ${file} — gone from the working tree, nothing to check`);
        continue;
      }
      const currentClean = checkContent(file, current) === 'clean';

      // Strict mode: no base comparison, so anything unformatted is a violation.
      const base = BASE_COMPARE ? baseContent(mergeBase, file) : null;
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
  }

  console.log('');
  writeReport({
    base: baseRef,
    mergeBase,
    scope: CI_MODE,
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
