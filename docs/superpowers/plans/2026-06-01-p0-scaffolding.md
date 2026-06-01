# P0 — Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo skeleton, tooling (TypeScript/ESLint/Prettier/Vitest), and ported GitHub Actions CI so every later phase has a working `lint` / `typecheck` / `test` pipeline and automated PR review.

**Architecture:** npm-workspaces monorepo with three packages (`shared`, `server`, `web`). Root holds shared tooling config; each package is a minimal stub in P0 (real code lands in later phases). CI is ported from DLsnows/Sonic_Bridge (lint+typecheck, unit-tests, Claude review, PR-Agent), minus vst3 and Lighthouse.

**Tech Stack:** Node 22 (CI) / Node 25 (local), TypeScript 5.7, ESLint 9 (flat config) + typescript-eslint 8, Prettier 3, Vitest 2, GitHub Actions.

---

### Task 0: Prerequisites and feature branch

**Files:** none

- [ ] **Step 1: Confirm tooling versions**

Run: `node -v && npm -v && git --version`
Expected: node v22+ (local v25 is fine), npm 9+, git 2.x.

- [ ] **Step 2: Ensure on dev and up to date**

Run: `git checkout dev && git pull origin dev`
Expected: branch `dev`, up to date.

- [ ] **Step 3: Create the P0 feature branch**

Run: `git checkout -b p0-scaffolding`
Expected: switched to a new branch `p0-scaffolding`.

---

### Task 1: Root workspace config

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create `.nvmrc`**

```
22
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "autoregister",
  "version": "0.0.0",
  "private": true,
  "description": "McGill Minerva course auto-register tool",
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "vitest run"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.18.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

---

### Task 2: Lint & format config

**Files:**
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

- [ ] **Step 1: Create `eslint.config.mjs`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
```

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
dist
build
node_modules
coverage
package-lock.json
```

---

### Task 3: Vitest config + `shared` package with first passing test

**Files:**
- Create: `vitest.config.ts`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/index.test.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Create `packages/shared/package.json`**

```json
{
  "name": "@autoregister/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write the failing test `packages/shared/src/index.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { VERSION } from './index';

describe('shared package', () => {
  it('exposes a version string', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm install` then `npm run test`
Expected: FAIL — cannot resolve `./index` / `VERSION` is not exported (file not created yet).

- [ ] **Step 6: Create minimal `packages/shared/src/index.ts`**

```ts
export const VERSION = '0.0.0';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test`
Expected: PASS — 1 test passed.

---

### Task 4: `server` package stub

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/index.ts`

- [ ] **Step 1: Create `packages/server/package.json`**

```json
{
  "name": "@autoregister/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/server/src/index.ts`**

```ts
export const SERVER_NAME = 'autoregister-server';
```

---

### Task 5: `web` package stub

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/src/index.ts`

- [ ] **Step 1: Create `packages/web/package.json`**

```json
{
  "name": "@autoregister/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/web/src/index.ts`**

```ts
export const WEB_NAME = 'autoregister-web';
```

---

### Task 6: Verify lint + typecheck across the workspace

**Files:** none

- [ ] **Step 1: Run typecheck across all packages**

Run: `npm run typecheck`
Expected: PASS — tsc reports no errors in shared/server/web.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS — no ESLint errors. Fix any reported issues, then rerun until clean.

- [ ] **Step 3: Run formatter check**

Run: `npm run format:check`
Expected: If files need formatting, run `npm run format` then re-run `format:check` until clean.

- [ ] **Step 4: Commit the scaffolding**

```bash
git add package.json package-lock.json .nvmrc tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore vitest.config.ts packages/
git commit -m "chore: scaffold npm-workspaces monorepo with TS/ESLint/Prettier/Vitest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Port GitHub Actions CI (minus vst3 & lighthouse)

**Files:**
- Create: `.github/workflows/ci-lint-typecheck.yml`
- Create: `.github/workflows/ci-unit-tests.yml`
- Create: `.github/workflows/claude-code-review.yml`
- Create: `.github/workflows/pr-agent.yml`

> Note: `runs-on: ubuntu-slim` is kept verbatim from Sonic_Bridge (same owner used it successfully). If the P0 PR shows "no runner found", switch these two lint/test jobs to `ubuntu-latest`.

- [ ] **Step 1: Create `.github/workflows/ci-lint-typecheck.yml`**

```yaml
name: CI / lint-and-typecheck

on:
  pull_request:
    branches: [dev, staging]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-slim

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        id: lint
        continue-on-error: true
        run: |
          set -o pipefail
          npm run lint 2>&1 | tee lint-output.txt

      - name: Run TypeScript type check
        id: typecheck
        continue-on-error: true
        run: |
          set -o pipefail
          npm run typecheck 2>&1 | tee typecheck-output.txt

      - name: Build comment body
        id: build-comment
        if: always()
        run: |
          TRUNCATE_LINES=200

          {
            echo "## :mag: Lint & Type Check Results"
            echo ""

            echo "### ESLint"
            if [ "${{ steps.lint.outcome }}" = "success" ]; then
              echo ":white_check_mark: **Passed** -- no lint errors or warnings."
            else
              echo ":x: **Failed** -- see errors below:"
              echo ""
              echo '```'
              tail -n $TRUNCATE_LINES lint-output.txt 2>/dev/null || echo "(no output captured)"
              echo '```'
            fi
            echo ""

            echo "### TypeScript Type Check"
            if [ "${{ steps.typecheck.outcome }}" = "success" ]; then
              echo ":white_check_mark: **Passed** -- no type errors."
            else
              echo ":x: **Failed** -- see errors below:"
              echo ""
              echo '```'
              tail -n $TRUNCATE_LINES typecheck-output.txt 2>/dev/null || echo "(no output captured)"
              echo '```'
            fi
            echo ""
          } > /tmp/comment.md

      - name: Post sticky comment
        if: always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: lint-and-typecheck
          path: /tmp/comment.md

      - name: Fail if any check failed
        if: |
          always() &&
          (steps.lint.outcome == 'failure' || steps.typecheck.outcome == 'failure')
        run: exit 1
```

- [ ] **Step 2: Create `.github/workflows/ci-unit-tests.yml`**

```yaml
name: CI / unit-tests

on:
  pull_request:
    branches: [dev, staging]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  unit-tests:
    runs-on: ubuntu-slim

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        id: tests
        continue-on-error: true
        run: |
          set -o pipefail
          npm run test -- --reporter=verbose 2>&1 | tee test-output.txt

      - name: Build comment body
        id: build-comment
        if: always()
        run: |
          TRUNCATE_LINES=200

          PASSED=$(grep -c "^ ✓" test-output.txt 2>/dev/null || echo 0)
          FAILED=$(grep -c "^ ×" test-output.txt 2>/dev/null || echo 0)
          TOTAL=$((PASSED + FAILED))

          {
            echo "## :test_tube: Unit Test Results"
            echo ""

            if [ "${{ steps.tests.outcome }}" = "success" ]; then
              echo ":white_check_mark: **All tests passed** ($TOTAL/$TOTAL)"
            else
              echo ":x: **Test failures detected**"
              echo ""
              echo "| | Count |"
              echo "|---|---|"
              echo "| :white_check_mark: Passed | $PASSED |"
              echo "| :x: Failed | $FAILED |"
              echo "| **Total** | **$TOTAL** |"
              echo ""

              if [ "$FAILED" -gt 0 ]; then
                echo "### Failed Tests"
                echo '```'
                grep "^ ×" test-output.txt 2>/dev/null | tail -n $TRUNCATE_LINES || echo "(could not parse failures)"
                echo '```'
              fi

              echo "### Full Output"
              echo '```'
              tail -n $TRUNCATE_LINES test-output.txt 2>/dev/null || echo "(no output captured)"
              echo '```'
            fi
            echo ""
          } > /tmp/comment.md

      - name: Post sticky comment
        if: always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: unit-tests
          path: /tmp/comment.md

      - name: Fail if any check failed
        if: |
          always() &&
          steps.tests.outcome == 'failure'
        run: exit 1
```

- [ ] **Step 3: Create `.github/workflows/claude-code-review.yml`**

```yaml
name: Claude Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-slim
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Fetch PR diff
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p /tmp/pr-data
          gh pr diff ${{ github.event.pull_request.number }} > /tmp/pr-data/diff.txt
          gh pr view ${{ github.event.pull_request.number }} --json title,body > /tmp/pr-data/info.json

      - name: Run Claude Code Review
        uses: anthropics/claude-code-action@v1
        env:
          ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic
          ANTHROPIC_MODEL: deepseek-v4-pro[1M]
          ANTHROPIC_DEFAULT_SONNET_MODEL: deepseek-v4-pro[1M]
          ANTHROPIC_DEFAULT_HAIKU_MODEL: deepseek-v4-flash
        with:
          anthropic_api_key: ${{ secrets.DEEPSEEK_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          prompt: |
            Review pull request #${{ github.event.pull_request.number }}.

            Read /tmp/pr-data/info.json for PR title/body.
            Read /tmp/pr-data/diff.txt for all code changes.

            Find bugs, logic errors, and security issues. Skip formatting, style, type errors, pre-existing issues.

            Post your review as a PR comment:
            gh pr comment ${{ github.event.pull_request.number }} --body "### Code Review
            [your findings here, or 'No issues found.']
            🤖 Generated with [Claude Code](https://claude.ai/code)"
          claude_args: "--model deepseek-v4-pro[1M] --max-turns 15 --allowedTools Bash,Read,Grep,Glob"
```

- [ ] **Step 4: Create `.github/workflows/pr-agent.yml`**

```yaml
name: PR Agent Code Review

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true

jobs:
  pr_agent_job:
    if: ${{ github.event.sender.type != 'Bot' }}
    # NOTE: keep ubuntu-latest (NOT ubuntu-slim). pr-agent is a Docker container
    # action; the slim runner image has no docker daemon, so the action's build
    # phase fails with "no such file or directory" on /var/run/docker.sock.
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: write
    name: PR Agent - Auto Review & Describe
    steps:
      - name: PR Agent action step
        id: pragent
        uses: the-pr-agent/pr-agent@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEEPSEEK.KEY: ${{ secrets.DEEPSEEK_KEY }}
          config.model: "deepseek/deepseek-v4-pro"
          config.fallback_models: '["deepseek/deepseek-v4-pro"]'
          config.custom_model_max_tokens: "131072"
          config.max_model_tokens: "120000"
          github_action_config.auto_review: "true"
          github_action_config.auto_describe: "true"
          github_action_config.auto_improve: "true"
          github_action_config.enable_output_relevant: "true"
```

- [ ] **Step 5: Commit the workflows**

```bash
git add .github/workflows/
git commit -m "ci: port lint/typecheck, unit-tests, claude-review, pr-agent from Sonic_Bridge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: TODO.md and README

**Files:**
- Create: `TODO.md`
- Modify: `README.md`

- [ ] **Step 1: Create `TODO.md`**

```markdown
# AutoRegister — Project TODO

Maintained by the coding agent. Check off items as phases complete.
See design spec: `docs/superpowers/specs/2026-06-01-autoregister-design.md`.

## Phases (each = one PR → dev)

- [ ] **P0 — Scaffolding**: monorepo, tooling, CI port, TODO, design doc
- [ ] **P1 — shared**: decision engine (pure, fully tested) + course table parser
- [ ] **P2 — minerva-client/session**: persistent profile, login detection, health check
- [ ] **P3 — minerva-client/query**: advanced search navigation + parse, match by target CRN
- [ ] **P4 — minerva-client/register**: submit + waitlist re-submit + term check + error capture
- [ ] **P5 — store + scheduler + budget/pacing + notifier**
- [ ] **P6 — api**: REST + WebSocket
- [ ] **P7 — web**: Synapse UI wired to API (incl. one-click execute)
- [ ] **P8 — integration**: dry-run rehearsal, docs, polish

## Conventions
- Per-phase: feature branch → PR to `dev` → CI + AI review + human confirm → merge.
- Daily budget: queries 100/day, registrations 20/day (configurable).
- Default poll interval 30m ± 3m jitter; budget-aware scheduling.
```

- [ ] **Step 2: Replace `README.md`**

```markdown
# AutoRegister

McGill Minerva course-seat watcher & auto-register tool. A local web app that
reuses your already-logged-in browser session to poll specified courses on a
jittered interval, decide register / waitlist / no-op per Minerva's seat rules,
and either act automatically or notify you.

> Personal automation for your own course registration. Use responsibly and in
> accordance with your school's terms of use.

## Status

Early development. See:
- Design spec: [`docs/superpowers/specs/2026-06-01-autoregister-design.md`](docs/superpowers/specs/2026-06-01-autoregister-design.md)
- Progress: [`TODO.md`](TODO.md)

## Tech

Node + TypeScript monorepo (npm workspaces): `packages/shared`, `packages/server`, `packages/web`.
Playwright (browser automation), Fastify + WebSocket (backend), React + Vite + Tailwind (Synapse-themed UI).

## Development

```bash
npm install      # install workspace deps
npm run lint     # ESLint
npm run typecheck
npm run test     # Vitest
```

Requires Node 22+.
```

- [ ] **Step 3: Commit docs**

```bash
git add TODO.md README.md
git commit -m "docs: add project TODO and update README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Final verification, push, and open PR

**Files:** none

- [ ] **Step 1: Run the full local CI equivalent**

Run: `npm ci && npm run lint && npm run typecheck && npm run test`
Expected: all PASS (this mirrors what CI will run).

- [ ] **Step 2: Push the branch**

Run: `git push -u origin p0-scaffolding`
Expected: branch pushed.

- [ ] **Step 3: Open the PR to dev**

Run:
```bash
gh pr create --base dev --head p0-scaffolding \
  --title "P0: scaffolding — monorepo, tooling, CI" \
  --body "Sets up npm-workspaces monorepo (shared/server/web stubs), TypeScript/ESLint/Prettier/Vitest tooling, and ports CI from Sonic_Bridge (lint+typecheck, unit-tests, Claude review, PR-Agent; excludes vst3 & lighthouse). Adds TODO.md and updates README.

Implements P0 of docs/superpowers/specs/2026-06-01-autoregister-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR URL printed.

- [ ] **Step 4: Notify the user (HUMAN-IN-THE-LOOP)**

Report the PR URL to the user. The user must:
1. Review the PR.
2. Confirm CI checks (lint+typecheck, unit-tests) pass and the AI reviewers (Claude, PR-Agent) have commented.
3. Approve and merge to `dev`.

Do NOT merge automatically — wait for the user's confirmation.

- [ ] **Step 5: After merge — tick P0 in TODO.md**

Once the user confirms the merge, on `dev`: check off `P0` in `TODO.md` (this can ride along with the P1 PR).

---

## Self-Review Notes

- **Spec coverage:** P0 scope from spec §14 (monorepo, tooling, CI port, secret, TODO, design doc) — branch setup, design doc, and `DEEPSEEK_KEY` secret were already done during brainstorming; this plan covers the remaining monorepo + tooling + CI + TODO/README. ✓
- **No placeholders:** all file contents are concrete. ✓
- **Type consistency:** package names `@autoregister/{shared,server,web}` used consistently; scripts (`lint`/`typecheck`/`test`) match CI invocations (`npm run lint`, `npm run typecheck`, `npm run test -- --reporter=verbose`). ✓
- **Watch-points to surface to the user:** (1) `ubuntu-slim` runner availability; (2) Node 22 (CI) vs 25 (local) — fine for P0.
