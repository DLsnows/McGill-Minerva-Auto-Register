# P5b — Notifier (desktop / sound / email) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Deliver important scheduler events through desktop notifications, sound, and email (in addition to the always-on in-app log). Wire it to the scheduler's `onEvent`.

**Architecture:** A pure `shouldNotify()` + `buildNotification()` (testable), and a `Notifier` that dispatches to channels: desktop+sound via `node-notifier`, email via `nodemailer` (SMTP from a gitignored `.env`). Channels toggle via `Settings.notify`. Email is disabled gracefully if SMTP isn't configured.

**Tech Stack:** TypeScript, node-notifier, nodemailer, dotenv, Vitest.

---

### Task 1: Branch + tick — (P5b shares the P5 row; no TODO change needed beyond a note)

- [ ] `git checkout dev && git pull origin dev`; `git checkout -b p5b-notifier`

---

### Task 2: Settings.notify (shared)

- [ ] Add to `Settings`: `notify: { desktop: boolean; sound: boolean; email: boolean }`; default `{ desktop: true, sound: true, email: false }`. Update `DEFAULT_SETTINGS`. `npm run typecheck`.

---

### Task 3: Pure notification policy (TDD)

**Files:** `packages/server/src/notifier/notification.ts` + `.test.ts`

- [ ] `shouldNotify(event: LogEvent): boolean` — true for significant events only: `level` of `action` | `ok` | `warn` | `error` (NOT routine `info`). 
- [ ] `buildNotification(event): { title: string; body: string }` — concise title by level (e.g. "✅ Registered", "⚠️ Action needed", "❌ Error", "🔔 Opening found") + body = message.
- [ ] Tests: info → no notify; ok/action/warn/error → notify; titles/bodies built correctly.

---

### Task 4: Notifier (channels)

**Files:** `packages/server/src/notifier/notifier.ts`; `packages/server/src/notifier/email.ts`

- [ ] `email.ts`: build a nodemailer transport from env (`AUTOREG_SMTP_HOST`, `_PORT`, `_USER`, `_PASS`, `AUTOREG_EMAIL_TO`); `isEmailConfigured()`; `sendEmail(subject, text)`. If unconfigured, `isEmailConfigured()` is false and sends are skipped.
- [ ] `Notifier` class: `constructor(getSettings: () => Settings)`. `async notify(event)`: if `!shouldNotify` return; build notification; if `settings.notify.desktop` → `node-notifier.notify({ title, message, sound: settings.notify.sound })`; if `settings.notify.email && isEmailConfigured()` → `sendEmail`. All channel sends wrapped in try/catch + warn (a failing channel never breaks others).
- [ ] (Channel side-effects are not unit-tested; the pure policy in Task 3 is.)

---

### Task 5: Wire into runtime + load .env

- [ ] `runtime.ts`: at top, load `.env` via `dotenv` (`import 'dotenv/config'` guarded so tests don't require it). Build a `Notifier` from `store.getSettings`; pass `onEvent: (e) => void notifier.notify(e)` into the Scheduler (compose with any caller-provided onEvent).

---

### Task 6: Email setup guide + .env.example

**Files:** `docs/EMAIL_SETUP.md`, `.env.example`, README section

- [ ] `.env.example` with the SMTP vars + comments. `.env.example` is NOT gitignored (`.env` is).
- [ ] `docs/EMAIL_SETUP.md`: step-by-step (Gmail app-password walkthrough + generic SMTP), exactly what to put in `.env`.

---

### Task 7: Verify, commit, push, PR

- [ ] `npm run typecheck && lint && test` → PASS. Commit, push `p5b-notifier`, open PR, notify user (include the email setup steps to follow).

---

## Self-Review Notes
- **Spec coverage:** §10 (desktop/sound/email/in-app, trigger events) — Tasks 3–5. ✓
- **No placeholders:** policy + notifier contracts concrete; channel sends documented.
- **Privacy:** SMTP creds only in gitignored `.env`; `.env.example` has placeholders.
