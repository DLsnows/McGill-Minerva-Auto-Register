#!/usr/bin/env node
/**
 * Evidence probe for Q1 — "an unhandled rejection inside the scheduler's timer
 * callback terminates the Node process".
 *
 * Not part of the test suite (it forks the real process model on purpose). Run it
 * twice to see both halves of the fix:
 *
 *   node scripts/ci/probe-q1-exit.mjs legacy   # the pre-fix structure → exit code 1
 *   node scripts/ci/probe-q1-exit.mjs fixed    # the shipped structure → exit code 0
 *
 * `legacy` reproduces `scheduler.ts` before this branch verbatim in the parts that
 * matter: `setInterval` + `void tick().finally(...)` (no `.catch()`), a `tick()`
 * whose for-loop has no per-target try/catch, and an awaited session probe that
 * throws — the documented real-world trigger is the user closing the automation's
 * Chromium window, which makes the next `isLoggedIn()` throw.
 *
 * The probe reports the exit code and whether the second (healthy) target was
 * still polled, which is the other half of the defect: one bad target starving the
 * rest of the round.
 */

const MODE = process.argv[2] ?? 'legacy';
if (!['legacy', 'fixed'].includes(MODE)) {
  console.error(`probe-q1-exit: unknown mode "${MODE}" (expected legacy|fixed)`);
  process.exit(2);
}

let healthyPolls = 0;

/** Stands in for the real target cycle: the first target's session probe throws. */
async function runCycle(name) {
  if (name === 'closed-browser') {
    throw new Error('SessionManager not launched — call launch() first');
  }
  healthyPolls++;
}

const DUE = ['closed-browser', 'healthy'];

/** `tick()` as shipped: every target isolated, so one throw cannot starve the round. */
async function tickFixed() {
  for (const name of DUE) {
    try {
      await runCycle(name);
    } catch {
      // logged as an error event; the round continues
    }
  }
}

/** `tick()` as it was: a bare await, so the first throw aborts the whole round. */
async function tickLegacy() {
  for (const name of DUE) {
    await runCycle(name);
  }
}

function startLegacy() {
  setInterval(() => {
    void tickLegacy().finally(() => {});
  }, 30);
}

function startFixed() {
  setInterval(() => {
    void tickFixed()
      .catch(() => {})
      .finally(() => {});
  }, 30);
}

if (MODE === 'legacy') startLegacy();
else startFixed();

// Let the first tick run, then report. With the legacy structure the rejection
// also surfaces as an unhandledRejection, which Node ≥22 turns into an exit.
setTimeout(() => {
  console.log(
    `probe-q1-exit [${MODE}]: healthy target polled ${healthyPolls} time(s); process still alive`,
  );
  process.exit(0);
}, 250);
