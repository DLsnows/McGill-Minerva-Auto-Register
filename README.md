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

- **Node.js 22+** — this also installs `npm`. Don't have Node yet? Download the
  LTS installer from the official site: **https://nodejs.org**. (Without Node
  installed, the `npm` / `npx` commands below won't exist.)
- Playwright's Chromium browser (a one-time download — see Install).

## Install

```bash
npm install                       # install dependencies
npx playwright install chromium   # one-time: download the Chromium that Playwright drives
```

> `npx playwright install chromium` downloads just the Chromium build the app
> needs (not all three browsers). It's the reliable way to install it — it works
> from the repo root regardless of the workspace layout.

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
   Fall = …09, e.g. Winter 2027 = `202701`). Faculty is required (e.g. `Faculty of Science`).
3. **Settings** tab → poll interval & jitter, daily query/register budgets,
   notification channels (desktop / sound / email — see
   [`docs/EMAIL_SETUP.md`](docs/EMAIL_SETUP.md)), and **Dry-run** mode.
4. **Dashboard** → press **Start all** to begin watching. (On startup every
   course is **paused**, and *Start all* is disabled until you're logged in — so
   nothing polls until you explicitly start it. You can also **Pause / Resume**
   each course individually on its card.) The live console streams each poll →
   decision → action, newest on top, with a **Clear** button. Use
   **⚡ Register now** on a card to attempt that course immediately.

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

## Troubleshooting

**Clicking *Open browser & log in* shows "Logged out" right away and no Chromium
window opens.** This means Playwright's Chromium isn't installed. The login flow
launches a real Chromium window; if the browser binary is missing, the launch
fails and the session falls straight back to *Logged out* with no window. Install
the browser once, then retry:

```bash
npx playwright install chromium
```

(If you ran `npm install` but skipped the Playwright browser download, this is
the most common cause.)

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
