# P2 — Browser Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `SessionManager` in `packages/server` that drives a persistent Playwright (Chromium) profile, lets the student log in once via Duo/2FA, and exposes login-state detection + session-health checks for later phases.

**Architecture:** A persistent browser context (dedicated `user-data-dir`, headful) so cookies survive across runs. A pure `classifySession()` detector (URL/DOM heuristics) is unit-tested with fixtures; `SessionManager` wraps Playwright IO around it. A small `session:login` script performs the one-time manual login.

**Tech Stack:** TypeScript, Playwright (chromium), Vitest.

**Human-in-the-loop:** This phase requires the user to (1) run a one-time `npx playwright install chromium`, and (2) complete a manual Duo login in the launched browser during verification.

---

### Task 1: Branch + tick P1 in TODO

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1:** `git checkout dev && git pull origin dev`
- [ ] **Step 2:** `git checkout -b p2-browser-session`
- [ ] **Step 3:** In `TODO.md`, change the P1 line to `- [x] **P1 — shared**: ...`

---

### Task 2: Add Playwright to the server package

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Add Playwright dependency + scripts**

Edit `packages/server/package.json` to:

```json
{
  "name": "@autoregister/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "browser:install": "playwright install chromium",
    "session:login": "tsx src/session/login-script.ts"
  },
  "dependencies": {
    "playwright": "^1.49.1"
  },
  "devDependencies": {
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: playwright + tsx installed, 0 vulnerabilities (or note any).

- [ ] **Step 3: Install the Chromium browser binary (HUMAN/agent run)**

Run: `npm run browser:install -w @autoregister/server`
Expected: Chromium downloaded (~150 MB). One-time.

---

### Task 3: Session config + types

**Files:**
- Create: `packages/server/src/session/config.ts`
- Create: `packages/server/src/session/types.ts`

- [ ] **Step 1: Create `packages/server/src/session/config.ts`**

```ts
import { resolve } from 'node:path';

/** Authenticated Minerva base path. */
export const MINERVA_BASE = 'https://horizon.mcgill.ca/pban1';

/** A protected page used to probe auth state; redirects to login when not authenticated. */
export const PROTECTED_PROBE_URL = `${MINERVA_BASE}/bwskfreg.P_AltPin`;

/** Persistent browser profile dir (gitignored). Override with AUTOREG_PROFILE_DIR. */
export const PROFILE_DIR = resolve(process.env.AUTOREG_PROFILE_DIR ?? '.browser-profile');

/** Max time (ms) to wait for the user to complete manual login. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
```

- [ ] **Step 2: Create `packages/server/src/session/types.ts`**

```ts
export type SessionStatus = 'authenticated' | 'logged-out';

export interface SessionProbe {
  /** The final URL after navigating to a protected page. */
  url: string;
  /** A lowercased snippet of page text/HTML used for marker detection. */
  bodyText: string;
}
```

---

### Task 4: Pure session-status detector (TDD)

**Files:**
- Create: `packages/server/src/session/session-status.test.ts`
- Create: `packages/server/src/session/session-status.ts`

> The exact logged-out markers are confirmed/refined during Task 7 (manual login). This first cut keys on (a) the final URL leaving the authenticated `pban1` area or hitting a known login endpoint, and (b) presence of login form markers in the body.

- [ ] **Step 1: Write failing tests `packages/server/src/session/session-status.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { classifySession } from './session-status';

describe('classifySession', () => {
  it('authenticated when on a pban1 page with course content', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin',
        bodyText: 'quick add or drop course sections current schedule',
      }),
    ).toBe('authenticated');
  });

  it('logged-out when redirected to a login endpoint', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/twbkwbis.P_WWWLogin',
        bodyText: 'user id pin login',
      }),
    ).toBe('logged-out');
  });

  it('logged-out when redirected off-domain to SSO', () => {
    expect(
      classifySession({
        url: 'https://login.microsoftonline.com/...',
        bodyText: 'sign in',
      }),
    ).toBe('logged-out');
  });

  it('logged-out when body shows a login form even on a pban1 url', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/twbkwbis.P_GenMenu',
        bodyText: 'please enter your mcgill username and password to login',
      }),
    ).toBe('logged-out');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- session-status`
Expected: FAIL — `classifySession` not defined.

- [ ] **Step 3: Implement `packages/server/src/session/session-status.ts`**

```ts
import type { SessionProbe, SessionStatus } from './types';

/** URL fragments that indicate a login / SSO page (not authenticated). */
const LOGIN_URL_MARKERS = [
  'p_wwwlogin',
  'twbkwbis.p_validate',
  'p_logout',
  'login.microsoftonline.com',
  '/adfs/',
  '/idp/',
  '/cas/',
];

/** Body-text fragments that indicate a login form is being shown. */
const LOGIN_BODY_MARKERS = ['enter your', 'username and password', 'user id', 'sign in', 'duo'];

const AUTH_BASE = 'horizon.mcgill.ca/pban1';

export function classifySession(probe: SessionProbe): SessionStatus {
  const url = probe.url.toLowerCase();
  const body = probe.bodyText.toLowerCase();

  if (LOGIN_URL_MARKERS.some((m) => url.includes(m))) return 'logged-out';
  if (LOGIN_BODY_MARKERS.some((m) => body.includes(m))) return 'logged-out';
  if (url.includes(AUTH_BASE)) return 'authenticated';
  return 'logged-out';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- session-status`
Expected: PASS.

---

### Task 5: SessionManager (Playwright wrapper)

**Files:**
- Create: `packages/server/src/session/session-manager.ts`

- [ ] **Step 1: Create `packages/server/src/session/session-manager.ts`**

```ts
import { chromium, type BrowserContext, type Page } from 'playwright';
import { LOGIN_TIMEOUT_MS, PROFILE_DIR, PROTECTED_PROBE_URL } from './config';
import { classifySession } from './session-status';
import type { SessionStatus } from './types';

/**
 * Owns a persistent, headful Chromium context whose cookies survive restarts.
 * The student logs in once (Duo) in the launched window; later phases reuse it.
 */
export class SessionManager {
  private context: BrowserContext | null = null;

  /** Launch (or relaunch) the persistent browser context. */
  async launch(): Promise<void> {
    if (this.context) return;
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('SessionManager not launched — call launch() first');
    return this.context;
  }

  /** Get a working page (reusing the first one if present). */
  async getPage(): Promise<Page> {
    const ctx = this.requireContext();
    return ctx.pages()[0] ?? (await ctx.newPage());
  }

  /** Probe the current session status by visiting a protected page. */
  async checkStatus(): Promise<SessionStatus> {
    const page = await this.getPage();
    await page.goto(PROTECTED_PROBE_URL, { waitUntil: 'domcontentloaded' });
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    return classifySession({ url: page.url(), bodyText });
  }

  /** True if currently authenticated. */
  async isLoggedIn(): Promise<boolean> {
    return (await this.checkStatus()) === 'authenticated';
  }

  /**
   * Ensure we are logged in. If not, surface the login page and wait for the
   * user to complete Duo manually, polling until authenticated or timeout.
   */
  async ensureLoggedIn(onPrompt?: () => void): Promise<void> {
    if (await this.isLoggedIn()) return;
    onPrompt?.();
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await this.isLoggedIn()) return;
    }
    throw new Error('Login not completed within timeout');
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }
}
```

---

### Task 6: One-time login script

**Files:**
- Create: `packages/server/src/session/login-script.ts`

- [ ] **Step 1: Create `packages/server/src/session/login-script.ts`**

```ts
import { SessionManager } from './session-manager';

/**
 * Run with: npm run session:login -w @autoregister/server
 * Launches the persistent browser; if not logged in, waits for the user to
 * complete Duo manually, then confirms and persists the session.
 */
async function main() {
  const session = new SessionManager();
  await session.launch();
  console.log('Browser launched. Checking session...');

  await session.ensureLoggedIn(() => {
    console.log('\n>>> Please log in to Minerva (incl. Duo 2FA) in the opened window.');
    console.log('>>> Waiting for login to complete (up to 5 minutes)...\n');
  });

  console.log('✓ Logged in. Session cookies are saved in the persistent profile.');
  console.log('You can close the browser window. Re-running will reuse this session.');
  await session.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Login script failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Export the session module**

Create `packages/server/src/session/index.ts`:

```ts
export { SessionManager } from './session-manager';
export { classifySession } from './session-status';
export type { SessionStatus, SessionProbe } from './types';
```

---

### Task 7: Manual login verification (HUMAN-IN-THE-LOOP)

**Files:** possibly update `session-status.ts` based on observed reality.

- [ ] **Step 1: Run the login script**

Run: `npm run session:login -w @autoregister/server`
Expected: a Chromium window opens.

- [ ] **Step 2: User logs in** to Minerva including Duo, in the opened window.

- [ ] **Step 3: Confirm** the script prints "✓ Logged in."

- [ ] **Step 4: Capture real logged-out markers (refine detector if needed).** While verifying, note the actual URL/markers Minerva shows when NOT logged in (and on session timeout). If they differ from the heuristics in `session-status.ts`, update `LOGIN_URL_MARKERS` / `LOGIN_BODY_MARKERS` and re-run `npm run test -- session-status`.

- [ ] **Step 5: Verify reuse** — re-run `npm run session:login`; it should report already logged in WITHOUT requiring a new login (proves cookie persistence).

---

### Task 8: Verify, commit, push, PR

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm run test` → all PASS.
- [ ] **Step 2:** Confirm `.browser-profile/` is gitignored (it is, from P0) and NOT staged.
- [ ] **Step 3: Commit**

```bash
git add packages/server/ TODO.md package-lock.json
git commit -m "feat(server): browser session manager with persistent profile + login detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4:** `git push -u origin p2-browser-session`
- [ ] **Step 5:** `gh pr create --base dev --head p2-browser-session --title "P2: browser session management" --body "..."`
- [ ] **Step 6:** Notify user; wait for review + merge.

---

## Self-Review Notes

- **Spec coverage:** spec §9 (persistent profile, login detection, health check) — Tasks 4–7. ✓
- **No placeholders:** all code concrete; detector markers explicitly flagged for refinement against real behavior in Task 7. ✓
- **Type consistency:** `SessionStatus`, `SessionProbe`, `classifySession`, `SessionManager` consistent across files. ✓
- **Open risk:** logged-out URL/DOM markers are best-effort until confirmed via manual login (Task 7).
