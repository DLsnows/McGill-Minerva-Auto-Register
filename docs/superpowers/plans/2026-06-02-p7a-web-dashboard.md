# P7a — Web scaffold + Synapse theme + data layer + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Synapse-themed web app shell + live Dashboard (course cards + real-time console) wired to the P6 API, plus the small server additions (`POST /api/targets/:id/run`, Fastify static serving) it needs.

**Architecture:** A React + Vite + TypeScript SPA in `packages/web`, styled with Tailwind v4 plus Synapse component classes ported from the approved mockup. A thin typed data layer (`fetch` + custom hooks + a WebSocket hook) consumes the existing REST + `/api/stream` API; types are reused from `@autoregister/shared`. The server gains a force-run endpoint and serves the built `dist`.

**Tech Stack:** React 19, Vite 7, Tailwind CSS v4 (`@tailwindcss/vite`), react-router-dom 7, Vitest 4 + @testing-library/react + jsdom, Fastify `@fastify/static`.

**Reference:** Design spec `docs/superpowers/specs/2026-06-02-p7-web-frontend-design.md`. Approved visual mockup: `.superpowers/brainstorm/224-1780396067/content/dashboard-v3.html` (source of truth for colors/layout/log styling).

---

## File Structure

```
packages/web/
  package.json            # MODIFY: add React/Vite/Tailwind/test deps + scripts
  tsconfig.json           # MODIFY: DOM libs + jsx
  vite.config.ts          # CREATE: React + Tailwind plugins + /api & /api/stream proxy
  vitest.config.ts        # CREATE: jsdom + react plugin + setup
  index.html              # CREATE: SPA entry + font links
  src/
    main.tsx              # CREATE: mount React + Router
    App.tsx               # CREATE: shell (NavPills + Ticker + <Outlet/>)
    test-setup.ts         # CREATE: @testing-library/jest-dom
    theme/theme.css       # CREATE: Tailwind import + Synapse tokens + component classes
    lib/
      format.ts           # CREATE: pure formatters
      api.ts              # CREATE: typed REST client
      useResource.ts      # CREATE: GET hook (load + refetch)
      useEventStream.ts   # CREATE: WebSocket hook (snapshot + increments + reconnect)
    components/
      StatusBadge.tsx     # CREATE
      StatGrid.tsx        # CREATE
      ModeToggle.tsx      # CREATE
      CourseCard.tsx      # CREATE
      Console.tsx         # CREATE
      Ticker.tsx          # CREATE
      NavPills.tsx        # CREATE
    pages/
      Dashboard.tsx       # CREATE
      Courses.tsx         # CREATE (P7b placeholder page)
      Session.tsx         # CREATE (P7b placeholder page)
      Settings.tsx        # CREATE (P7b placeholder page)

Root / server (small changes):
  vitest.config.ts                         # MODIFY: projects (node + web)
  eslint.config.mjs                        # MODIFY: web tsx block (react-hooks + browser globals)
  package.json                             # MODIFY: root scripts + devDeps (globals, react-hooks plugin)
  packages/server/package.json             # MODIFY: add @fastify/static
  packages/server/src/scheduler/scheduler.ts   # MODIFY: runOnce(force) + runTarget
  packages/server/src/scheduler/scheduler.test.ts # MODIFY: force test
  packages/server/src/api/server.ts        # MODIFY: ApiScheduler.runTarget + POST /run + static
  packages/server/src/api/server.test.ts   # MODIFY: run-endpoint tests + stub runTarget
```

---

## Task 1: Scaffold the web package (Vite + React + TS + Tailwind + Vitest)

**Files:**
- Modify: `packages/web/package.json`
- Modify: `packages/web/tsconfig.json`
- Create: `packages/web/vite.config.ts`, `packages/web/vitest.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/test-setup.ts`
- Delete: `packages/web/src/index.ts`
- Modify: `vitest.config.ts` (root), `eslint.config.mjs`, `package.json` (root)

- [ ] **Step 1: Replace `packages/web/package.json`**

```json
{
  "name": "@autoregister/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@autoregister/shared": "*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "vite": "^7.0.0"
  }
}
```

- [ ] **Step 2: Replace `packages/web/tsconfig.json`** (DOM libs + JSX; base sets strict/noEmit)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies API + WS to the Fastify backend on 4575.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4575', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
```

- [ ] **Step 4: Create `packages/web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    globals: true,
  },
});
```

- [ ] **Step 5: Create `packages/web/src/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 6: Create `packages/web/index.html`** (fonts here so they load in dev + prod)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Synapse · Minerva Auto-Register</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `packages/web/src/App.tsx`** (minimal shell now; expanded in Task 11)

```tsx
export default function App() {
  return <div className="app-shell">Synapse</div>;
}
```

- [ ] **Step 8: Create `packages/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/theme.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: Create a placeholder `packages/web/src/theme/theme.css`** (replaced in Task 2; needed so main.tsx imports resolve)

```css
@import 'tailwindcss';
```

- [ ] **Step 10: Delete the old stub**

```bash
git rm packages/web/src/index.ts
```

- [ ] **Step 11: Replace root `vitest.config.ts` with a two-project config**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{shared,server}/src/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
      './packages/web/vitest.config.ts',
    ],
  },
});
```

- [ ] **Step 12: Add web lint block + browser globals to `eslint.config.mjs`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  prettier,
);
```

- [ ] **Step 13: Add root devDeps + a `build:web` script. Edit root `package.json`** — add to `devDependencies`: `"eslint-plugin-react-hooks": "^5.1.0"`, `"globals": "^15.14.0"`; add to `scripts`: `"build:web": "npm run build -w @autoregister/web"`.

- [ ] **Step 14: Install**

Run: `npm install`
Expected: installs without peer-dep errors; `package-lock.json` updated.

- [ ] **Step 15: Verify scaffold builds, typechecks, lints**

Run: `npm run build -w @autoregister/web && npm run typecheck && npm run lint`
Expected: web builds to `packages/web/dist`; typecheck + lint pass with no errors.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold Vite + React + TS + Tailwind + Vitest"
```

---

## Task 2: Synapse theme — tokens + component classes (ported from approved mockup)

**Files:**
- Modify: `packages/web/src/theme/theme.css`

These classes reproduce the approved mockup (`dashboard-v3.html`) so React components stay thin and visually faithful.

- [ ] **Step 1: Replace `packages/web/src/theme/theme.css`**

```css
@import 'tailwindcss';

@theme {
  --color-bg: #06060a;
  --color-pur: #a78bfa;
  --color-pur-d: #8b5cf6;
  --color-cyan: #22d3ee;
  --color-cyan-d: #06b6d4;
  --color-green: #34d399;
  --color-amber: #fbbf24;
  --color-red: #f87171;
  --font-serif: 'Instrument Serif', serif;
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

:root {
  --panel: rgba(255, 255, 255, 0.035);
  --panel-2: rgba(255, 255, 255, 0.05);
  --bd: rgba(255, 255, 255, 0.09);
  --bd-2: rgba(255, 255, 255, 0.14);
  --tx: #e7e7ee;
  --tx-2: #9aa0ac;
  --tx-3: #6b7280;
}

html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--color-bg);
  color: var(--tx);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  background-image:
    radial-gradient(60vw 50vh at 12% -8%, rgba(139, 92, 246, 0.2), transparent 60%),
    radial-gradient(55vw 50vh at 95% 8%, rgba(34, 211, 238, 0.16), transparent 60%),
    radial-gradient(40vw 40vh at 70% 110%, rgba(139, 92, 246, 0.1), transparent 60%);
}
.serif { font-family: var(--font-serif); font-weight: 400; letter-spacing: 0.2px; }
.mono { font-family: var(--font-mono); }
.glass { background: var(--panel); border: 1px solid var(--bd); border-radius: 16px; backdrop-filter: blur(14px); }

.app-shell { padding: 22px 26px 40px; max-width: 1280px; margin: 0 auto; }

/* nav pills */
.nav { display: flex; gap: 6px; padding: 5px; border-radius: 999px; }
.pill { padding: 8px 16px; border-radius: 999px; color: var(--tx-2); font-weight: 500; font-size: 13px; cursor: pointer; background: none; border: 0; }
.pill-on { background: linear-gradient(135deg, rgba(139, 92, 246, 0.9), rgba(34, 211, 238, 0.6)); color: #0a0a12; font-weight: 600; box-shadow: 0 0 18px rgba(139, 92, 246, 0.45); }

/* ticker */
.ticker { display: flex; margin-bottom: 18px; overflow: hidden; }
.ticker .cell { flex: 1; padding: 12px 18px; border-right: 1px solid var(--bd); }
.ticker .cell:last-child { border-right: 0; }
.ticker .k { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--tx-3); }
.ticker .v { font-size: 19px; margin-top: 3px; }
.ticker .v small { font-size: 12px; color: var(--tx-2); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: middle; background: var(--tx-3); }
.dot-ok { background: var(--color-green); box-shadow: 0 0 10px var(--color-green); }
.dot-warn { background: var(--color-amber); box-shadow: 0 0 10px var(--color-amber); }

/* buttons */
.btn { border: 1px solid var(--bd-2); background: var(--panel-2); color: var(--tx); padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-accent { background: linear-gradient(135deg, var(--color-pur-d), var(--color-cyan-d)); border: 0; color: #fff; box-shadow: 0 0 16px rgba(139, 92, 246, 0.4); }

/* badges */
.badge { font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.4px; }
.b-watch { color: var(--color-cyan); background: rgba(34, 211, 238, 0.12); border: 1px solid rgba(34, 211, 238, 0.35); }
.b-wait { color: var(--color-amber); background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.35); }
.b-reg { color: var(--color-green); background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.35); }
.b-pause, .b-stop { color: var(--tx-2); background: rgba(255, 255, 255, 0.06); border: 1px solid var(--bd); }
.b-err { color: var(--color-red); background: rgba(248, 113, 113, 0.12); border: 1px solid rgba(248, 113, 113, 0.35); }

/* stat grid */
.stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 14px 0 6px; }
.stat { text-align: center; padding: 8px 4px; border-radius: 10px; background: rgba(255, 255, 255, 0.025); border: 1px solid var(--bd); }
.stat .sk { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--tx-3); }
.stat .sv { font-family: var(--font-mono); font-size: 18px; font-weight: 500; margin-top: 2px; }
.stat-hot .sv { color: var(--color-green); }
.stat-wl .sv { color: var(--color-amber); }

/* card */
.card { padding: 16px 18px; }
.card .row1 { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card .title { font-size: 17px; font-weight: 600; }
.card .crn { font-family: var(--font-mono); color: var(--tx-2); font-size: 12px; margin-top: 2px; }
.card .row3 { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.card .meta { font-size: 11px; color: var(--tx-3); margin-top: 9px; font-family: var(--font-mono); }

/* toggle */
.toggle { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--tx-2); }
.sw { width: 42px; height: 23px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); border: 1px solid var(--bd); position: relative; cursor: pointer; padding: 0; }
.sw-on { background: linear-gradient(135deg, var(--color-pur-d), var(--color-cyan-d)); }
.sw i { position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: 0.2s; }
.sw-on i { left: 21px; }

/* layout grid + columns */
.grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 18px; align-items: start; }
.col-h { display: flex; align-items: center; justify-content: space-between; margin: 2px 4px 12px; }
.col-h h2 { font-size: 21px; margin: 0; }
.cards { display: flex; flex-direction: column; gap: 14px; }

/* console */
.console { height: 560px; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.console .bar { display: flex; align-items: center; gap: 7px; padding: 12px 16px; border-bottom: 1px solid var(--bd); }
.console .bar .c { width: 11px; height: 11px; border-radius: 50%; }
.cr { background: #ff5f57; } .cy { background: #febc2e; } .cg { background: #28c840; }
.console .bar .t { margin-left: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--tx-2); }
.log { flex: 1; overflow: auto; padding: 12px 16px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.85; }
.log .ts { color: var(--tx-3); }
.log .ln { white-space: pre-wrap; }
.l-info { color: #9aa0ac; } .l-ok { color: var(--color-green); } .l-action { color: var(--color-cyan); } .l-warn { color: var(--color-amber); } .l-err { color: var(--color-red); }

/* misc */
.banner { padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; border: 1px solid rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.1); color: var(--color-amber); font-size: 13px; }
.empty { text-align: center; color: var(--tx-3); padding: 40px; }
.errbar { color: var(--color-red); font-size: 12px; margin-top: 8px; }
```

- [ ] **Step 2: Verify build still works**

Run: `npm run build -w @autoregister/web`
Expected: builds; `dist/assets` contains a CSS file.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/theme/theme.css
git commit -m "feat(web): Synapse theme tokens + component classes"
```

---

## Task 3: `lib/format.ts` — pure formatters (TDD)

**Files:**
- Create: `packages/web/src/lib/format.ts`
- Test: `packages/web/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing test — `packages/web/src/lib/format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { fmtClock, fmtCountdown, fmtRelative } from './format';

describe('format', () => {
  it('fmtClock renders HH:MM:SS from an epoch ms', () => {
    const ts = new Date(2026, 5, 2, 9, 5, 3).getTime();
    expect(fmtClock(ts)).toBe('09:05:03');
  });

  it('fmtCountdown shows MM:SS until a future time, 00:00 when past', () => {
    const now = 1_000_000;
    expect(fmtCountdown(now + 125_000, now)).toBe('02:05');
    expect(fmtCountdown(now - 5_000, now)).toBe('00:00');
  });

  it('fmtRelative gives compact "Xm ago" / "just now"', () => {
    const now = 1_000_000;
    expect(fmtRelative(now - 5_000, now)).toBe('just now');
    expect(fmtRelative(now - 120_000, now)).toBe('2m ago');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/format.test.ts`
Expected: FAIL — cannot find module `./format`.

- [ ] **Step 3: Implement `packages/web/src/lib/format.ts`**

```ts
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local HH:MM:SS for an epoch-ms timestamp. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** MM:SS remaining until `target`; clamps to 00:00 once past. */
export function fmtCountdown(target: number, now = Date.now()): string {
  const ms = Math.max(0, target - now);
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Compact "just now" / "Nm ago" / "Nh ago". */
export function fmtRelative(ts: number, now = Date.now()): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/format.ts packages/web/src/lib/format.test.ts
git commit -m "feat(web): format helpers (clock/countdown/relative)"
```

---

## Task 4: `lib/api.ts` — typed REST client (TDD)

**Files:**
- Create: `packages/web/src/lib/api.ts`
- Test: `packages/web/src/lib/api.test.ts`

- [ ] **Step 1: Write the failing test — `packages/web/src/lib/api.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api', () => {
  it('getTargets GETs /api/targets and returns parsed JSON', async () => {
    const f = mockFetch([{ id: 't1' }]);
    vi.stubGlobal('fetch', f);
    const out = await api.getTargets();
    expect(f).toHaveBeenCalledWith('/api/targets', undefined);
    expect(out).toEqual([{ id: 't1' }]);
  });

  it('addTarget POSTs JSON body', async () => {
    const f = mockFetch({ id: 'new' });
    vi.stubGlobal('fetch', f);
    await api.addTarget({ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/targets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ subject: 'COMP', mode: 'auto' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('runTarget POSTs to /api/targets/:id/run', async () => {
    const f = mockFetch({ started: true });
    vi.stubGlobal('fetch', f);
    const out = await api.runTarget('abc');
    expect(f.mock.calls[0][0]).toBe('/api/targets/abc/run');
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(out).toEqual({ started: true });
  });

  it('throws on non-ok response', async () => {
    const f = mockFetch({ error: 'bad' }, false, 400);
    vi.stubGlobal('fetch', f);
    await expect(api.getBudget()).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/api.test.ts`
Expected: FAIL — cannot find module `./api`.

- [ ] **Step 3: Implement `packages/web/src/lib/api.ts`**

```ts
import type { LogEvent, Settings, WatchTarget } from '@autoregister/shared';

export interface BudgetRemaining {
  query: number;
  register: number;
}
export type SessionStatus = 'unknown' | 'authenticated' | 'logged-out' | 'logging-in';
export interface SessionInfo {
  status: SessionStatus;
}

type NewTarget = Pick<WatchTarget, 'term' | 'subject' | 'courseNumber' | 'targetCrn' | 'mode'> &
  Partial<Pick<WatchTarget, 'faculty' | 'label'>>;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return req<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  getTargets: () => req<WatchTarget[]>('/api/targets'),
  addTarget: (t: NewTarget) => post<WatchTarget>('/api/targets', t),
  updateTarget: (id: string, patch: Partial<WatchTarget>) =>
    req<WatchTarget>(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeTarget: (id: string) => req<{ ok: true }>(`/api/targets/${id}`, { method: 'DELETE' }),
  runTarget: (id: string) => post<{ started: boolean }>(`/api/targets/${id}/run`),

  getSettings: () => req<Settings>('/api/settings'),
  putSettings: (patch: Partial<Settings>) =>
    req<Settings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  getSession: () => req<SessionInfo>('/api/session'),
  login: () => post<{ started: boolean }>('/api/session/login'),

  startScheduler: () => post<{ running: boolean }>('/api/scheduler/start'),
  stopScheduler: () => post<{ running: boolean }>('/api/scheduler/stop'),

  getEvents: (limit = 200) => req<LogEvent[]>(`/api/events?limit=${limit}`),
  getBudget: () => req<BudgetRemaining>('/api/budget'),
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/api.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/api.test.ts
git commit -m "feat(web): typed REST API client"
```

---

## Task 5: `lib/useResource.ts` — GET hook with load + refetch (TDD)

**Files:**
- Create: `packages/web/src/lib/useResource.ts`
- Test: `packages/web/src/lib/useResource.test.tsx`

- [ ] **Step 1: Write the failing test — `packages/web/src/lib/useResource.test.tsx`**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource } from './useResource';

describe('useResource', () => {
  it('loads data and exposes it', async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    const { result } = renderHook(() => useResource(fetcher));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeUndefined();
  });

  it('captures errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toBe('nope');
  });

  it('refetch re-runs the fetcher', async () => {
    let n = 1;
    const fetcher = vi.fn().mockImplementation(async () => n++);
    const { result } = renderHook(() => useResource(fetcher));
    await waitFor(() => expect(result.current.data).toBe(1));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/useResource.test.tsx`
Expected: FAIL — cannot find module `./useResource`.

- [ ] **Step 3: Implement `packages/web/src/lib/useResource.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;
}

/** Run `fetcher` on mount; expose data/loading/error + a manual refetch. */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
    // fetcher identity is controlled by the caller (usually a stable api.* ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/useResource.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/useResource.ts packages/web/src/lib/useResource.test.tsx
git commit -m "feat(web): useResource GET hook"
```

---

## Task 6: `lib/useEventStream.ts` — WebSocket hook (TDD)

**Files:**
- Create: `packages/web/src/lib/useEventStream.ts`
- Test: `packages/web/src/lib/useEventStream.test.tsx`

- [ ] **Step 1: Write the failing test — `packages/web/src/lib/useEventStream.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEventStream } from './useEventStream';

class FakeWS {
  static last: FakeWS | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    FakeWS.last = this;
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  FakeWS.last = undefined;
});

describe('useEventStream', () => {
  it('seeds from a recent snapshot then appends events; tracks connected', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream(5));

    act(() => FakeWS.last!.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => FakeWS.last!.emit({ type: 'recent', events: [{ id: 'a', ts: 1, level: 'info', message: 'x' }] }));
    expect(result.current.events).toHaveLength(1);

    act(() => FakeWS.last!.emit({ type: 'event', event: { id: 'b', ts: 2, level: 'ok', message: 'y' } }));
    expect(result.current.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('caps the buffer to `max`', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream(2));
    act(() => {
      for (let i = 0; i < 4; i++) FakeWS.last!.emit({ type: 'event', event: { id: `e${i}`, ts: i, level: 'info', message: '' } });
    });
    expect(result.current.events.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('marks disconnected on close', () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    const { result } = renderHook(() => useEventStream());
    act(() => FakeWS.last!.onopen?.());
    act(() => FakeWS.last!.onclose?.());
    expect(result.current.connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/lib/useEventStream.test.tsx`
Expected: FAIL — cannot find module `./useEventStream`.

- [ ] **Step 3: Implement `packages/web/src/lib/useEventStream.ts`**

```ts
import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '@autoregister/shared';

interface StreamState {
  events: LogEvent[];
  connected: boolean;
}

/** Subscribe to /api/stream: seed from the `recent` snapshot, append `event`
 * messages (capped at `max`), and auto-reconnect with backoff on close. */
export function useEventStream(max = 500): StreamState {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let ws: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const cap = (arr: LogEvent[]) => (arr.length > max ? arr.slice(-max) : arr);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/stream`);
      ws.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as
          | { type: 'recent'; events: LogEvent[] }
          | { type: 'event'; event: LogEvent };
        if (msg.type === 'recent') setEvents(cap(msg.events));
        else setEvents((prev) => cap([...prev, msg.event]));
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current++);
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.close();
    };
  }, [max]);

  return { events, connected };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/lib/useEventStream.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/useEventStream.ts packages/web/src/lib/useEventStream.test.tsx
git commit -m "feat(web): useEventStream WebSocket hook with reconnect"
```

---

## Task 7: `StatusBadge` + `StatGrid` components (TDD)

**Files:**
- Create: `packages/web/src/components/StatusBadge.tsx`, `packages/web/src/components/StatGrid.tsx`
- Test: `packages/web/src/components/StatusBadge.test.tsx`, `packages/web/src/components/StatGrid.test.tsx`

- [ ] **Step 1: Write failing tests**

`packages/web/src/components/StatusBadge.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders the status label and the matching class', () => {
    const { container } = render(<StatusBadge status="waitlisted" />);
    expect(screen.getByText('WAITLISTED')).toBeInTheDocument();
    expect(container.querySelector('.b-wait')).not.toBeNull();
  });
});
```

`packages/web/src/components/StatGrid.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatGrid } from './StatGrid';

const stats = { crn: '2347', cap: 180, act: 180, rem: 0, wlcap: 40, wlact: 38, wlrem: 2 };

describe('StatGrid', () => {
  it('renders all six values', () => {
    render(<StatGrid stats={stats} />);
    for (const v of ['180', '0', '40', '38', '2']) expect(screen.getAllByText(v).length).toBeGreaterThan(0);
    expect(screen.getByText('cap')).toBeInTheDocument();
    expect(screen.getByText('wlrem')).toBeInTheDocument();
  });

  it('shows a placeholder when stats are absent', () => {
    render(<StatGrid stats={undefined} />);
    expect(screen.getAllByText('—').length).toBe(6);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/web/src/components/StatusBadge.test.tsx packages/web/src/components/StatGrid.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/web/src/components/StatusBadge.tsx`**

```tsx
import type { WatchStatus } from '@autoregister/shared';

const CLASS: Record<WatchStatus, string> = {
  watching: 'b-watch',
  waitlisted: 'b-wait',
  registered: 'b-reg',
  paused: 'b-pause',
  stopped: 'b-stop',
  error: 'b-err',
};

export function StatusBadge({ status }: { status: WatchStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{status.toUpperCase()}</span>;
}
```

- [ ] **Step 4: Implement `packages/web/src/components/StatGrid.tsx`**

```tsx
import type { SectionStats } from '@autoregister/shared';

const KEYS: { k: keyof SectionStats; label: string; cls?: string }[] = [
  { k: 'cap', label: 'cap' },
  { k: 'act', label: 'act' },
  { k: 'rem', label: 'rem' },
  { k: 'wlcap', label: 'wlcap', cls: 'stat-wl' },
  { k: 'wlact', label: 'wlact', cls: 'stat-wl' },
  { k: 'wlrem', label: 'wlrem', cls: 'stat-wl' },
];

export function StatGrid({ stats }: { stats?: SectionStats }) {
  return (
    <div className="stats">
      {KEYS.map(({ k, label, cls }) => (
        <div key={label} className={`stat ${cls ?? ''}`}>
          <div className="sk">{label}</div>
          <div className="sv">{stats ? String(stats[k]) : '—'}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run packages/web/src/components/StatusBadge.test.tsx packages/web/src/components/StatGrid.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/StatusBadge.tsx packages/web/src/components/StatGrid.tsx packages/web/src/components/StatusBadge.test.tsx packages/web/src/components/StatGrid.test.tsx
git commit -m "feat(web): StatusBadge + StatGrid components"
```

---

## Task 8: `ModeToggle` + `CourseCard` components (TDD)

**Files:**
- Create: `packages/web/src/components/ModeToggle.tsx`, `packages/web/src/components/CourseCard.tsx`
- Test: `packages/web/src/components/CourseCard.test.tsx`

- [ ] **Step 1: Write the failing test — `packages/web/src/components/CourseCard.test.tsx`**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CourseCard } from './CourseCard';
import type { WatchTarget } from '@autoregister/shared';

const target: WatchTarget = {
  id: 't1',
  label: 'COMP 551',
  term: '202701',
  subject: 'COMP',
  courseNumber: '551',
  targetCrn: '2347',
  mode: 'notify',
  status: 'watching',
  createdAt: 0,
  lastStats: { crn: '2347', cap: 180, act: 180, rem: 0, wlcap: 40, wlact: 38, wlrem: 2 },
};

describe('CourseCard', () => {
  it('renders title, CRN, badge and stats', () => {
    render(<CourseCard target={target} onToggleMode={() => {}} onRun={() => {}} />);
    expect(screen.getByText(/COMP 551/)).toBeInTheDocument();
    expect(screen.getByText(/CRN 2347/)).toBeInTheDocument();
    expect(screen.getByText('WATCHING')).toBeInTheDocument();
  });

  it('fires onToggleMode with the flipped mode', async () => {
    const onToggleMode = vi.fn();
    render(<CourseCard target={target} onToggleMode={onToggleMode} onRun={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /toggle mode/i }));
    expect(onToggleMode).toHaveBeenCalledWith('t1', 'auto');
  });

  it('fires onRun with the target id when Register now is clicked', async () => {
    const onRun = vi.fn();
    render(<CourseCard target={target} onToggleMode={() => {}} onRun={onRun} />);
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    expect(onRun).toHaveBeenCalledWith('t1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/components/CourseCard.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/web/src/components/ModeToggle.tsx`**

```tsx
import type { WatchMode } from '@autoregister/shared';

export function ModeToggle({ mode, onToggle }: { mode: WatchMode; onToggle: (next: WatchMode) => void }) {
  const auto = mode === 'auto';
  return (
    <div className="toggle">
      Notify
      <button
        type="button"
        aria-label="toggle mode"
        aria-pressed={auto}
        className={`sw ${auto ? 'sw-on' : ''}`}
        onClick={() => onToggle(auto ? 'notify' : 'auto')}
      >
        <i />
      </button>
      Auto
    </div>
  );
}
```

- [ ] **Step 4: Implement `packages/web/src/components/CourseCard.tsx`**

```tsx
import type { WatchMode, WatchTarget } from '@autoregister/shared';
import { StatGrid } from './StatGrid';
import { StatusBadge } from './StatusBadge';
import { ModeToggle } from './ModeToggle';
import { fmtRelative } from '../lib/format';

interface Props {
  target: WatchTarget;
  onToggleMode: (id: string, next: WatchMode) => void;
  onRun: (id: string) => void;
  running?: boolean;
}

export function CourseCard({ target, onToggleMode, onRun, running }: Props) {
  const title = target.label ?? `${target.subject} ${target.courseNumber}`;
  const canRun = target.status === 'watching';
  return (
    <div className="card glass">
      <div className="row1">
        <div>
          <div className="title">{title}</div>
          <div className="crn">
            CRN {target.targetCrn} · {target.term}
          </div>
        </div>
        <StatusBadge status={target.status} />
      </div>

      <StatGrid stats={target.lastStats} />

      <div className="row3">
        <ModeToggle mode={target.mode} onToggle={(next) => onToggleMode(target.id, next)} />
        <button
          type="button"
          className="btn btn-accent"
          disabled={!canRun || running}
          onClick={() => onRun(target.id)}
        >
          {running ? '… running' : '⚡ Register now'}
        </button>
      </div>

      <div className="meta">
        {target.lastPolledAt ? `last poll ${fmtRelative(target.lastPolledAt)}` : 'not polled yet'}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run packages/web/src/components/CourseCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/ModeToggle.tsx packages/web/src/components/CourseCard.tsx packages/web/src/components/CourseCard.test.tsx
git commit -m "feat(web): ModeToggle + CourseCard components"
```

---

## Task 9: `Console` component (TDD)

**Files:**
- Create: `packages/web/src/components/Console.tsx`
- Test: `packages/web/src/components/Console.test.tsx`

- [ ] **Step 1: Write the failing test — `packages/web/src/components/Console.test.tsx`**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Console } from './Console';
import type { LogEvent } from '@autoregister/shared';

const events: LogEvent[] = [
  { id: '1', ts: new Date(2026, 5, 2, 10, 42, 1).getTime(), level: 'info', message: 'polling…' },
  { id: '2', ts: new Date(2026, 5, 2, 10, 42, 9).getTime(), level: 'ok', message: 'joined waitlist' },
];

describe('Console', () => {
  it('renders each event with a level class and clock timestamp', () => {
    const { container } = render(<Console events={events} connected={true} />);
    expect(screen.getByText('polling…')).toBeInTheDocument();
    expect(container.querySelector('.l-ok')).not.toBeNull();
    expect(screen.getByText('10:42:01')).toBeInTheDocument();
  });

  it('shows a disconnected indicator when not connected', () => {
    render(<Console events={[]} connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/components/Console.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/components/Console.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import type { LogEvent, LogLevel } from '@autoregister/shared';
import { fmtClock } from '../lib/format';

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'l-info',
  ok: 'l-ok',
  action: 'l-action',
  warn: 'l-warn',
  error: 'l-err',
};

export function Console({ events, connected }: { events: LogEvent[]; connected: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="console glass">
      <div className="bar">
        <span className="c cr" /> <span className="c cy" /> <span className="c cg" />
        <span className="t">autoregister · {connected ? 'live stream' : 'reconnecting…'}</span>
      </div>
      <div className="log" ref={logRef}>
        {events.map((e) => (
          <div className="ln" key={e.id}>
            <span className="ts">{fmtClock(e.ts)}</span>{' '}
            <span className={LEVEL_CLASS[e.level]}>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/web/src/components/Console.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Console.tsx packages/web/src/components/Console.test.tsx
git commit -m "feat(web): live Console component"
```

---

## Task 10: `Ticker` + `NavPills` components (TDD)

**Files:**
- Create: `packages/web/src/components/Ticker.tsx`, `packages/web/src/components/NavPills.tsx`
- Test: `packages/web/src/components/Ticker.test.tsx`

- [ ] **Step 1: Write the failing test — `packages/web/src/components/Ticker.test.tsx`**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Ticker } from './Ticker';

describe('Ticker', () => {
  it('renders the live counters', () => {
    render(
      <Ticker
        watching={3}
        intervalMinutes={30}
        jitterMinutes={3}
        queryUsed={12}
        queryBudget={100}
        registerUsed={1}
        registerBudget={20}
        sessionStatus="authenticated"
      />,
    );
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/src/components/Ticker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/components/Ticker.tsx`**

```tsx
import type { SessionStatus } from '../lib/api';

interface Props {
  watching: number;
  intervalMinutes: number;
  jitterMinutes: number;
  queryUsed: number;
  queryBudget: number;
  registerUsed: number;
  registerBudget: number;
  sessionStatus: SessionStatus;
}

const SESSION_LABEL: Record<SessionStatus, { text: string; dot: string }> = {
  authenticated: { text: 'Active', dot: 'dot-ok' },
  'logging-in': { text: 'Logging in', dot: 'dot-warn' },
  'logged-out': { text: 'Logged out', dot: '' },
  unknown: { text: 'Unknown', dot: '' },
};

export function Ticker(p: Props) {
  const s = SESSION_LABEL[p.sessionStatus];
  return (
    <div className="ticker glass">
      <div className="cell">
        <div className="k">Watching</div>
        <div className="v">{p.watching}</div>
      </div>
      <div className="cell">
        <div className="k">Interval</div>
        <div className="v">
          {p.intervalMinutes} <small>± {p.jitterMinutes} min</small>
        </div>
      </div>
      <div className="cell">
        <div className="k">Today · Query</div>
        <div className="v mono">
          {p.queryUsed} / {p.queryBudget}
        </div>
      </div>
      <div className="cell">
        <div className="k">Today · Register</div>
        <div className="v mono">
          {p.registerUsed} / {p.registerBudget}
        </div>
      </div>
      <div className="cell">
        <div className="k">Session</div>
        <div className="v">
          <span className={`dot ${s.dot}`} />
          {s.text}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `packages/web/src/components/NavPills.tsx`**

```tsx
import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/courses', label: 'Courses' },
  { to: '/session', label: 'Session' },
  { to: '/settings', label: 'Settings' },
];

export function NavPills() {
  return (
    <div className="nav glass">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => `pill ${isActive ? 'pill-on' : ''}`}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run packages/web/src/components/Ticker.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/Ticker.tsx packages/web/src/components/NavPills.tsx packages/web/src/components/Ticker.test.tsx
git commit -m "feat(web): Ticker + NavPills components"
```

---

## Task 11: App shell + router + Dashboard page (TDD smoke)

**Files:**
- Create: `packages/web/src/pages/Dashboard.tsx`, `packages/web/src/pages/Courses.tsx`, `packages/web/src/pages/Session.tsx`, `packages/web/src/pages/Settings.tsx`
- Modify: `packages/web/src/App.tsx`, `packages/web/src/main.tsx`
- Test: `packages/web/src/pages/Dashboard.test.tsx`

- [ ] **Step 1: Create P7b placeholder pages**

`packages/web/src/pages/Courses.tsx`:

```tsx
export default function Courses() {
  return <div className="empty">Course configuration — coming in P7b.</div>;
}
```

`packages/web/src/pages/Session.tsx`:

```tsx
export default function Session() {
  return <div className="empty">Session management — coming in P7b.</div>;
}
```

`packages/web/src/pages/Settings.tsx`:

```tsx
export default function Settings() {
  return <div className="empty">Settings — coming in P7b.</div>;
}
```

- [ ] **Step 2: Write the failing test — `packages/web/src/pages/Dashboard.test.tsx`**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import { api } from '../lib/api';

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({ events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }], connected: true }),
}));

afterEach(() => vi.restoreAllMocks());

describe('Dashboard', () => {
  it('loads targets and renders a card + console', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 88, register: 19 });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.getByText('hello-console')).toBeInTheDocument();
    expect(screen.getByText('Watched Courses')).toBeInTheDocument();
  });

  it('shows the empty state when there are no targets', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'logged-out' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/web/src/pages/Dashboard.test.tsx`
Expected: FAIL — cannot find module `./Dashboard`.

- [ ] **Step 4: Implement `packages/web/src/pages/Dashboard.tsx`** (Ticker is rendered by the shell in `App.tsx`, so Dashboard only needs targets + session + the event stream)

```tsx
import { useCallback } from 'react';
import type { WatchMode } from '@autoregister/shared';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { useEventStream } from '../lib/useEventStream';
import { CourseCard } from '../components/CourseCard';
import { Console } from '../components/Console';

export default function Dashboard() {
  const targets = useResource(useCallback(() => api.getTargets(), []));
  const session = useResource(useCallback(() => api.getSession(), []));
  const { events, connected } = useEventStream();

  const onToggleMode = useCallback(
    async (id: string, next: WatchMode) => {
      await api.updateTarget(id, { mode: next });
      await targets.refetch();
    },
    [targets],
  );

  const onRun = useCallback(async (id: string) => {
    await api.runTarget(id);
  }, []);

  const list = targets.data ?? [];
  const sessionStatus = session.data?.status ?? 'unknown';
  const sessionDown = sessionStatus === 'logged-out' || sessionStatus === 'unknown';

  return (
    <>
      {sessionDown && (
        <div className="banner">
          Session is not active — open the <strong>Session</strong> tab to log in so polling can run.
        </div>
      )}

      <div className="grid">
        <div>
          <div className="col-h">
            <h2 className="serif">Watched Courses</h2>
          </div>
          {list.length === 0 ? (
            <div className="empty glass">No courses watched yet. Add one from the Courses tab.</div>
          ) : (
            <div className="cards">
              {list.map((t) => (
                <CourseCard key={t.id} target={t} onToggleMode={onToggleMode} onRun={onRun} />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="col-h">
            <h2 className="serif">Live Console</h2>
          </div>
          <Console events={events} connected={connected} />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Implement `packages/web/src/App.tsx`** (shell with NavPills + Ticker + routed outlet)

```tsx
import { useCallback } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { useResource } from './lib/useResource';
import { NavPills } from './components/NavPills';
import { Ticker } from './components/Ticker';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Session from './pages/Session';
import Settings from './pages/Settings';

function Shell() {
  const targets = useResource(useCallback(() => api.getTargets(), []));
  const budget = useResource(useCallback(() => api.getBudget(), []));
  const session = useResource(useCallback(() => api.getSession(), []));
  const settings = useResource(useCallback(() => api.getSettings(), []));

  const s = settings.data;
  const queryBudget = s?.queryBudget ?? 100;
  const registerBudget = s?.registerBudget ?? 20;

  return (
    <div className="app-shell">
      <div className="top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h1 className="serif" style={{ fontSize: 30, margin: 0 }}>
          Synapse
        </h1>
        <NavPills />
      </div>
      <Ticker
        watching={(targets.data ?? []).filter((t) => t.status === 'watching').length}
        intervalMinutes={s?.pollIntervalMinutes ?? 30}
        jitterMinutes={s?.jitterMinutes ?? 3}
        queryUsed={queryBudget - (budget.data?.query ?? queryBudget)}
        queryBudget={queryBudget}
        registerUsed={registerBudget - (budget.data?.register ?? registerBudget)}
        registerBudget={registerBudget}
        sessionStatus={session.data?.status ?? 'unknown'}
      />
      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="courses" element={<Courses />} />
        <Route path="session" element={<Session />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 6: Update `packages/web/src/main.tsx`** to wrap in the router

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './theme/theme.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 7: Run the Dashboard test to verify it passes**

Run: `npx vitest run packages/web/src/pages/Dashboard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 8: Typecheck + build the web app**

Run: `npm run typecheck -w @autoregister/web && npm run build -w @autoregister/web`
Expected: no type errors; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): App shell + router + live Dashboard page"
```

---

## Task 12: Server — `Scheduler.runOnce(force)` + `runTarget` (TDD)

**Files:**
- Modify: `packages/server/src/scheduler/scheduler.ts`
- Modify: `packages/server/src/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add a failing test to `packages/server/src/scheduler/scheduler.test.ts`** (append as the last `it(...)` inside the existing `describe('Scheduler.runOnce', ...)` block). It uses the file's existing `setup()` helper and `FakeActor` (which exposes `.calls` and `.lastArgs`) — mirrors the existing "notify mode does NOT act" test but passes `{ force: true }`:

```ts
  it('force-runs a notify-mode target: acts despite the mode gate', async () => {
    const { scheduler, store, actor, target } = setup({
      mode: 'notify',
      decision: { action: 'WAITLIST', reason: 'wlrem>0' },
      outcome: { kind: 'waitlisted', crn: '1814' },
    });
    await scheduler.runOnce(target.id, { force: true });
    expect(actor.calls).toBe(1);
    expect(actor.lastArgs).toEqual(['202701', '1814', 'WAITLIST']);
    expect(store.getTarget(target.id)!.status).toBe('waitlisted');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: FAIL — `runOnce` ignores the `opts` arg, so notify-mode still skips `act`; `actor.act` not called.

- [ ] **Step 3: Modify `runOnce` signature + the mode gate in `packages/server/src/scheduler/scheduler.ts`**

Change the method signature:

```ts
  async runOnce(targetId: string, opts: { force?: boolean } = {}): Promise<void> {
```

Change the notify-mode gate (currently `if (target.mode === 'notify') { … }`) to:

```ts
    if (!opts.force && target.mode === 'notify') {
      this.log('ok', `Notify-only: ${action} available — awaiting your go.`, targetId, { action });
      this.scheduleNext(target);
      return;
    }
```

- [ ] **Step 4: Add the `runTarget` method** (place it just after `runOnce`)

```ts
  /** Trigger an immediate forced run for one target (one-click "Register now").
   * Fire-and-forget; results surface via the event stream like a normal tick. */
  runTarget(id: string): void {
    void this.runOnce(id, { force: true });
  }
```

- [ ] **Step 5: Run to verify the new test + all scheduler tests pass**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: PASS (existing notify test still passes — it calls `runOnce` without `force`; new force test passes).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/scheduler/scheduler.ts packages/server/src/scheduler/scheduler.test.ts
git commit -m "feat(server): Scheduler.runOnce(force) + runTarget for one-click execute"
```

---

## Task 13: Server — `POST /api/targets/:id/run` endpoint (TDD)

**Files:**
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/server.test.ts`

- [ ] **Step 1: Add the `runTarget` method to the test's scheduler stub** in `packages/server/src/api/server.test.ts` — update `makeDeps()` so the scheduler stub is:

```ts
    scheduler: { start: () => undefined, stop: () => undefined, runTarget: () => undefined },
```

(also update the inline scheduler stubs in the other tests that build a server, e.g. the lazy-check and login-timeout tests, to include `runTarget: () => undefined`.)

- [ ] **Step 2: Write the failing tests** (append inside `describe('API', …)`)

```ts
  it('POST /api/targets/:id/run triggers runTarget for an existing target', async () => {
    const store = new Store(dir);
    const t = store.addTarget({ term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'notify' });
    const runTarget = vi.fn();
    const app2 = buildServer({
      store,
      budget: new Budget(store),
      session: { launch: async () => undefined, ensureLoggedIn: async () => undefined, isLoggedIn: async () => true },
      scheduler: { start: () => undefined, stop: () => undefined, runTarget },
    });
    const r = await app2.inject({ method: 'POST', url: `/api/targets/${t.id}/run` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: true });
    expect(runTarget).toHaveBeenCalledWith(t.id);
    await app2.close();
  });

  it('POST /api/targets/:id/run returns 404 for a missing target', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/targets/nope/run' });
    expect(r.statusCode).toBe(404);
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run packages/server/src/api/server.test.ts`
Expected: FAIL — route 404 for the first test (endpoint doesn't exist) and `runTarget` not on the `ApiScheduler` type.

- [ ] **Step 4: Add `runTarget` to the `ApiScheduler` interface in `packages/server/src/api/server.ts`**

```ts
export interface ApiScheduler {
  start(tickMs?: number): void;
  stop(): void;
  runTarget(id: string): void;
}
```

- [ ] **Step 5: Add the route** (place after the `DELETE /api/targets/:id` handler)

```ts
  app.post('/api/targets/:id/run', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.store.getTarget(id)) return reply.code(404).send({ error: 'not found' });
    deps.scheduler.runTarget(id);
    return { started: true };
  });
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run packages/server/src/api/server.test.ts`
Expected: PASS (all API tests, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/api/server.ts packages/server/src/api/server.test.ts
git commit -m "feat(server): POST /api/targets/:id/run (one-click execute)"
```

---

## Task 14: Server — serve the built web `dist` (static + SPA fallback)

**Files:**
- Modify: `packages/server/package.json` (add `@fastify/static`)
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/server.test.ts`

- [ ] **Step 1: Add the dependency**

Edit `packages/server/package.json` — add to `dependencies`: `"@fastify/static": "^8.0.3"`. Then run `npm install`.

- [ ] **Step 2: Write a failing test** (append inside `describe('API', …)` in `server.test.ts`) — proves API still works when no `dist` is present (static registration must be conditional, not crash)

```ts
  it('serves API normally even when no web dist is present', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.json()).toEqual({ ok: true });
  });
```

> (This passes once the static block is correctly gated behind `existsSync`. It guards against a regression where unconditional static registration throws when `dist` is missing in CI.)

- [ ] **Step 3: Add static serving to `buildServer` in `packages/server/src/api/server.ts`**

Add imports at the top:

```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
```

Add this near the end of `buildServer`, just before `return app;`:

```ts
  // Serve the built web UI from packages/web/dist when present (one-process use).
  const webDist =
    process.env.AUTOREG_WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist });
    // SPA fallback: non-API, non-file GETs return index.html (client-side routing).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }
```

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run packages/server/src/api/server.test.ts`
Expected: PASS — health test green; no `dist` in the test env so the static block is skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/src/api/server.ts packages/server/src/api/server.test.ts
git commit -m "feat(server): serve built web dist with SPA fallback"
```

---

## Task 15: Final wiring + full verification

**Files:**
- Modify: root `package.json` (a convenience `serve` script that builds web then serves)

- [ ] **Step 1: Add a convenience script.** Edit root `package.json` `scripts` — add:

```json
    "serve": "npm run build:web && npm run serve -w @autoregister/server"
```

- [ ] **Step 2: Run the full test suite (node + web projects)**

Run: `npm run test`
Expected: all node + web tests pass.

- [ ] **Step 3: Run lint + typecheck across the monorepo**

Run: `npm run lint && npm run typecheck`
Expected: no errors in any package.

- [ ] **Step 4: Build the web app**

Run: `npm run build:web`
Expected: `packages/web/dist/index.html` + assets produced.

- [ ] **Step 5: Manual smoke (flag to user; not automated).** Note for the human operator: `npm run serve`, open `http://127.0.0.1:4575`, confirm the Dashboard renders with the Synapse theme, the console connects (WS), and nav pills route. (Requires a logged-in session for live data; empty state is fine without one.)

- [ ] **Step 6: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: add serve script (build web + run server)"
```

---

## Self-Review notes (resolved during planning)

- **Spec coverage:** scaffold (T1), theme (T2), data layer api/useResource/useEventStream/format (T3–T6), Dashboard components + page + shell/router/ticker (T7–T11), one-click execute endpoint + scheduler force (T12–T13), static serving (T14), build/serve wiring + verification (T15). Courses/Session/Settings are P7b — included here only as placeholder pages so routing works.
- **Type consistency:** `api.ts` exports `SessionStatus`/`BudgetRemaining` used by `Ticker`/`Dashboard`/`App`; `ApiScheduler.runTarget(id)` matches `Scheduler.runTarget(id)` and the test stubs; `runOnce(targetId, opts)` is backward-compatible (existing callers pass one arg).
- **WS protocol:** `useEventStream` parses `{type:'recent',events}` and `{type:'event',event}` — matches `server.ts` `/api/stream` + `broadcast`.
- **Test env:** root `vitest.config.ts` splits node (`packages/{shared,server}`) vs web (jsdom, tsx); web deps (react plugin, jsdom, testing-library) live in `packages/web`.
