# P1 — Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pure, fully-tested seat-decision engine in `packages/shared`: given one course section's seat stats, decide REGISTER / WAITLIST / NOOP.

**Architecture:** A single pure function `decide(stats)` with no IO, plus the shared types it uses. Lives in `packages/shared` so both the scheduler (P5) and tests consume it. The HTML parser that produces `SectionStats` is deferred to P3 (needs real Minerva HTML).

**Tech Stack:** TypeScript, Vitest.

**Scope note:** P1 is decision logic ONLY. No browser, no parser, no IO.

---

## Unified decision rule (confirmed with user)

Given `SectionStats { crn, cap, act, rem, wlcap, wlact, wlrem }`:

1. `hasWaitlist` = `Number.isInteger(wlcap) && wlcap > 0`
2. `canRegisterDirectly` = `rem > 0 && (!hasWaitlist || wlact === 0)`
3. If `canRegisterDirectly` → **REGISTER**
4. Else if `hasWaitlist && wlrem > 0` → **WAITLIST**
5. Else → **NOOP**

Covers all cases, including the user-confirmed edge case (empty waitlist + full class + `wlrem>0` → WAITLIST, grab #1).

---

### Task 1: Branch + tick P0 in TODO

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Ensure on dev, up to date**

Run: `git checkout dev && git pull origin dev`
Expected: branch `dev`, up to date (P0 squash commit present).

- [ ] **Step 2: Create P1 feature branch**

Run: `git checkout -b p1-decision-engine`
Expected: switched to new branch.

- [ ] **Step 3: Tick P0 in `TODO.md`**

Change the P0 line from `- [ ]` to `- [x]`:

```markdown
- [x] **P0 — Scaffolding**: monorepo, tooling, CI port, TODO, design doc
```

---

### Task 2: Shared types

**Files:**
- Create: `packages/shared/src/types.ts`

- [ ] **Step 1: Create `packages/shared/src/types.ts`**

```ts
/** Seat statistics for a single course section (one CRN), as read from Minerva. */
export interface SectionStats {
  /** 4-digit Course Reference Number. */
  crn: string;
  /** Capacity. */
  cap: number;
  /** Actual enrolled. */
  act: number;
  /** Remaining seats (cap - act). */
  rem: number;
  /** Waitlist capacity. */
  wlcap: number;
  /** Waitlist actual (people currently waitlisted). */
  wlact: number;
  /** Waitlist remaining. */
  wlrem: number;
}

/** The action the watcher should take for a section. */
export type ActionKind = 'REGISTER' | 'WAITLIST' | 'NOOP';

/** Result of the decision engine. */
export interface Decision {
  action: ActionKind;
  reason: string;
}
```

---

### Task 3: Decision engine (TDD)

**Files:**
- Create: `packages/shared/src/decision-engine.test.ts`
- Create: `packages/shared/src/decision-engine.ts`

- [ ] **Step 1: Write the failing tests `packages/shared/src/decision-engine.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { decide } from './decision-engine';
import type { SectionStats } from './types';

function stats(overrides: Partial<SectionStats>): SectionStats {
  return {
    crn: '1234',
    cap: 100,
    act: 100,
    rem: 0,
    wlcap: 0,
    wlact: 0,
    wlrem: 0,
    ...overrides,
  };
}

describe('decide', () => {
  it('REGISTERs when no waitlist and seats remain', () => {
    expect(decide(stats({ wlcap: 0, rem: 5 })).action).toBe('REGISTER');
  });

  it('NOOPs when no waitlist and class is full', () => {
    expect(decide(stats({ wlcap: 0, rem: 0 })).action).toBe('NOOP');
  });

  it('REGISTERs when waitlist exists but is empty and seats remain', () => {
    expect(decide(stats({ wlcap: 30, wlact: 0, wlrem: 30, rem: 2 })).action).toBe('REGISTER');
  });

  it('WAITLISTs when waitlist is empty, class is full, and waitlist has room (grab #1)', () => {
    expect(decide(stats({ wlcap: 30, wlact: 0, wlrem: 30, rem: 0 })).action).toBe('WAITLIST');
  });

  it('WAITLISTs when people are waitlisted, class is full, and waitlist has room', () => {
    expect(decide(stats({ wlcap: 20, wlact: 14, wlrem: 6, rem: 0 })).action).toBe('WAITLIST');
  });

  it('WAITLISTs (not REGISTER) when seats remain but waitlist is active (seats reserved)', () => {
    expect(decide(stats({ wlcap: 20, wlact: 14, wlrem: 6, rem: 3 })).action).toBe('WAITLIST');
  });

  it('NOOPs when waitlist is active but full, even if seats remain', () => {
    expect(decide(stats({ wlcap: 20, wlact: 20, wlrem: 0, rem: 3 })).action).toBe('NOOP');
  });

  it('NOOPs when waitlist is active and full and class is full', () => {
    expect(decide(stats({ wlcap: 20, wlact: 20, wlrem: 0, rem: 0 })).action).toBe('NOOP');
  });

  it('treats non-positive wlcap as no waitlist', () => {
    expect(decide(stats({ wlcap: 0, wlact: 0, wlrem: 0, rem: 1 })).action).toBe('REGISTER');
  });

  it('always returns a non-empty reason', () => {
    expect(decide(stats({ wlcap: 30, wlact: 14, wlrem: 6, rem: 0 })).reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- decision-engine`
Expected: FAIL — `decide` is not defined / module not found.

- [ ] **Step 3: Implement `packages/shared/src/decision-engine.ts`**

```ts
import type { Decision, SectionStats } from './types';

/**
 * Decide what to do for a single course section based on its seat stats.
 *
 * Rules (confirmed with user):
 *  - hasWaitlist          = wlcap is an integer > 0
 *  - canRegisterDirectly  = rem > 0 AND (no waitlist OR waitlist empty)
 *  1. canRegisterDirectly        -> REGISTER
 *  2. hasWaitlist && wlrem > 0    -> WAITLIST
 *  3. otherwise                   -> NOOP
 */
export function decide(s: SectionStats): Decision {
  const hasWaitlist = Number.isInteger(s.wlcap) && s.wlcap > 0;
  const canRegisterDirectly = s.rem > 0 && (!hasWaitlist || s.wlact === 0);

  if (canRegisterDirectly) {
    return {
      action: 'REGISTER',
      reason: hasWaitlist
        ? `Waitlist empty (wlact=0) and rem=${s.rem}>0 — register directly`
        : `No waitlist and rem=${s.rem}>0 — register directly`,
    };
  }

  if (hasWaitlist && s.wlrem > 0) {
    return {
      action: 'WAITLIST',
      reason:
        s.wlact > 0
          ? `Waitlist active (wlact=${s.wlact}) with room (wlrem=${s.wlrem}) — join waitlist`
          : `Class full (rem=0), waitlist empty with room (wlrem=${s.wlrem}) — join waitlist to be first`,
    };
  }

  return {
    action: 'NOOP',
    reason: hasWaitlist
      ? `No seat and waitlist full (wlrem=0) — wait`
      : `No waitlist and class full (rem=0) — wait`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- decision-engine`
Expected: PASS — all decision-engine tests pass.

---

### Task 4: Export from package index

**Files:**
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/src/index.test.ts` (placeholder no longer needed)

- [ ] **Step 1: Replace `packages/shared/src/index.ts`**

```ts
export * from './types';
export { decide } from './decision-engine';
```

- [ ] **Step 2: Delete the placeholder test**

Run: `git rm packages/shared/src/index.test.ts` (the VERSION placeholder test; real tests now exist).

- [ ] **Step 3: Verify full suite + lint + typecheck**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all PASS.

---

### Task 5: Commit, push, open PR

**Files:** none

- [ ] **Step 1: Commit**

```bash
git add packages/shared/src/ TODO.md
git commit -m "feat(shared): add seat decision engine with full test coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 2: Push**

Run: `git push -u origin p1-decision-engine`

- [ ] **Step 3: Open PR to dev**

```bash
gh pr create --base dev --head p1-decision-engine \
  --title "P1: seat decision engine" \
  --body "Pure, fully-tested decision engine in packages/shared: decide(stats) -> REGISTER/WAITLIST/NOOP. Implements P1 of the design spec. Parser deferred to P3 (needs real Minerva HTML)."
```

- [ ] **Step 4: Notify user (HUMAN-IN-THE-LOOP)** — report PR URL; wait for review + merge confirmation. Do NOT auto-merge unless the user says so.

---

## Self-Review Notes

- **Spec coverage:** decision rules from spec §6 + confirmed edge case — covered by `decide` and 10 tests. ✓
- **No placeholders:** all code concrete. ✓
- **Type consistency:** `SectionStats`/`Decision`/`ActionKind`/`decide` names consistent across types, engine, tests, index. ✓
