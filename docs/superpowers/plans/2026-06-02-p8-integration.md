# P8 — Integration, dry-run rehearsal, docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings-toggled dry-run (rehearsal) mode and finalize the user-facing docs, completing the project.

**Architecture:** A `dryRun` boolean on `Settings` (default false). The scheduler, just before it would call `actor.act`, short-circuits when `dryRun` is on — logging `DRY-RUN: would …` instead of registering (no register-budget spend, status unchanged). Query/decision/notification all still run, so the full chain is rehearsed against live Minerva safely. Plus a rewritten README and updated TODO.

**Tech Stack:** TypeScript (shared/server/web), Vitest, Fastify/zod, React + react-i18next.

**Reference:** Design spec `docs/superpowers/specs/2026-06-02-p8-integration-design.md`. Scheduler injection point: `runCycle`, after the notify-gate, before the `budget.canRegister` / `actor.act` block (covers both auto and forced/one-click runs).

---

## File Structure

```
packages/shared/src/store-types.ts            # MODIFY: Settings.dryRun + DEFAULT_SETTINGS
packages/server/src/scheduler/scheduler.ts    # MODIFY: dry-run short-circuit before act
packages/server/src/scheduler/scheduler.test.ts # MODIFY: dry-run tests
packages/server/src/api/server.ts             # MODIFY: settingsSchema.dryRun
packages/server/src/api/server.test.ts        # MODIFY: PUT settings dryRun test
packages/web/src/i18n/index.ts                # MODIFY: settings.dryRun + dryRunAria (en/zh/fr)
packages/web/src/pages/Settings.tsx           # MODIFY: Dry-run checkbox
packages/web/src/pages/Settings.test.tsx      # MODIFY: dry-run save test
README.md                                     # REWRITE: full user + dev guide
TODO.md                                        # MODIFY: mark P6/P7/P8 done
```

---

## Task 1: `Settings.dryRun` on the shared type

**Files:**
- Modify: `packages/shared/src/store-types.ts`

- [ ] **Step 1: Add `dryRun` to the `Settings` interface** — after the `email?` field, add it as **optional** (it always has a value via `DEFAULT_SETTINGS`; optional keeps existing `getSettings` mocks across web tests from becoming type errors):

```ts
  /** Rehearsal mode: poll + decide normally but never actually submit a
   * registration (logs "would register" instead). Default false. */
  dryRun?: boolean;
```

- [ ] **Step 2: Add `dryRun: false` to `DEFAULT_SETTINGS`** — in the `DEFAULT_SETTINGS` object, add `dryRun: false,` (e.g. right after `registerBudget: 20,`).

- [ ] **Step 3: Typecheck shared**

Run: `npm run typecheck -w @autoregister/shared`
Expected: passes (no other shared code references Settings exhaustively).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/store-types.ts
git commit -m "feat(shared): add Settings.dryRun (default false)"
```

---

## Task 2: Scheduler dry-run short-circuit (TDD)

**Files:**
- Modify: `packages/server/src/scheduler/scheduler.ts`
- Modify: `packages/server/src/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add failing tests** — append inside `describe('Scheduler.runOnce', ...)` (uses the file's existing `setup()` + `FakeActor.calls`):

```ts
  it('dry-run: auto + opening logs "would" and does NOT act', async () => {
    const { scheduler, store, actor, budget, target } = setup({
      decision: { action: 'REGISTER', reason: 'rem>0' },
      outcome: { kind: 'registered', crn: '1814' },
    });
    store.setSettings({ dryRun: true });
    const before = budget.remaining(NOW).register;
    await scheduler.runOnce(target.id);
    expect(actor.calls).toBe(0);
    expect(store.getTarget(target.id)!.status).toBe('watching');
    expect(budget.remaining(NOW).register).toBe(before); // register budget untouched
    expect(store.recentEvents().some((e) => /DRY-RUN: would REGISTER/.test(e.message))).toBe(true);
  });

  it('dry-run also applies to a forced (one-click) run', async () => {
    const { scheduler, store, actor, target } = setup({
      mode: 'notify',
      decision: { action: 'WAITLIST', reason: 'wlrem>0' },
      outcome: { kind: 'waitlisted', crn: '1814' },
    });
    store.setSettings({ dryRun: true });
    await scheduler.runOnce(target.id, { force: true });
    expect(actor.calls).toBe(0);
    expect(store.recentEvents().some((e) => /DRY-RUN: would WAITLIST/.test(e.message))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: FAIL — actor IS called (no dry-run guard yet), so `actor.calls` is 1.

- [ ] **Step 3: Add the dry-run short-circuit in `scheduler.ts`** — in `runCycle`, between the notify-gate block and the `// auto mode → act` / `budget.canRegister` block, insert:

```ts
    if (store.getSettings().dryRun) {
      this.log('action', `DRY-RUN: would ${action} ${target.targetCrn} — ${check.decision.reason}`, targetId, {
        stats: check.stats,
        decision: check.decision,
      });
      this.scheduleNext(target);
      return;
    }

    // auto mode → act
```

(Insert immediately before the existing `// auto mode → act` comment + `if (!budget.canRegister(now)) {`.)

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/server/src/scheduler/scheduler.test.ts`
Expected: PASS — all scheduler tests (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scheduler/scheduler.ts packages/server/src/scheduler/scheduler.test.ts
git commit -m "feat(server): dry-run mode — log would-register instead of acting"
```

---

## Task 3: API settings schema accepts `dryRun` (TDD)

**Files:**
- Modify: `packages/server/src/api/server.ts`
- Modify: `packages/server/src/api/server.test.ts`

- [ ] **Step 1: Add a failing test** — append inside `describe('API', ...)`:

```ts
  it('accepts and persists the dryRun setting', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { dryRun: true } });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().dryRun).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/api/server.test.ts`
Expected: FAIL — `dryRun` is stripped by the schema (unknown key), so `get.json().dryRun` is `false` (the DEFAULT), not `true`.

- [ ] **Step 3: Add `dryRun` to `settingsSchema` in `server.ts`** — inside the `.object({ ... })` (before `.partial()`), add:

```ts
    dryRun: z.boolean(),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/server/src/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/server.ts packages/server/src/api/server.test.ts
git commit -m "feat(server): accept dryRun in settings schema"
```

---

## Task 4: Settings page Dry-run checkbox (TDD)

**Files:**
- Modify: `packages/web/src/i18n/index.ts`
- Modify: `packages/web/src/pages/Settings.tsx`
- Modify: `packages/web/src/pages/Settings.test.tsx`

- [ ] **Step 1: Add i18n keys** — in each of `en` / `zh` / `fr` `settings` blocks, add two keys:

en:
```ts
    dryRun: 'Dry-run (rehearsal) mode', dryRunAria: 'Dry-run mode',
```
zh:
```ts
    dryRun: 'Dry-run(演练）模式', dryRunAria: '演练模式',
```
fr:
```ts
    dryRun: 'Mode simulation (dry-run)', dryRunAria: 'Mode simulation',
```

- [ ] **Step 2: Add a failing test** — append inside `describe('Settings', ...)` in `Settings.test.tsx`:

```ts
  it('saves the dry-run toggle', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false }, dryRun: true,
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true })));
  });
```

> Note: `dryRun` is optional on `Settings`, so `mockAll()` returning settings without it stays valid; the component treats `form.dryRun` as `undefined`→unchecked until toggled.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/web/src/pages/Settings.test.tsx`
Expected: FAIL — no `Dry-run mode` control found.

- [ ] **Step 4: Add the checkbox to `Settings.tsx`** — inside the first `.card.glass` (general settings), after the notify-channels `<div style={{ display: 'flex', gap: 18, marginTop: 14 }}>…</div>`, add:

```tsx
        <div style={{ marginTop: 14 }}>
          <label>
            <input
              type="checkbox"
              aria-label={t('settings.dryRunAria')}
              checked={form.dryRun ?? false}
              onChange={(e) => setForm({ ...form, dryRun: e.target.checked })}
            />{' '}
            {t('settings.dryRun')}
          </label>
        </div>
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run packages/web/src/pages/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck web**

Run: `npm run typecheck -w @autoregister/web`
Expected: passes. (`Settings.dryRun` is `boolean` on the type; `form` is `Settings`, so `form.dryRun` is `boolean` — `?? false` is harmless.)

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/i18n/index.ts packages/web/src/pages/Settings.tsx packages/web/src/pages/Settings.test.tsx
git commit -m "feat(web): Settings dry-run toggle (en/zh/fr)"
```

---

## Task 5: Rewrite README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`** with the final user + dev guide:

````markdown
# AutoRegister — McGill Minerva course auto-register

A local web app that watches McGill Minerva course sections and registers (or
waitlists) you automatically when a seat opens. It reuses your **already-logged-in
browser session** (so 2FA isn't re-prompted), polls on a jittered interval to stay
within the school's daily operation limits, and decides register / waitlist / no-op
from each section's seat counts — acting automatically or just notifying you.

> ⚠️ Personal automation for **your own** registration. Use responsibly and in
> accordance with McGill's terms of use. There is a **dry-run** mode (below) to
> rehearse safely before letting it act for real.

## Requirements

- **Node 22+**
- A Chromium for Playwright: `npm run browser:install` (one-time)

## Install

```bash
npm install
npm run browser:install   # installs Playwright Chromium
```

## Run

```bash
npm run serve
```

Then open **http://127.0.0.1:4575** and:

1. **Session** tab → *Open browser & log in*. A Chromium window opens; sign in via
   McGill SSO once. (McGill allows **one active session** — logging in elsewhere
   evicts the automation.)
2. **Courses** tab → add the course(s) to watch. Hover the `?` on each field for
   help; the **Term** is the Minerva term code (Winter = …01, Summer = …05,
   Fall = …09, e.g. Winter 2027 = `202701`).
3. **Settings** tab → poll interval & jitter, daily query/register budgets,
   notification channels (desktop / sound / email — see
   [`docs/EMAIL_SETUP.md`](docs/EMAIL_SETUP.md)), and **Dry-run** mode.
4. **Dashboard** → press **Start** to begin watching. The live console streams
   each poll → decision → action. Use **⚡ Register now** to attempt a course
   immediately.

Language can be switched any time (中文 / EN / FR) from the top bar.

## Dry-run (rehearsal)

Turn on **Dry-run** in Settings to rehearse the whole pipeline against live Minerva
**without ever submitting a registration**. The scheduler still logs in, polls,
and decides — but where it would register/waitlist it instead logs
`DRY-RUN: would REGISTER <CRN>` and leaves the course watching. Watch the console
to confirm it behaves as expected, then turn dry-run off to let it act for real.

## How it works

- **Decision**: from `cap/act/rem` and `wlcap/wlact/wlrem` → REGISTER (open seat),
  WAITLIST (waitlist space), or NO-OP.
- **Pacing**: a base interval (default 30 min) ± jitter, stretched to keep the
  daily **query budget** (default 100) and **register budget** (default 20) from
  running out — to look human and respect school limits.
- **Per course**: `auto` registers/waitlists automatically; `notify` only alerts you.

## Development

```bash
npm run lint
npm run typecheck
npm run test          # Vitest (node + web/jsdom projects)
npm run build:web     # production web build (served by the server)
```

Node + TypeScript monorepo (npm workspaces): `packages/{shared,server,web}` —
Playwright (browser automation), Fastify + WebSocket (API), React + Vite + Tailwind
(Synapse-themed, i18n) UI.

Design & plans: [`docs/superpowers/`](docs/superpowers/).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README as the full user + dev guide"
```

---

## Task 6: Update TODO.md + final verification

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Update the Phases list in `TODO.md`** — mark P6/P7/P8 done and note the P7 split:

```markdown
- [x] **P6 — api**: REST + WebSocket
- [x] **P7 — web**: Synapse UI wired to API (P7a scaffold+Dashboard, P7b Courses/Session/Settings + data provider, P7c i18n zh/en/fr, P7d Courses-form help + faculty required)
- [x] **P8 — integration**: dry-run rehearsal mode + README/docs
```

- [ ] **Step 2: Full test suite**

Run: `npm run test`
Expected: all node + web tests pass.

- [ ] **Step 3: Lint + typecheck + build**

Run: `npm run lint && npm run typecheck && npm run build:web`
Expected: clean; web builds.

- [ ] **Step 4: Runtime smoke (flag to user; not automated).** `npm run serve`, open the app, toggle Dry-run in Settings, add a course, Start the scheduler, and confirm the console shows `DRY-RUN: would …` rather than a real registration (needs a logged-in session for live data).

- [ ] **Step 5: Commit**

```bash
git add TODO.md
git commit -m "docs: mark P6/P7/P8 complete in TODO"
```

---

## Self-Review notes (resolved during planning)

- **Spec coverage:** dry-run type (T1), scheduler short-circuit incl. forced runs (T2), API schema (T3), Settings UI toggle + i18n (T4), README rewrite (T5), TODO + verification (T6).
- **Injection point:** the dry-run guard sits after the notify-gate and before `budget.canRegister`/`actor.act`, so both auto and forced (one-click) runs are covered and the register budget is never spent in dry-run. Confirmed against the current `runCycle` structure.
- **Type consistency:** `Settings.dryRun?: boolean` (shared, optional) ↔ `settingsSchema.dryRun: z.boolean()` inside `.partial()` (api) ↔ `form.dryRun ?? false` (web). `DEFAULT_SETTINGS.dryRun = false` ensures every runtime read path gets a defined value.
- **Test stability:** `dryRun` is **optional** on the type, so the existing `getSettings` mocks across web tests (which omit it) stay valid — no ripple. Scheduler reads `store.getSettings().dryRun` (boolean | undefined; `if (dryRun)` treats undefined as false).
- **Notifications:** dry-run logs a normal `action` event, so it flows through the existing notifier/WS like any other event — rehearsing notifications too (spec §2).
