/**
 * The fake backend's settings contract, in a module with no side effects.
 *
 * This lives apart from `fake-server.mjs` on purpose: that file builds a Fastify
 * app and calls `app.listen()` at module scope, so it cannot be imported by a
 * test. These two maps can.
 *
 * ## Why the values are duplicated here at all
 *
 * The fake backend must never import product code (it has to stay runnable
 * straight from `node e2e/fake-server.mjs`, and the e2e build is deliberately
 * independent of the workspace). So the *values* are mirrored by hand — but the
 * *obligation* is not: `packages/server/src/api/fake-settings-contract.test.ts`
 * checks these maps against the real `DEFAULT_SETTINGS` and the real
 * `settingsSchema`, in both directions. A setting added to the server without a
 * counterpart here fails `npm test` instead of silently breaking e2e.
 *
 * That failure mode is not hypothetical. Operation speed (`opPauseMs` /
 * `opJitterMs`) was added to the server and the Settings page in #36 but not
 * here, so `GET /api/settings` omitted the two fields, the page rendered them as
 * empty inputs and coerced the blanks to `0`, the page's own range check
 * (`opPauseMs >= MIN_OP_PAUSE_MS`) then refused to submit, and "Saved ✓" never
 * appeared — an e2e timeout whose cause was three files away from the symptom.
 */

/**
 * Mirrors `DEFAULT_SETTINGS` in `packages/shared/src/store-types.ts`.
 *
 * Keys must match exactly; the contract test asserts that both ways.
 */
export function defaultSettings() {
  return {
    pollIntervalMinutes: 30,
    jitterMinutes: 3,
    opPauseMs: 3000,
    opJitterMs: 1000,
    queryBudget: 100,
    registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
    dryRun: false,
  };
}

/**
 * Mirrors the bounds in `server.ts`'s `settingsSchema`, so the fake can never
 * accept a body the real server would reject (or vice versa).
 *
 * Both ends matter, which is why this carries a minimum *and* a maximum rather
 * than just the lower bound the PUT handler happens to need: the contract test
 * evaluates `min - 1` (must be rejected) and `min` / `max` (must be accepted)
 * against the real zod schema, and `max + 1` must be rejected too. A fake that
 * silently accepted a value the real server rejects would make every e2e
 * assertion about saved settings meaningless.
 *
 * `email` is absent on purpose: notifications are sunset, the server forces
 * `notify.email = false`, and the fake does not model the retired SMTP blob.
 */
export const NUMERIC_BOUNDS = {
  pollIntervalMinutes: { min: 1 },
  jitterMinutes: { min: 0 },
  opPauseMs: { min: 250, max: 60_000 },
  opJitterMs: { min: 0, max: 60_000 },
  queryBudget: { min: 1 },
  registerBudget: { min: 0 },
};
