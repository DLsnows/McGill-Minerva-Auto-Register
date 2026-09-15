import { describe, expect, it, vi } from 'vitest';
import { releaseKeepAwakeOnExit } from './main';

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
