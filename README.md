# AutoRegister — McGill Minerva course auto-register

A local web app that watches McGill Minerva course sections and registers (or
waitlists) you automatically when a seat opens. It reuses your **already-logged-in
browser session** (so 2FA isn't re-prompted), polls on a jittered interval to stay
within the school's daily operation limits, and decides register / waitlist / no-op
from each section's seat counts — acting automatically or just notifying you.

> ⚠️ Personal automation for **your own** registration. Use responsibly and in
> accordance with McGill's terms of use. There is a **dry-run** mode (below) to
> rehearse safely before letting it act for real.

## First time? Step-by-step setup (no command-line experience needed)

This walks you through everything from zero — you do **not** need to know how to
use a terminal. If you've done this kind of thing before, the concise
[Requirements](#requirements) / [Install](#install) / [Run](#run) sections below
are all you need.

### 1. Install Node.js (one time)

This app runs on **Node.js**. Go to **https://nodejs.org**, click the big green
**LTS** download button, open the downloaded file, and click **Next** through
the installer (the default options are fine). This also installs `npm`, which
the commands further down use. Without it, those commands won't exist.

### 2. Download the app

1. Open the project page: **https://github.com/DLsnows/McGill-Minerva-Auto-Register**
2. Near the top-left, the branch selector should say **`prod`** — that's the
   default branch, so it already does. (`prod` is the version to download.)
3. Click the green **`< > Code`** button, then **Download ZIP**.
4. Find the downloaded `.zip` (usually in your **Downloads** folder). On
   **Windows**, right-click it → **Extract All**; on **Mac**, double-click it.
   You'll get a folder named something like `McGill-Minerva-Auto-Register-prod`.
   Move it somewhere easy to find, like your **Desktop**.

### 3. Open a terminal *inside* that folder

A "terminal" is just a window where you type commands. It needs to be pointed at
the app's folder — that's what the `cd` ("change directory") command does. The
easy way to avoid typing the full path is to **drag the folder in**:

**Windows:**
1. Click **Start**, type **PowerShell**, and press **Enter**. A window opens.
2. Type `cd` followed by **one space** (don't press Enter yet).
3. **Drag the app folder** from your Desktop onto the PowerShell window — it
   pastes the folder's full path for you.
4. Press **Enter**. The text on the left now ends with the folder's name, which
   means you're "inside" it.

**Mac:**
1. Open **Terminal** (press **⌘ + Space**, type **Terminal**, press **Enter**).
2. Type `cd` followed by **one space**.
3. **Drag the app folder** onto the Terminal window to paste its path.
4. Press **Enter**.

### 4. Set up and start (first time)

Type each line below, press **Enter** after it, and wait for it to finish before
typing the next one:

```bash
npm install                       # download what the app needs (one time, ~1 min)
npx playwright install chromium   # download the browser it controls (one time)
npm run serve                     # start the app
```

After `npm run serve`, **leave this window open** — closing it shuts the app
down.

**To stop the app** when you're done, click the terminal window and press
**Ctrl + C** (hold **Ctrl**, press **C**). That's the proper way to quit — don't
just close the window. To start it again later, run `npm run serve` once more.

> **Every time after this**, you only need to open the terminal in the folder
> (step 3) and run `npm run serve`. The two install commands are one-time setup.

### 5. Open it in your browser

Open **any** browser (Chrome, Edge, Safari…) and go to:

**http://127.0.0.1:4575**

That's the app. Now follow the [Run](#run) steps below — log in, add your
course(s), and press **Start all**.

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
