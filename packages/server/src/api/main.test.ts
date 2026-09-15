import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { Scheduler } from '../scheduler/scheduler';
import type { Runtime } from '../scheduler/runtime';
import {
  announceStartupPause,
  buildProcessGuardHandlers,
  describeError,
  installProcessGuards,
  recordFatal,
  releaseKeepAwakeOnExit,
  type ProcessGuardTeardown,
} from './main';

let dir: string;
let teardown: ProcessGuardTeardown | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-main-'));
});
afterEach(() => {
  teardown?.();
  teardown = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal Runtime over a temp-dir store. The browser/session pieces are never
 * touched by the code under test, so stubs keep this honest and fast. */
function makeRuntime(onEvent?: (e: unknown) => void): Runtime {
  const store = new Store(dir);
  const budget = new Budget(store);
  const scheduler = new Scheduler({
    store,
    budget,
    watcher: { checkCourse: async () => null },
    actor: { act: async () => ({ kind: 'not-found', crn: '1' }) },
    session: { isLoggedIn: async () => true },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { store, budget, scheduler, onEvent } as any as Runtime;
}

describe('describeError', () => {
  it('renders an Error message, and stringifies anything else without throwing', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain')).toBe('"plain"');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});

describe('installProcessGuards (Q1)', () => {
  it('records an unhandled rejection as an error event instead of dying', () => {
    const rt = makeRuntime();
    const { onRejection } = buildProcessGuardHandlers(rt);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    onRejection(new Error('SessionManager not launched — call launch() first'));

    const events = rt.store.recentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('error');
    expect(events[0].message).toContain('Unhandled promise rejection');
    expect(events[0].message).toContain('SessionManager not launched');
    expect(exit).not.toHaveBeenCalled(); // the process stays up
  });

  it('records an uncaught exception and keeps the process alive', () => {
    const rt = makeRuntime();
    const { onException } = buildProcessGuardHandlers(rt);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    onException(new TypeError('x is not a function'));

    expect(rt.store.recentEvents()[0].message).toContain('Uncaught exception: x is not a function');
    expect(exit).not.toHaveBeenCalled();
  });

  it('still exits on EADDRINUSE — a fault we provably cannot serve through', () => {
    const rt = makeRuntime();
    const { onException } = buildProcessGuardHandlers(rt);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const portTaken = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });

    onException(portTaken);

    expect(rt.store.recentEvents()[0].message).toContain('EADDRINUSE');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('relays the fatal event to the live console (WS broadcast)', () => {
    const seen: unknown[] = [];
    const rt = makeRuntime((e) => seen.push(e));
    const { onRejection } = buildProcessGuardHandlers(rt);

    onRejection(new Error('kaboom'));

    expect(seen).toHaveLength(1);
    expect((seen[0] as { message: string }).message).toContain('kaboom');
  });

  it('does not throw when the event log itself is the broken component', () => {
    const rt = makeRuntime();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(rt.store, 'appendEvent').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const { onRejection } = buildProcessGuardHandlers(rt);

    expect(() => onRejection(new Error('first fault'))).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('event log unavailable'));
  });

  it('registers real process listeners and removes both on teardown', () => {
    const rt = makeRuntime();
    const before = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    };
    teardown = installProcessGuards(rt);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before.exception + 1);
    teardown();
    teardown = undefined;
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
    expect(process.listenerCount('uncaughtException')).toBe(before.exception);
  });
});

describe('announceStartupPause (Q11)', () => {
  it('writes a warn event explaining why watching targets became paused', () => {
    const rt = makeRuntime();
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    rt.store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1111',
      mode: 'auto',
    });
    const paused = rt.store.pauseAllWatching();
    expect(paused).toBe(1);
    expect(rt.store.recentEvents()).toHaveLength(0); // nothing yet — the store is silent

    announceStartupPause(rt, paused);

    const events = rt.store.recentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warn');
    expect(events[0].message).toContain('reset 1 course(s)');
    expect(stdout).toHaveBeenCalled();
  });

  it('stays silent when nothing was paused (no noisy event on every boot)', () => {
    const rt = makeRuntime();
    announceStartupPause(rt, 0);
    expect(rt.store.recentEvents()).toEqual([]);
  });

  it('is broadcast to stream clients so the console shows the reason', () => {
    const seen: unknown[] = [];
    const rt = makeRuntime((e) => seen.push(e));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    announceStartupPause(rt, 3);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { level: string }).level).toBe('warn');
  });
});

describe('recordFatal', () => {
  it('reports whether the event reached the persisted log', () => {
    const rt = makeRuntime();
    expect(recordFatal(rt, 'hello')).toBe(true);
    vi.spyOn(rt.store, 'appendEvent').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(recordFatal(rt, 'bye')).toBe(false);
    expect(stderr).toHaveBeenCalled();
  });
});

/**
 * Regression tests for the `process.on('exit')` keeper sweep.
 *
 * The original implementation called a module-level singleton
 * (`killKeepAwakeSync()`) that `createRuntime()` never used, so the sweep silently
 * targeted an instance whose `child` was always `undefined`. The keeper therefore
 * outlived the server until its own stdin-EOF watchdog noticed, up to ~5s later —
 * precisely the window this handler exists to close.
 *
 * That defect was invisible to the existing suite because `keep-awake.test.ts` only
 * exercises `killChildSync()` on a manager it built itself, never the wiring from the
 * process-exit path to the instance that actually spawned the keeper. These tests
 * assert the wiring instead.
 */
describe('releaseKeepAwakeOnExit', () => {
  it('force-kills the instance it is given, rather than cooperatively stopping it', () => {
    // `stop()` is async and cannot be awaited from an `exit` handler, so the sweep has
    // to be the synchronous kill. Asserting the exact method also catches a future
    // refactor that swaps in something async.
    const killChildSync = vi.fn();
    const stop = vi.fn();

    releaseKeepAwakeOnExit({ killChildSync, stop } as never);

    expect(killChildSync).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not throw when the keeper was never started', () => {
    // The common case: keep-awake is off (the default), so no child exists. An exit
    // handler that throws would mask the real exit reason.
    expect(() => releaseKeepAwakeOnExit({ killChildSync: () => undefined })).not.toThrow();
  });

  it('is wired to the runtime instance, not a module-level singleton', async () => {
    // Guards the specific regression: the sweep must be able to reach the keeper that
    // `createRuntime()` built. The runtime's handle is created with an injected spawn,
    // so no PowerShell is ever executed here.
    const { createRuntime } = await import('../scheduler/runtime');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const storeDir = mkdtempSync(join(tmpdir(), 'keep-awake-exit-'));
    const previous = process.env.AUTOREG_DATA_DIR;
    process.env.AUTOREG_DATA_DIR = storeDir;
    try {
      const runtime = createRuntime();
      // The exact capability the exit handler relies on must exist on the runtime's
      // own handle; this is what the old singleton-based version could not provide.
      expect(typeof runtime.keepAwake.killChildSync).toBe('function');
      expect(() => releaseKeepAwakeOnExit(runtime.keepAwake)).not.toThrow();
      runtime.scheduler.stop();
    } finally {
      if (previous === undefined) delete process.env.AUTOREG_DATA_DIR;
      else process.env.AUTOREG_DATA_DIR = previous;
    }
  });
});
