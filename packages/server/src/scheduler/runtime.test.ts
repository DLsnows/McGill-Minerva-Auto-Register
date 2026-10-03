import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store';
import { getPacing, resetPacing } from '../util/pacing';
import { createRuntime, enforceEmailSunset } from './runtime';

let dir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-runtime-'));
  // `createRuntime()` builds a Store from AUTOREG_DATA_DIR; keep it off the repo.
  prevDataDir = process.env.AUTOREG_DATA_DIR;
  process.env.AUTOREG_DATA_DIR = dir;
  resetPacing();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AUTOREG_DATA_DIR;
  else process.env.AUTOREG_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
  resetPacing();
});

/** Write a store.json exactly as a pre-sunset build left it. */
function seedLegacyStore(notify: { desktop: boolean; sound: boolean; email: boolean }): Store {
  const store = new Store(dir);
  store.setSettings({
    notify,
    email: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', to: 'to@example.com' },
  });
  return store;
}

describe('enforceEmailSunset (startup normalization)', () => {
  it('flips a persisted notify.email=true to false and writes it back to disk', () => {
    const store = seedLegacyStore({ desktop: true, sound: true, email: true });
    expect(store.getSettings().notify.email).toBe(true); // legacy state on disk

    expect(enforceEmailSunset(store)).toBe(true);

    expect(store.getSettings().notify.email).toBe(false);
    // Survives a restart, so the next launch can't resurrect the channel.
    expect(new Store(dir).getSettings().notify.email).toBe(false);
    // The other channels and the kept-for-restore SMTP config are untouched.
    const persisted = new Store(dir).getSettings();
    expect(persisted.notify.desktop).toBe(true);
    expect(persisted.notify.sound).toBe(true);
    expect(persisted.email?.host).toBe('smtp.example.com');
  });

  it('is a no-op when the channel is already off (returns false)', () => {
    const store = seedLegacyStore({ desktop: false, sound: true, email: false });
    expect(enforceEmailSunset(store)).toBe(false);
    expect(store.getSettings().notify).toEqual({ desktop: false, sound: true, email: false });
  });
});

describe('createRuntime', () => {
  it('initializes the runtime pacing from the persisted settings', () => {
    writeFileSync(
      join(dir, 'store.json'),
      JSON.stringify({ settings: { opPauseMs: 500, opJitterMs: 100 } }),
    );
    createRuntime();
    expect(getPacing()).toEqual({ baseMs: 500, jitterMs: 100 });
  });

  it('falls back to the defaults for a legacy store.json without operation speed', () => {
    writeFileSync(
      join(dir, 'store.json'),
      JSON.stringify({ settings: { pollIntervalMinutes: 45 } }),
    );
    const runtime = createRuntime();
    expect(runtime.store.getSettings().opPauseMs).toBe(3000);
    expect(getPacing()).toEqual({ baseMs: 3000, jitterMs: 1000 });
  });
});
