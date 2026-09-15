#!/usr/bin/env node
/**
 * Installs the Playwright Chromium build the suite needs into a repo-local directory.
 *
 * Why not the default per-user cache: this project pins browser builds to the exact
 * `playwright` version in package.json, and a machine-wide cache can hold a different
 * revision (e.g. chromium-1217/1234 while playwright 1.60 wants 1223), which makes
 * `chromium.launch()` fail with "Executable doesn't exist". Keeping the browsers next to
 * the repo makes local runs reproducible and keeps CI offline-cache friendly.
 *
 * Usage: npm run e2e:install   (add `-- --with-deps` on Linux CI)
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const browsersPath = fileURLToPath(new URL('../../.pw-browsers', import.meta.url));
const isWindows = process.platform === 'win32';

// On Windows `npx` is a `.cmd` shim, and spawning a `.cmd` without a shell throws EINVAL
// (Node's CVE-2024-27980 hardening). Going through the shell is what makes this work on
// both platforms; the arguments are fixed strings, so nothing user-supplied is parsed.
// The command line is assembled explicitly because passing an args array together with
// `shell: true` is deprecated (DEP0190).
const cliArgs = ['playwright', 'install', ...process.argv.slice(2), 'chromium'];
const result = spawnSync(
  isWindows ? ['npx', ...cliArgs].join(' ') : 'npx',
  isWindows ? [] : cliArgs,
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    stdio: 'inherit',
    shell: isWindows,
  },
);

if (result.error) {
  console.error(`[e2e:install] failed to run playwright: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[e2e:install] playwright install exited with ${result.status ?? 'no status'}.`);
}
console.log(`[e2e:install] browsers live in ${browsersPath}`);
process.exit(result.status ?? 1);
