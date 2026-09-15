/**
 * The fake backend's answer to `GET /api/power`, in a side-effect-free module
 * (same reason as `fake-settings.mjs`: `fake-server.mjs` calls `app.listen()` at
 * module scope and cannot be imported by a test).
 *
 * Keep-awake shipped with a Settings page that calls `GET /api/power` and a fake
 * backend that had never heard of the route, so the page logged two 404s per
 * visit and the e2e run failed on "unexpected browser errors". Only the fake was
 * wrong — a 404 for a route the real server always registers.
 *
 * The contract test (`fake-settings-contract.test.ts`) pins both the key set and
 * the enum values against the real `PowerStatusDto` and `KeepAwakeReason`.
 */

/**
 * What the fake reports: a machine that cannot host the keeper.
 *
 * `supported: false` is the deliberate choice, not a default of convenience. The
 * e2e run is platform-independent (Linux in CI, and macOS/Windows locally) and
 * the switch is Windows-only, so the fake must not claim support — a fake that
 * said `supported: true` would render a keep-awake switch that no e2e case can
 * actuate, and would let a Windows-only regression pass unnoticed.
 *
 * This mirrors exactly what the real server reports when no controller is wired
 * in: `toPowerDto(UNSUPPORTED_POWER)` in `server.ts`.
 */
export function powerStatus() {
  return {
    supported: false,
    enabled: false,
    active: false,
    powerSource: 'unknown',
    reason: 'unsupported',
  };
}
