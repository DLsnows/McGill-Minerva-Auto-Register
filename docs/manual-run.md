# Manual "⚡ Register now" — response contract and cooldown

Audit items **Q16 / Q23 / Q60** (`docs/plans/2026-09-15-audit-inventory.md`).

## Why this exists

`POST /api/targets/:id/run` used to answer `{ started: true }` unconditionally. Two
different outcomes were therefore indistinguishable to the caller:

- the cycle was **accepted** and is running in the background, or
- the request was **dropped** — a per-target cycle was already in flight, or (after
  Q23) the manual cooldown had not elapsed.

In the dropped case the Dashboard cleared its "… running" state as soon as the POST
returned, so the button flashed and nothing appeared to happen, even though the
click had been discarded.

The per-target in-flight guard itself is **kept**: it is what stops a manual run and
the tick loop from double-registering the same course (`scheduler.test.ts`,
"skips a concurrent run of the same target (no double registration)"). This change
only makes the guard's verdict expressible.

## Response contract

`POST /api/targets/:id/run` always answers **200** with one of:

| Body                                                   | Meaning                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `{ started: true }`                                    | Accepted. The cycle runs asynchronously; its result arrives as events. |
| `{ started: false, reason: 'in progress' }`            | A cycle for this target is already running; this request was dropped.  |
| `{ started: false, reason: 'cooldown', retryAfterMs }` | The manual cooldown has not elapsed. `retryAfterMs` is the time left.  |
| `{ started: false, reason: 'target is <status>' }`     | The target is not `watching` (paused / registered / error / …).        |
| `404 { error: 'not found' }`                           | No such target.                                                        |

Every 200 body also carries:

- **`retryAfterMs`** — how much of the manual cooldown is left (the full window on
  acceptance, the remainder on a `'cooldown'` rejection, `0`/absent otherwise).
  This is the value the UI counts down from: a _duration_, anchored to the moment
  the response arrived on the client's own clock, so no clock agreement between
  client and server is needed.
- **`lastForcedRunAt`** — the target's stored window start (epoch ms, omitted when
  it never had a forced run). Informational: it lets a freshly-loaded page show
  that a window is still running without asking again.

An accepted run therefore answers
`{ started: true, retryAfterMs: 60000, lastForcedRunAt: <now> }`.

**On clock skew**: the countdown is driven by `retryAfterMs`, never by
subtracting the client's clock from a server epoch — that arithmetic would make it
skew-sensitive. The one place a server epoch is used ([`cooldownRemainingMs`] with
`target.lastForcedRunAt`) is a fallback for a freshly-loaded page with no local
estimate, so a skewed clock can briefly enable the button early or late there. That
is cosmetic only: the server re-checks every request, so the throttle itself is
never affected.

[`cooldownRemainingMs`]: ../packages/web/src/lib/api.ts

`started` describes **this request**, never the outcome of the cycle. A cycle that
ends in a registration error still answers `{ started: true }` and reports the
failure through the event stream — the same way a scheduled tick does.

Consumers of this shape:

- `packages/web/src/lib/api.ts` — `RunTargetResult`, `MANUAL_RUN_COOLDOWN_MS`,
  `cooldownRemainingMs`
- `packages/web/src/pages/Dashboard.tsx` — `onRun` renders the verdict
- `packages/web/src/components/CourseCard.tsx` — `runNotice` / `coolingUntil`
  (the countdown notice is derived, not stored, so it ticks and clears itself)
- `e2e/fake-server.mjs` — mirrors the contract (and the cooldown) for preview e2e
- `e2e/run.mjs` — `run-cooldown-feedback` case asserts it end to end

## Cooldown

`MANUAL_RUN_COOLDOWN_MS = 60_000` (1 minute), in
`packages/server/src/scheduler/scheduler.ts`.

- **Scope**: manual forced runs only. Scheduled ticks never consult it — the
  cooldown must not slow down normal watching.
- **Start**: when the run is _accepted_, not when it finishes, so mashing the
  button during a slow cycle cannot line up back-to-back queries.
- **Persistence**: `WatchTarget.lastForcedRunAt` in `data/store.json`, written
  through the normal store path, so the throttle survives a restart.
- **Why 1 minute**: manual runs bypass `nextPollAt` by design, so without a floor
  each click is a real Minerva query (bounded only by the shared daily query
  budget). 60s absorbs double-clicks and button-mashing while still letting a user
  retry right after reading the previous result. It is deliberately not a setting:
  the point is a floor on human-triggered pacing, in the spirit of
  `packages/server/src/util/pacing.ts`.
- **UI copy** (`packages/web/src/i18n/index.ts`, namespace `run.*`, zh/en/fr):
  `run.cooldown` — "Manual checks are throttled to one per minute to stay
  human-like. Try again in {{s}}s." The card shows the verdict and disables the
  button for the rest of the window; `run.cooldown` is the only place the duration
  is stated to the user, so the two must be changed together. `run.dropped` is the
  neutral fallback for a reason the UI does not recognise.
- **Feedback lifecycle**: the card shows `run.starting` while the POST is in
  flight, then:
  - **accepted** → the notice is dropped and the card switches to the cooldown
    notice, because acceptance itself starts the window (the cycle's own event
    lands in the console, and the card's "last poll" catches up);
  - **cooldown** → the notice is _derived_ from `cooldownRemainingMs(...)`, so it
    counts down every second and disappears when the window really ends, and the
    button is disabled for exactly that window (a frozen string used to outlive
    the window and sit next to an enabled button);
  - **in progress** → the reason stays visible until the next run;
  - **unknown reason** → rendered as "this check was not started (<reason>)",
    never as a guess about the course's state.
- **What disables the button**: the same derived value — primarily the
  `retryAfterMs` duration anchored when the answer arrived (skew-free), falling
  back to `target.lastForcedRunAt + MANUAL_RUN_COOLDOWN_MS` when the page has no
  local estimate. It is a UI courtesy only: the server re-checks every request.
