import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@autoregister/shared';
// @ts-expect-error -- plain .mjs e2e fixture with no type declarations (see the
// `e2e/**` block in eslint.config.mjs; there is no tsconfig project for it).
import { NUMERIC_BOUNDS, defaultSettings } from '../../../../e2e/fake-settings.mjs';
import { settingsSchema } from './server';

/**
 * The fake backend is a hand-maintained parallel copy of the settings contract.
 * Three separate features (#35's budget snapshot, #34's `/resume`, #36's
 * operation speed) shipped without updating it, and each time the only symptom
 * was an unrelated-looking e2e failure — because the fake happily served a
 * settings object the product could not produce, and the page then rejected its
 * own form.
 *
 * These tests derive the fake's obligations from the real `DEFAULT_SETTINGS` and
 * the real `settingsSchema`, so drift fails here — fast, named, and one file away
 * from the mistake — instead of in a Playwright timeout.
 */

/** A body as the Settings page sends it: the whole settings object, not a patch. */
function fullBody(): Record<string, unknown> {
  return { ...defaultSettings(), email: { host: 'h', port: 25, user: 'u', pass: 'p', to: 't' } };
}

/** Replace the settings page's whole-object payload with one field changed. */
function bodyWith(key: string, value: unknown): Record<string, unknown> {
  return { ...fullBody(), [key]: value };
}

function accepts(body: Record<string, unknown>): boolean {
  return settingsSchema.safeParse(body).success;
}

/**
 * The zod definition behind a field, across the v3 (`_def`) and v4 (`def`) shapes.
 *
 * zod resolves to 3.25.76 in this repo, where `.partial()` wraps every field in a
 * `ZodOptional`, so callers must unwrap before reading `typeName`.
 */
function definitionOf(schema: unknown): { typeName?: string; checks?: unknown[]; shape?: unknown } {
  const holder = schema as { _def?: Record<string, unknown>; def?: Record<string, unknown> };
  const def = holder._def ?? holder.def;
  if (!def) throw new Error('cannot read the schema definition — zod internals changed');
  return def as { typeName?: string; checks?: unknown[]; shape?: unknown };
}

/** Strip `ZodOptional` / `ZodNullable` / `ZodDefault` wrappers to the real type. */
function unwrap(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 10; depth++) {
    const def = definitionOf(current);
    const name = def.typeName ?? '';
    if (!/Optional|Nullable|Default|Readonly|Branded|Catch/.test(name)) return current;
    const inner = (def as { innerType?: unknown }).innerType;
    if (inner === undefined) return current;
    current = inner;
  }
  throw new Error('schema wrapper nesting too deep — zod internals changed');
}

/** The `shape` accessor for an object schema. */
function shapeOf(schema: unknown): Record<string, unknown> {
  const holder = schema as { shape?: unknown };
  const shape =
    typeof holder.shape === 'function' ? (holder.shape as () => unknown)() : holder.shape;
  if (!shape || typeof shape !== 'object') {
    throw new Error('cannot read the object shape — zod internals changed');
  }
  return shape as Record<string, unknown>;
}

/** The `min`/`max` a numeric field declares, or `undefined` for neither. */
function numberBounds(schema: unknown): { min?: number; max?: number } {
  const def = definitionOf(unwrap(schema));
  if (def.typeName !== 'ZodNumber') return {};
  const checks = def.checks;
  if (!Array.isArray(checks)) return {};
  const out: { min?: number; max?: number } = {};
  for (const raw of checks) {
    const check = raw as { kind?: string; value?: unknown };
    if (check.kind === 'min' && typeof check.value === 'number') out.min = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') out.max = check.value;
  }
  return out;
}

const SHAPE = shapeOf(settingsSchema);

/** Numeric settings the real schema pins to a lower bound, with that bound. */
function realMinimums(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, schema] of Object.entries(SHAPE)) {
    const { min } = numberBounds(schema);
    if (min !== undefined) out[key] = min;
  }
  return out;
}

/** Numeric settings the real schema pins to an upper bound, with that bound. */
function realMaximums(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, schema] of Object.entries(SHAPE)) {
    const { max } = numberBounds(schema);
    if (max !== undefined) out[key] = max;
  }
  return out;
}

describe('fake backend settings contract (e2e/fake-settings.mjs)', () => {
  it('exposes exactly the same settings keys as the real DEFAULT_SETTINGS', () => {
    expect(Object.keys(defaultSettings()).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('exposes the same values, so the fake is not a different product', () => {
    const fake = defaultSettings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      expect(fake[key as keyof typeof fake], `fake default for ${key}`).toEqual(value);
    }
  });

  it('the derivation itself works (guards against a vacuous contract test)', () => {
    // If zod's internals shift under `realMinimums()`, every bound assertion below
    // would iterate an empty object and pass without checking anything. Pin the
    // known floors so that failure is loud instead of silent.
    const minimums = realMinimums();
    expect(minimums.pollIntervalMinutes).toBe(1);
    expect(minimums.registerBudget).toBe(0);
    expect(minimums.opPauseMs).toBeGreaterThanOrEqual(250);
  });

  it('every bounded field of the real schema is bounded by the fake too', () => {
    // The dangerous direction: a field the server bounds but the fake does not
    // know about. The fake would store an out-of-range value and serve it back,
    // so e2e assertions would measure a state the product cannot reach.
    for (const [key, min] of Object.entries(realMinimums())) {
      expect(NUMERIC_BOUNDS[key], `${key} missing from the fake's NUMERIC_BOUNDS`).toBeDefined();
      expect(NUMERIC_BOUNDS[key].min, `${key} lower bound`).toBe(min);
    }
    for (const [key, max] of Object.entries(realMaximums())) {
      expect(NUMERIC_BOUNDS[key], `${key} missing from the fake's NUMERIC_BOUNDS`).toBeDefined();
      expect(NUMERIC_BOUNDS[key].max, `${key} upper bound`).toBe(max);
    }
  });

  it('the fake claims no bound the real schema does not enforce', () => {
    // The mirror-image mistake, which is just as corrosive: a fake stricter than
    // the product rejects requests the real server accepts, so an e2e case can
    // fail against a server that works.
    for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS) as [
      string,
      { min: number; max?: number },
    ][]) {
      expect(realMinimums()[key], `${key} is bounded in the fake but not the real schema`).toBe(
        bounds.min,
      );
      if (bounds.max !== undefined) {
        expect(realMaximums()[key], `${key} max in the fake but not the real schema`).toBe(
          bounds.max,
        );
      }
    }
  });

  it('the real schema accepts the fake defaults (the page can save what it was served)', () => {
    const result = settingsSchema.safeParse(fullBody());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('the real schema rejects a body whose pacing fields were blanked to 0', () => {
    // The exact #36 regression: a fake that omits `opPauseMs` makes the page
    // render an empty input, coerce the blank to 0, and then refuse to submit.
    // This pins that 0 is genuinely invalid server-side, so the fix has to be a
    // fake that serves the real field — not a page that stops caring.
    expect(accepts(bodyWith('opPauseMs', 0))).toBe(false);
  });

  describe('every bound the fake enforces matches the real schema', () => {
    for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS) as [
      string,
      { min: number; max?: number },
    ][]) {
      const { min, max } = bounds;
      it(`${key}: min ${min} accepted, ${min - 1} rejected`, () => {
        expect(accepts(bodyWith(key, min)), `${key} at min`).toBe(true);
        expect(accepts(bodyWith(key, min - 1)), `${key} below min`).toBe(false);
      });

      // Destructured into a local: TypeScript does not carry a narrowing of a
      // loop variable into the `it` callback, which would otherwise make
      // `max + 1` a "possibly undefined" error.
      if (max !== undefined) {
        it(`${key}: max ${max} accepted, ${max + 1} rejected`, () => {
          expect(accepts(bodyWith(key, max)), `${key} at max`).toBe(true);
          expect(accepts(bodyWith(key, max + 1)), `${key} above max`).toBe(false);
        });
      }
    }
  });
});
