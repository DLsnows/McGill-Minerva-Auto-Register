import {
  DEFAULT_SETTINGS,
  MAX_OP_PAUSE_MS,
  MIN_OP_PAUSE_MS,
  type Settings,
} from '@autoregister/shared';

/**
 * Human-like pause between browser operations: `baseMs` ± `jitterMs` (uniform),
 * floored at 250ms. Default ~3s ± 1s. Makes automated navigation look less
 * robotic to the server (anti-detection / respectful pacing).
 *
 * The defaults are user-configurable through the "operation speed" settings
 * (`opPauseMs` / `opJitterMs`); they are *not* the poll cadence — see
 * `pollIntervalMinutes` for how often a cycle runs.
 */
export interface PacingConfig {
  /** Base pause between two browser operations, in milliseconds. */
  baseMs: number;
  /** Uniform ± jitter applied to `baseMs`, in milliseconds. */
  jitterMs: number;
}

const DEFAULT_PACING: PacingConfig = {
  baseMs: DEFAULT_SETTINGS.opPauseMs,
  jitterMs: DEFAULT_SETTINGS.opJitterMs,
};

/** Module-level runtime pacing, applied process-wide. */
let current: PacingConfig = { ...DEFAULT_PACING };

/** Clamp a configured value into range; non-finite input keeps `fallback`. */
function sanitize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_OP_PAUSE_MS, Math.max(0, value));
}

/**
 * Update the runtime pacing used by parameterless `humanPause()` calls.
 *
 * Absent keys keep their current value, non-finite values are ignored, and
 * negatives clamp to 0 — the 250ms floor itself is enforced in `humanPause`,
 * so it can never be configured away (not even through a hand-edited
 * `store.json`).
 */
export function configurePacing(config: Partial<PacingConfig>): PacingConfig {
  current = {
    baseMs: config.baseMs === undefined ? current.baseMs : sanitize(config.baseMs, current.baseMs),
    jitterMs:
      config.jitterMs === undefined
        ? current.jitterMs
        : sanitize(config.jitterMs, current.jitterMs),
  };
  return { ...current };
}

/** The pacing currently in effect. */
export function getPacing(): PacingConfig {
  return { ...current };
}

/** Apply the operation-speed fields of a settings object (startup + settings save). */
export function applyPacingSettings(
  settings: Pick<Settings, 'opPauseMs' | 'opJitterMs'>,
): PacingConfig {
  return configurePacing({ baseMs: settings.opPauseMs, jitterMs: settings.opJitterMs });
}

/** Restore the built-in defaults (used by tests). */
export function resetPacing(): PacingConfig {
  current = { ...DEFAULT_PACING };
  return { ...current };
}

/**
 * Draw the signed jitter offset for a pause, keeping `base + offset` at or above the
 * floor without altering the configured spread any more than necessary.
 *
 * Why this is not simply `base + (random*2-1) * jitter`:
 * with `base = 250` and `jitter = 60000` — both accepted by the schema — every negative
 * offset collapses onto the 250ms floor while the rest spread to ~60s. Half of all
 * browser pauses would sit on the hard minimum: a bimodal, obviously mechanical
 * distribution, which is the opposite of what a floor is for. The old hardcoded
 * 3000 ± 1000 never hit this because `jitter < base`; making the values configurable is
 * what exposed it.
 *
 * Only the half that cannot reach is truncated: the lower bound of the uniform draw is
 * raised to `MIN_OP_PAUSE_MS - base`, and the upper half is left exactly as configured.
 *
 * - `base >= MIN`: the bound is `-jitter` or higher, so the *default* 3000 ± 1000 still
 *   ranges 2000…4000 and is symmetric. Nothing changes for any configuration whose
 *   jitter fits inside the headroom above the floor.
 * - `base < MIN`: the bound rises to `MIN - base` (positive), so the draw is confined to
 *   `[MIN - base, jitter]`. The floor is then reached at exactly `offset = MIN - base`,
 *   a single point of the support rather than the mode, and the configured maximum
 *   `base + jitter` is still reached.
 *
 * Rejected alternatives, for the record:
 * - clamping the *result* (`max(floor, base + offset)`) removes the below-floor values
 *   but piles them onto the floor — the same spike by another route;
 * - reflecting the tail (`base + |offset|`) also removes the spike but turns `base` from
 *   the centre into a lower bound, so the default 3000 ± 1000 would really mean
 *   3000…4000 (+17% on every operation) and contradict the documented `± jitter`;
 * - capping the jitter symmetrically at `base - MIN_OP_PAUSE_MS` discards most of a
 *   large configured jitter (base 3000 / jitter 60000 really ranged 250–5750ms, and
 *   base 250 lost its jitter entirely as a constant 250ms).
 */
export function jitterOffset(baseMs: number, jitterMs: number): number {
  // `Math.max(-0, x)` can produce -0, and `-0` is a needless surprise for callers and
  // tests (it is not `Object.is`-equal to 0). Normalise on the way out.
  const normalise = (n: number): number => (n === 0 ? 0 : n);
  const low = Math.max(-jitterMs, MIN_OP_PAUSE_MS - baseMs);
  // Not dead code, and the comment here used to claim it was. `low <= 0` only holds while
  // `baseMs >= MIN_OP_PAUSE_MS`; when the base is *below* the floor (`humanPause(0, …)`,
  // a hand-edited `store.json` — both reachable), `MIN - base` is positive, so `low` can
  // reach `MIN_OP_PAUSE_MS`. If the jitter does not cover that gap either, there is no
  // draw that both respects the jitter and clears the floor, and a constant offset is the
  // only honest answer: the pause sits on the floor rather than being illegal.
  if (low >= jitterMs) return normalise(low);
  return normalise(low + Math.random() * (jitterMs - low));
}

/**
 * Wait `baseMs` ± `jitterMs` (uniform), never less than {@link MIN_OP_PAUSE_MS}.
 * Explicit arguments override the runtime configuration (tests use this) and are
 * sanitized exactly like the configured values.
 */
export function humanPause(baseMs?: number, jitterMs?: number): Promise<void> {
  // The explicit path is sanitized too: `Math.max(MIN_OP_PAUSE_MS, NaN)` is NaN and
  // `setTimeout(fn, NaN)` fires immediately, so an unsanitized argument would be the
  // one way to beat the floor this module exists to guarantee.
  const base = sanitize(baseMs ?? current.baseMs, current.baseMs);
  const jitter = sanitize(jitterMs ?? current.jitterMs, current.jitterMs);
  const ms = Math.max(MIN_OP_PAUSE_MS, base + jitterOffset(base, jitter));
  return new Promise((resolve) => setTimeout(resolve, ms));
}
