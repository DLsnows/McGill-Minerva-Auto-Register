# P5a — Store + Budget + Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Persist watch targets / event log / settings / daily op-counts; enforce daily query+register budgets; and run the scheduler that, per target on a jittered interval, checks the session, queries, decides, and either auto-acts or records a "found" event — wiring P1–P4 together.

**Architecture:** A dependency-injected `Scheduler` orchestrates per-target cycles using the P3 `QueryClient`, P4 `RegisterClient`, a `Store`, and a `Budget`. Persistence is a small atomic JSON-file store (no native deps; capped event log). The scheduler is unit-tested with fakes (no real browser/clock).

**Tech Stack:** TypeScript, Node fs (JSON store), Vitest. **No better-sqlite3** (native-build risk on Windows/Node 25) — JSON file store instead.

**Notifier note:** P5a emits structured log events via the Store + an in-process event callback. Real desktop/sound/email delivery is P5b.

---

### Task 1: Branch + tick P4 in TODO

- [ ] `git checkout dev && git pull origin dev`; `git checkout -b p5a-store-scheduler`
- [ ] In `TODO.md`, set P4 line to `- [x] **P4 — minerva-client/register**: ...`

---

### Task 2: Shared data-model types

**Files:** Create `packages/shared/src/store-types.ts`; export from `index.ts`

- [ ] **Step 1: Create `store-types.ts`**

```ts
import type { CourseQuery } from './query';

export type WatchMode = 'auto' | 'notify';
export type WatchStatus = 'watching' | 'paused' | 'registered' | 'waitlisted' | 'stopped' | 'error';

/** A configured course the user wants watched. Extends the query with policy + state. */
export interface WatchTarget extends CourseQuery {
  id: string;
  label?: string; // e.g. "COMP 551"
  mode: WatchMode;
  status: WatchStatus;
  lastStats?: import('./types').SectionStats;
  lastPolledAt?: number;
  nextPollAt?: number;
  createdAt: number;
}

export type LogLevel = 'info' | 'action' | 'ok' | 'warn' | 'error';

export interface LogEvent {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
  targetId?: string;
  data?: unknown;
}

export interface Settings {
  pollIntervalMinutes: number; // default 30
  jitterMinutes: number; // default 3
  queryBudget: number; // default 100/day
  registerBudget: number; // default 20/day
}

export interface DailyOps {
  date: string; // YYYY-MM-DD (local)
  queryCount: number;
  registerCount: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMinutes: 30,
  jitterMinutes: 3,
  queryBudget: 100,
  registerBudget: 20,
};
```

- [ ] **Step 2:** export the new types from `shared/src/index.ts`; `npm run typecheck`.

---

### Task 3: JSON store (TDD)

**Files:** Create `packages/server/src/store/store.ts` + `store.test.ts`; add config `DATA_DIR`.

Behavior: one JSON file under `data/` (gitignored), atomic write (write temp + rename). Holds `{ targets, events, settings, dailyOps }`. Event log capped to the most recent `MAX_EVENTS` (e.g. 2000).

- [ ] **Step 1: Write failing tests** (use a temp dir via `AUTOREG_DATA_DIR`): add/get/update/remove targets; append events + cap; get/set settings (defaults when absent); daily-ops get/increment with date rollover; persistence across `new Store()` instances.

- [ ] **Step 2: Implement `store.ts`** with methods:

```ts
class Store {
  constructor(dir?: string);
  // targets
  listTargets(): WatchTarget[];
  getTarget(id): WatchTarget | undefined;
  addTarget(t: Omit<WatchTarget,'id'|'createdAt'|'status'> & Partial<Pick<WatchTarget,'status'>>): WatchTarget;
  updateTarget(id, patch: Partial<WatchTarget>): WatchTarget | undefined;
  removeTarget(id): void;
  // events (capped, newest-last)
  appendEvent(e: Omit<LogEvent,'id'|'ts'> & { ts?: number }): LogEvent;
  recentEvents(limit = 200): LogEvent[];
  // settings
  getSettings(): Settings;
  setSettings(patch: Partial<Settings>): Settings;
  // daily ops
  getDailyOps(now = Date.now()): DailyOps; // resets on date change
  incrementQuery(now?): void;
  incrementRegister(now?): void;
}
```

Implementation notes: load file on construct (or lazily); every mutation persists atomically; `id` via `crypto.randomUUID()`; date string via local `toISOString().slice(0,10)` adjusted to local — use a small `localDate(now)` helper.

- [ ] **Step 3:** tests PASS.

---

### Task 4: Budget (TDD)

**Files:** Create `packages/server/src/budget/budget.ts` + `.test.ts`

```ts
class Budget {
  constructor(private store: Store) {}
  canQuery(now?): boolean;       // dailyOps.queryCount < settings.queryBudget
  canRegister(now?): boolean;    // dailyOps.registerCount < settings.registerBudget
  recordQuery(now?): void;       // store.incrementQuery
  recordRegister(now?): void;
  remaining(now?): { query: number; register: number };
}
```

- [ ] Tests: at/over budget returns false; recording increments; rollover resets. PASS.

---

### Task 5: Scheduler (TDD with fakes)

**Files:** Create `packages/server/src/scheduler/scheduler.ts` + `.test.ts`

Dependencies (injected interfaces for testability):
```ts
interface Watcher { checkCourse(q: CourseQuery): Promise<{ stats: SectionStats; decision: Decision } | null>; }
interface Actor { act(term: string, crn: string, action: ActionKind): Promise<RegisterOutcome>; }
interface SessionGuard { ensureLoggedIn(onPrompt?: () => void): Promise<void>; isLoggedIn(): Promise<boolean>; }
```

`Scheduler` runs one **cycle per due target** (sequential), not a tight loop:

```
runOnce(target):
  if !budget.canQuery(): log warn "query budget reached"; return
  ensure session healthy (SessionGuard.isLoggedIn; if not -> log + set status 'paused' + return)
  check = watcher.checkCourse(target); budget.recordQuery()
  if !check: log warn "target CRN not found"; schedule next; return
  store.updateTarget(lastStats, lastPolledAt)
  switch check.decision.action:
    NOOP -> log info; schedule next
    REGISTER/WAITLIST ->
      log action "opening found"; emit found event (for P5b notify)
      if target.mode === 'notify': set status stays 'watching' + event flagged 'action_available'; schedule next
      if target.mode === 'auto':
        if !budget.canRegister(): log warn "register budget reached"; schedule next; return
        outcome = actor.act(term, crn, action); budget.recordRegister()
        on registered -> status 'registered' (stop); log ok
        on waitlisted -> status 'waitlisted' (stop); log ok
        on closed/waitlist-full/not-found -> log info; schedule next
        on error -> log error; schedule next  (keep watching)
  scheduleNext(target): nextPollAt = now + (interval ± jitter), budget-aware (stretch interval if remaining query budget is low for active target count)
```

- [ ] **Step 1: Write failing tests** with fake Watcher/Actor/SessionGuard + in-memory Store + fixed clock. Cover: NOOP keeps watching; REGISTER+auto → registered (stop); WAITLIST+auto → waitlisted (stop); notify mode → stays watching + found event; query budget exhausted → skips; register budget exhausted → no act; session logged-out → paused; actor error → keeps watching.

- [ ] **Step 2: Implement `scheduler.ts`** (pure orchestration; `scheduleNext` computes jittered, budget-aware `nextPollAt`; the real timer loop that calls `runOnce` for due targets is a thin wrapper `start()/stop()` using setTimeout, kept minimal and not unit-tested).

- [ ] **Step 3:** tests PASS.

---

### Task 6: Wire real adapters (no live calls in tests)

**Files:** Create `packages/server/src/scheduler/runtime.ts`

- [ ] A factory that builds a `Scheduler` with real `SessionManager`, `QueryClient`, `RegisterClient`, `Store`, `Budget`. Not unit-tested (integration wiring). Used later by the API (P6).

---

### Task 7: Verify, commit, push, PR

- [ ] `npm run typecheck && lint && test` → PASS.
- [ ] Confirm `data/` is gitignored (it is, from P0) and not staged.
- [ ] Commit, push `p5a-store-scheduler`, open PR to `dev`, notify user; wait for review + merge.

---

## Self-Review Notes

- **Spec coverage:** spec §4 (data model), §8 (budget-aware scheduling + jitter), §5 (per-target state machine), §11 (error isolation) — Tasks 3–5. ✓ (Pacing between browser ops already added in P4.)
- **No placeholders:** store/budget/scheduler method contracts concrete; scheduler logic spelled out as pseudocode to TDD against.
- **Deviation:** JSON-file store instead of better-sqlite3 (native-build risk). Flagged to user.
- **Deferred from P2:** `launch()` concurrency guard — add a simple `launching` promise in this phase's session wiring if convenient.
