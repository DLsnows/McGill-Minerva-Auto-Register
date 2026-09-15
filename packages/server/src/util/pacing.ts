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
 * The jitter actually applied for a given base: capped at `base - MIN_OP_PAUSE_MS` so the
 * floor can never become the *mode*. Without that cap, two independently-valid settings
 * interact badly: with `base = 250` and `jitter = 60000`, every sample whose jitter term is
 * negative (`Math.random() <= 0.5`) collapses to exactly 250ms while the rest spread up to
 * ~60s. Half of all browser pauses would sit on the hard minimum — a bimodal, obviously
 * mechanical distribution, and the opposite of what a floor is for. Defaults (3000 ± 1000)
 * never hit this because `jitter < base`; making the values configurable is what exposed it.
 *
 * Only the *low* side is capped: when `jitter > base` the pauses ramp uniformly from the
 * floor up to `base + jitter`, which is still a plausible human spread.
 */
export function effectiveJitterMs(baseMs: number, jitterMs: number): number {
  const headroom = Math.max(0, baseMs - MIN_OP_PAUSE_MS);
  return Math.min(jitterMs, headroom);
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
  const jitter = effectiveJitterMs(base, sanitize(jitterMs ?? current.jitterMs, current.jitterMs));
  const ms = Math.max(MIN_OP_PAUSE_MS, base + (Math.random() * 2 - 1) * jitter);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
