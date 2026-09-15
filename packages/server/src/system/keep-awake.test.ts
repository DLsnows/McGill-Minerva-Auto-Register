import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  KEEPER_EXIT_GRACE_MS,
  KEEPER_READY,
  KEEPER_REFRESH_SECONDS,
  KEEPER_RETRY_MAX_BACKOFF_MS,
  POWER_POLL_MS,
  POWER_QUERY_SCRIPT,
  PROBE_STALE_MS,
  createKeepAwake,
  detectPowerSource,
  parsePowerSourceOutput,
  shouldHold,
  shouldKeepHoldingThroughFailure,
  type PowerSource,
} from './keep-awake';

/** Minimal stand-in for a spawned child: no PowerShell is ever executed. */
class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  unref = vi.fn();
  /** A real Readable, so `setEncoding`/`on('data')` behave exactly as with a pipe. */
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin = { end: vi.fn(), destroy: vi.fn(), write: vi.fn() };
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  /** Emulate the keeper reaching the point where it holds the wake request. */
  emitReady(): void {
    this.stdout.push(KEEPER_READY);
  }
}

interface Harness {
  children: FakeChild[];
  spawn: ReturnType<typeof vi.fn>;
  /** Set to false to keep a spawned keeper from confirming its hold, so the
   * spawn→READY window can be inspected. */
  autoReady: boolean;
}

function harness(): Harness {
  const h: Harness = {
    children: [],
    autoReady: true,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      h.children.push(child);
      // The real keeper prints READY asynchronously right after it holds the request;
      // without emulating that, every `start()` would return before the hold exists.
      if (h.autoReady) queueMicrotask(() => child.emitReady());
      return child as unknown as ChildProcess;
    }),
  };
  return h;
}

function makeManager(
  h: Harness,
  platform: NodeJS.Platform = 'win32',
  source: () => PowerSource | Promise<PowerSource> = () => 'ac',
) {
  return createKeepAwake({
    platform,
    spawn: h.spawn as never,
    getPowerSource: source,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let buffered stream data (the fake keeper's `READY`) actually reach its
 * `data` listener — a real pipe delivers it asynchronously too.
 *
 * `setImmediate` is faked whenever fake timers are on, so awaiting it there would
 * hang forever; advance the fake clock instead. */
const flush = async () => {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((resolve) => setImmediate(resolve));
};

describe('keep-awake', () => {
  describe('platform support', () => {
    it('is supported on win32 only', async () => {
      const h = harness();
      expect(makeManager(h, 'win32').isSupported()).toBe(true);
      for (const platform of ['linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
        expect(makeManager(h, platform).isSupported()).toBe(false);
      }
    });

    it('is a no-op off Windows: nothing is spawned and status says unsupported', async () => {
      const h = harness();
      const manager = makeManager(h, 'linux', () => 'ac');
      const status = await manager.start();
      expect(h.spawn).not.toHaveBeenCalled();
      expect(manager.stop());
      expect(h.spawn).not.toHaveBeenCalled();
      expect(status).toMatchObject({ supported: false, active: false, reason: 'unsupported' });
      expect(manager.getPowerSource()).toBe('unknown');
    });
  });

  describe('power-source gating', () => {
    it('holds on AC and on a desktop, never on battery', async () => {
      expect(shouldHold('ac', true)).toBe(true);
      expect(shouldHold('desktop', true)).toBe(true);
      expect(shouldHold('battery', true)).toBe(false);
      expect(shouldHold('unknown', true)).toBe(false);
      // Disabled wins over everything.
      expect(shouldHold('ac', false)).toBe(false);
      expect(shouldHold('desktop', false)).toBe(false);
    });

    it('does NOT start a keeper while on battery', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'battery');
      const status = await manager.start();
      expect(h.spawn).not.toHaveBeenCalled();
      expect(status).toMatchObject({ active: false, settingEnabled: true, reason: 'battery' });
    });

    it('only a desktop keeps holding through a failed probe', () => {
      // `unknown` after a desktop reading can only mean "the probe failed" — a
      // desktop has no battery to protect. After `ac` it can mean "unplugged".
      expect(shouldKeepHoldingThroughFailure('unknown', 'desktop')).toBe(true);
      expect(shouldKeepHoldingThroughFailure('unknown', 'ac')).toBe(false);
      expect(shouldKeepHoldingThroughFailure('unknown', 'battery')).toBe(false);
      expect(shouldKeepHoldingThroughFailure('unknown', 'unknown')).toBe(false);
      // Only `unknown` is a failure state; a real reading always decides normally.
      expect(shouldKeepHoldingThroughFailure('battery', 'desktop')).toBe(false);
      expect(shouldKeepHoldingThroughFailure('ac', 'desktop')).toBe(false);
    });

    it('starts a keeper on AC and stops it again when switching to battery', async () => {
      vi.useFakeTimers();
      const h = harness();
      // Hold the keeper at "spawned but not confirmed yet" so the spawn→READY window
      // can be asserted before the hold is reported.
      h.autoReady = false;
      let source: PowerSource = 'battery';
      const manager = makeManager(h, 'win32', () => source);

      expect(await manager.start()).toMatchObject({ active: false, reason: 'battery' });

      // Plug the charger in: the 60s watchdog picks the change up.
      source = 'ac';
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      const child = h.children[0];
      // Spawning alone is NOT a hold — the keeper has not confirmed yet, and this
      // must not read as a failure either.
      expect(manager.status()).toMatchObject({ active: false, reason: 'starting' });
      child.emitReady();
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      // Unplug: the hold is released (stdin closed, then killed after the grace period).
      source = 'battery';
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(child.stdin.end).toHaveBeenCalled();
      expect(manager.status()).toMatchObject({ active: false, reason: 'battery' });

      manager.stop();
    });

    it('reports "unavailable" when the probe cannot establish the power source', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'unknown');
      expect(await manager.start()).toMatchObject({ active: false, reason: 'unavailable' });
      expect(h.spawn).not.toHaveBeenCalled();
      manager.stop();
    });

    it('probes the power source on a status() read so the UI can say "on battery" before the switch is on', async () => {
      const h = harness();
      const probe = vi.fn((): Promise<PowerSource> => Promise.resolve('battery'));
      const manager = makeManager(h, 'win32', probe);

      // status() must stay non-blocking: it kicks the probe off and reports the
      // cached value. The fresh reading appears on the next poll. (Doing this
      // synchronously used to stall the whole event loop behind PowerShell.)
      const first = manager.status();
      expect(first.powerSource).toBe('unknown');
      await vi.waitFor(() => expect(manager.status().powerSource).toBe('battery'));

      expect(probe).toHaveBeenCalledTimes(1);
      expect(manager.status()).toMatchObject({ settingEnabled: false, powerSource: 'battery' });
      // A second read uses the cached value (no extra PowerShell call)…
      manager.status();
      expect(probe).toHaveBeenCalledTimes(1);
      // …unless explicitly asked for a pure cached read.
      manager.status(false);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('swallows a throwing probe instead of crashing the server', async () => {
      const h = harness();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const manager = makeManager(h, 'win32', () => {
        throw new Error('powershell.exe is not recognized');
      });
      expect(() => manager.start()).not.toThrow();
      expect(manager.status()).toMatchObject({ active: false, reason: 'unavailable' });
      expect(errorSpy).toHaveBeenCalled();
      manager.stop();
    });
  });

  describe('spawned keeper', () => {
    it('spawns PowerShell with the documented ES_* flags and no ES_DISPLAY_REQUIRED', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();

      expect(h.spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = h.spawn.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toMatch(/powershell(\.exe)?$/i);
      expect(args).toContain('-NoProfile');
      expect(args).toContain('-NonInteractive');
      const script = String(args[args.length - 1]);
      // ES_CONTINUOUS (0x80000000) + ES_SYSTEM_REQUIRED (1) as decimal literals —
      // a hex literal would be parsed as a negative Int32 and break [uint32].
      expect(script).toContain('[uint32]$ES_CONTINUOUS = 2147483648');
      expect(script).toContain('[uint32]$ES_SYSTEM_REQUIRED = 1');
      expect(script).toContain('SetThreadExecutionState');
      // ES_DISPLAY_REQUIRED (2) must never be requested: the screen still turns off.
      expect(script).not.toContain('ES_DISPLAY_REQUIRED');
      expect(script).toContain(`Start-Sleep -Seconds ${KEEPER_REFRESH_SECONDS}`);
      expect(options).toMatchObject({ windowsHide: true });
      // Never used: powercfg would rewrite the user's power plan and
      // `powercfg /requests` needs admin rights.
      expect(script).not.toContain('powercfg');

      // The keeper must not hold our event loop open.
      expect(h.children[0].unref).toHaveBeenCalled();
      manager.stop();
    });

    it('does not re-spawn while a keeper is already holding the request', async () => {
      vi.useFakeTimers();
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      await manager.start();
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS * 3);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('stop() releases the hold cooperatively, force-killing only after the grace period', async () => {
      vi.useFakeTimers();
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      const child = h.children[0];

      const status = manager.stop();
      // Same graceful path on EVERY release, including this main "switch off" one:
      // stdin closes first and the forced kill is only a fallback.
      expect(child.stdin.end).toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(status).toMatchObject({ active: false, settingEnabled: false, reason: 'disabled' });

      await vi.advanceTimersByTimeAsync(KEEPER_EXIT_GRACE_MS);
      expect(child.kill).toHaveBeenCalled();
    });

    it('stop() is idempotent and does not throw without a child', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      expect(() => {
        manager.stop();
        manager.stop();
      }).not.toThrow();
      await manager.start();
      manager.stop();
      expect(() => manager.stop()).not.toThrow();
    });

    it('clears the power watchdog so nothing keeps ticking after stop()', async () => {
      vi.useFakeTimers();
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      await flush();
      expect(manager.status().active).toBe(true);
      manager.stop();
      // Only the (unref'd) grace-period fallback may remain — the 60s watchdog is gone.
      await vi.advanceTimersByTimeAsync(KEEPER_EXIT_GRACE_MS);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a failed spawn surfaces as keeperFailed instead of throwing', async () => {
      const spawn = vi.fn(() => {
        throw new Error('spawn powershell.exe ENOENT');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const manager = createKeepAwake({
        platform: 'win32',
        spawn: spawn as never,
        getPowerSource: (): Promise<PowerSource> => Promise.resolve('ac'),
      });
      // The spawn happens inside the async first tick, so a rejection must surface as a
      // resolved status rather than bubbling out of start(). The reason is
      // 'keeperFailed' (the source WAS read) — see the dedicated test below.
      await expect(manager.start()).resolves.toMatchObject({
        active: false,
        reason: 'keeperFailed',
      });
      expect(errorSpy).toHaveBeenCalled();
      manager.stop();
    });

    it('a keeper that exits on its own is forgotten (no stale "active")', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      await flush();
      expect(manager.status().active).toBe(true);
      h.children[0].emit('exit', 0, null);
      expect(manager.status().active).toBe(false);
      manager.stop();
    });

    it('killChildSync() force-kills the child (the process "exit" sweep)', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      const child = h.children[0];
      manager.killChildSync();
      expect(child.stdin.destroy).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
      expect(manager.status().active).toBe(false);
      manager.stop();
    });
  });

  describe('apply()', () => {
    it('start()s when the setting is on and stop()s when it is off', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');

      // `apply({keepAwake:true})` resolves once the hold exists (the keeper confirms
      // asynchronously, so the first tick's status is awaited through the READY line).
      await manager.apply({ keepAwake: true });
      await flush();
      expect(manager.status()).toMatchObject({ active: true, settingEnabled: true });
      expect(h.spawn).toHaveBeenCalledTimes(1);

      expect(await manager.apply({ keepAwake: false })).toMatchObject({
        active: false,
        reason: 'disabled',
      });

      // An absent field counts as "off" — the default is opt-in.
      await manager.apply({ keepAwake: true });
      expect(await manager.apply({})).toMatchObject({ active: false });
    });
  });

  describe('probe staleness (Claude review on #37)', () => {
    it('does not re-probe on every settings save while the reading is fresh', async () => {
      // `PUT /api/settings` awaits `apply()` on *every* save, and `apply()` routes to
      // `start()` when the switch is on. Probing each time parked an unrelated save
      // behind a PowerShell round trip: ~0.5s typical, up to QUERY_TIMEOUT_MS on the
      // slow/hung-PowerShell machine this feature exists to degrade gracefully on.
      const h = harness();
      const probe = vi.fn((): PowerSource => 'ac');
      const manager = makeManager(h, 'win32', probe);

      await manager.apply({ keepAwake: true });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(h.spawn).toHaveBeenCalledTimes(1);

      // Three unrelated saves in a row: the cached reading is reused every time, and
      // the already-holding keeper is not re-spawned either.
      for (let i = 0; i < 3; i++) await manager.apply({ keepAwake: true });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(h.spawn).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it('re-probes once the reading goes stale, so a save still notices a replug', async () => {
      vi.useFakeTimers();
      const h = harness();
      let source: PowerSource = 'ac';
      const probe = vi.fn((): PowerSource => source);
      const manager = makeManager(h, 'win32', probe);

      await manager.apply({ keepAwake: true });
      await flush();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      // Unplug and let the staleness window lapse; the next save re-reads and releases.
      source = 'battery';
      await vi.advanceTimersByTimeAsync(PROBE_STALE_MS);
      await manager.apply({ keepAwake: true });
      expect(probe.mock.calls.length).toBeGreaterThan(1);
      expect(manager.status()).toMatchObject({ active: false, reason: 'battery' });

      manager.stop();
    });

    it('a failed probe is not retried on every /api/power poll', async () => {
      // The guard used to be `powerSource !== 'unknown'`, but a *failed* probe also
      // leaves the source 'unknown' — so on a machine where PowerShell/CIM keeps
      // failing, each 30s poll spawned another doomed probe, forever.
      //
      // The failure must be ASYNC here, like the real probe: a probe that throws
      // synchronously rejects before `probeOnce()` has stored the in-flight promise,
      // so the old guard's `probeInFlight` check would mask the defect and the test
      // would pass against the broken code.
      const h = harness();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const probe = vi.fn((): Promise<PowerSource> => Promise.reject(new Error('CIM unavailable')));
      const manager = makeManager(h, 'win32', probe);

      manager.status();
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      // Three drains, not one: the rejected probe has to leave `probeInFlight`, which
      // is precisely the state the old guard mistook for "never tried". Polling before
      // that lands would be masked by the in-flight check and would pass against the
      // broken code.
      await flush();
      await flush();
      await flush();
      const afterFirst = probe.mock.calls.length;
      expect(afterFirst).toBe(1);

      // Many polls inside the staleness window: not one further spawn.
      for (let i = 0; i < 5; i++) manager.status();
      await flush();
      expect(probe).toHaveBeenCalledTimes(afterFirst);
      expect(manager.status()).toMatchObject({ supported: true, powerSource: 'unknown' });
    });

    it('a failed probe is retried once the reading goes stale, so it can recover', async () => {
      vi.useFakeTimers();
      const h = harness();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = true;
      const probe = vi.fn((): PowerSource => {
        if (failing) throw new Error('CIM unavailable');
        return 'battery';
      });
      const manager = makeManager(h, 'win32', probe);

      // Two polls while failing: the first spawns the probe, the second confirms the
      // settled-and-failed state. (Written this way rather than with a single timed
      // flush because the probe's `finally` — which timestamps the attempt — settles
      // across several microtasks, and the point of this test is the retry *policy*,
      // not the microtask depth.)
      manager.status();
      await flush();
      manager.status();
      await flush();
      expect(errorSpy).toHaveBeenCalled();
      expect(manager.status()).toMatchObject({ supported: true, powerSource: 'unknown' });

      // Bounded retry, not "never again": after the window the reading is re-attempted.
      failing = false;
      await vi.advanceTimersByTimeAsync(PROBE_STALE_MS);
      manager.status();
      await flush();
      await flush();
      // `powerSource` is the subject — the switch was never turned on, so `reason`
      // stays 'disabled' however good the reading is.
      expect(manager.status()).toMatchObject({ powerSource: 'battery' });
      expect(probe.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps holding a DESKTOP through a transient probe failure', async () => {
      // The UI promises a desktop "stays awake the whole time the switch is on", and a
      // desktop has no battery — so an `unknown` reading there can only mean the probe
      // failed. Dropping the hold would break that promise over one CIM hiccup.
      vi.useFakeTimers();
      const h = harness();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = false;
      const probe = vi.fn((): PowerSource => {
        if (failing) throw new Error('transient CIM error');
        return 'desktop';
      });
      const manager = makeManager(h, 'win32', probe);

      await manager.start();
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });
      const child = h.children[0];
      expect(child.stdin.end).not.toHaveBeenCalled();

      // One watchdog tick lands on a failed probe.
      failing = true;
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(errorSpy).toHaveBeenCalled();
      // Still holding: the keeper was neither released nor re-spawned.
      expect(h.children).toHaveLength(1);
      expect(child.stdin.end).not.toHaveBeenCalled();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      // The next reading lands again and everything is unchanged.
      failing = false;
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(h.children).toHaveLength(1);
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      manager.stop();
    });

    it('still releases a LAPTOP the moment a failed probe cannot confirm AC', async () => {
      // The deliberate other half: last seen on `ac` means "a laptop that may have been
      // unplugged", so `unknown` must keep the conservative fail-safe and release.
      vi.useFakeTimers();
      const h = harness();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = false;
      const probe = vi.fn((): PowerSource => {
        if (failing) throw new Error('transient CIM error');
        return 'ac';
      });
      const manager = makeManager(h, 'win32', probe);

      await manager.start();
      await flush();
      const child = h.children[0];
      expect(manager.status()).toMatchObject({ active: true });

      failing = true;
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(child.stdin.end).toHaveBeenCalled();
      expect(manager.status()).toMatchObject({ active: false, reason: 'unavailable' });

      manager.stop();
    });
  });

  describe('detectPowerSource parsing', () => {
    it('parses the PowerShell probe output', async () => {
      expect(parsePowerSourceOutput('desktop')).toBe('desktop');
      expect(parsePowerSourceOutput('ac')).toBe('ac');
      expect(parsePowerSourceOutput('battery')).toBe('battery');
      expect(parsePowerSourceOutput('battery\n')).toBe('battery');
      expect(parsePowerSourceOutput('  ac  ')).toBe('ac');
      expect(parsePowerSourceOutput('unknown')).toBe('unknown');
      // PowerShell unavailable / empty output / err
      expect(parsePowerSourceOutput(undefined)).toBe('unknown');
      expect(parsePowerSourceOutput('')).toBe('unknown');
      expect(parsePowerSourceOutput('something else')).toBe('unknown');
    });

    it('a FAILED battery query is not reported as a desktop', () => {
      // Regression: `-ErrorAction SilentlyContinue` alone makes a failed query look
      // like a successful-but-empty one, i.e. "desktop" — which holds sleep off on
      // any power, including battery. That would silently break the one guarantee
      // this feature makes. The script must use -ErrorVariable and answer 'unknown'.
      expect(POWER_QUERY_SCRIPT).toContain('-ErrorVariable');
      expect(POWER_QUERY_SCRIPT).toContain("Write-Output 'unknown'");
      // The error branch has to come BEFORE the empty-result branch, otherwise a
      // failure still falls through to 'desktop'.
      expect(POWER_QUERY_SCRIPT.indexOf("'unknown'")).toBeLessThan(
        POWER_QUERY_SCRIPT.indexOf("'desktop'"),
      );
    });

    it('power queries never throw (PowerShell missing ⇒ unknown)', async () => {
      // The real detector shells out to powershell.exe; wherever it cannot run
      // the answer must be `unknown`, never an exception.
      expect(['ac', 'battery', 'desktop', 'unknown']).toContain(detectPowerSource());
    });
  });

  describe('review regressions', () => {
    it('defaults to the ASYNC probe so no live path blocks the event loop', async () => {
      // Regression: the manager used to default to the synchronous `detectPowerSource`
      // (execFileSync), which stalled the scheduler/session/WebSocket for the whole
      // PowerShell round trip. `detectPowerSourceAsync` existed but was never wired.
      //
      // The sync detector returns a bare string; the async one returns a Promise.
      // On this machine PowerShell exists, so the sync one would resolve instantly and
      // the async one has a real `.then` — that difference is the assertion.
      const h = harness();
      const manager = createKeepAwake({ platform: 'win32', spawn: h.spawn as never });
      const inFlight = manager.refreshPowerSource();
      expect(typeof (inFlight as { then?: unknown }).then).toBe('function');
      const source = await inFlight;
      expect(['ac', 'battery', 'desktop', 'unknown']).toContain(source);
    });

    it('reports keeperFailed (not "unavailable") when the keeper dies on its own', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      // `Add-Type` blocked by execution policy ⇒ the keeper exits 3 by itself.
      // Nothing is holding sleep off now, but the power source is perfectly readable.
      h.children[0].emit('exit', 3, null);
      expect(manager.status()).toMatchObject({
        active: false,
        powerSource: 'ac',
        reason: 'keeperFailed',
      });
      manager.stop();
    });

    it('a deliberate stop() is NOT reported as keeperFailed', async () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      await manager.start();
      // Simulates the child noticing the closed stdin and exiting 0 after stop().
      manager.stop();
      h.children[0].emit('exit', 0, null);
      expect(manager.status()).toMatchObject({ active: false, reason: 'disabled' });
    });

    it('a failed spawn is keeperFailed, not "the power source is unreadable"', async () => {
      const spawn = vi.fn(() => {
        throw new Error('spawn powershell.exe EPERM');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const manager = createKeepAwake({
        platform: 'win32',
        spawn: spawn as never,
        getPowerSource: () => 'ac',
      });
      const status = await manager.start();
      expect(status).toMatchObject({ active: false, powerSource: 'ac', reason: 'keeperFailed' });
      manager.stop();
    });

    it('backs off instead of spawning a doomed keeper every tick', async () => {
      // Claude review on #37: a machine where the keeper can never run (Add-Type
      // blocked by execution policy) spawned a fresh doomed PowerShell process on
      // every 60s watchdog tick, forever, warning once a minute — and the reported
      // reason flickered terminal → 'starting' → terminal on each retry.
      vi.useFakeTimers();
      const h = harness();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = true;
      const spawn = vi.fn(() => {
        if (failing) throw new Error('spawn powershell.exe EPERM');
        const child = new FakeChild();
        h.children.push(child);
        queueMicrotask(() => child.emitReady());
        return child as unknown as ChildProcess;
      });
      const manager = createKeepAwake({
        platform: 'win32',
        spawn: spawn as never,
        getPowerSource: () => 'ac',
      });

      await manager.start();
      expect(spawn).toHaveBeenCalledTimes(1);
      // The failure is reported as a stable explanation, not a transient 'starting'.
      expect(manager.status()).toMatchObject({ reason: 'keeperFailed', active: false });

      // The first retry waits one interval, so the very next watchdog tick spawns
      // again (`now >= retryAt` is true exactly at the boundary). That is the
      // intended one-per-tick retry for a transient failure.
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.status()).toMatchObject({ reason: 'keeperFailed' });

      // From there the backoff doubles each time, so the *rate* decays: the next
      // 60s tick is not yet a retry (2m is owed) …
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(spawn).toHaveBeenCalledTimes(2);
      // … and the one after that is.
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(spawn).toHaveBeenCalledTimes(3);

      // The point of the backoff, stated as a rate: over the next hour a permanently
      // broken machine retries a handful of times, not 60 times.
      const before = spawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const retriesInAnHour = spawn.mock.calls.length - before;
      expect(retriesInAnHour).toBeLessThanOrEqual(6);

      // Once a keeper confirms its hold, the failure state clears and the backoff
      // resets, so a later failure starts over at one retry per tick.
      failing = false;
      await vi.advanceTimersByTimeAsync(KEEPER_RETRY_MAX_BACKOFF_MS);
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      manager.stop();
    });

    it('treats the discharging battery states as battery, not as AC', async () => {
      // `Win32_Battery.BatteryStatus` 4 (Low) and 5 (Critical) also mean the battery
      // is draining. Classifying them as `ac` made a laptop at 10% on battery read as
      // "on AC", so the keeper held the wake request while the battery drained —
      // breaking the "on battery it still sleeps" guarantee.
      //
      // The classification lives in the PowerShell source, so this pins the script's
      // decision table rather than executing it (the manager's probe is injected in
      // every other test). It is the assertion that would have caught the defect.
      const script = POWER_QUERY_SCRIPT;
      expect(script).toContain('-contains $battery[0].BatteryStatus');
      const batteryMatch = /@\(([^)]*)\)\s*-contains\s*\$battery\[0\]\.BatteryStatus/.exec(script);
      expect(batteryMatch, 'battery branch not found in the probe script').not.toBeNull();
      const batteryStatuses = (batteryMatch?.[1] ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      // 1 discharging, 4 Low, 5 Critical — all three must take the battery branch.
      expect(batteryStatuses.sort((a, b) => a - b)).toEqual([1, 4, 5]);
      // And the fall-through must be the AC branch, so the charged states still hold.
      expect(script).toMatch(/Write-Output 'ac'/);
    });

    it('treats an undefined BatteryStatus as unknown, not as AC', async () => {
      // 0 and 10 are documented as "undefined" — the same class of outcome as a
      // failed query. Mapping them to `ac` held a laptop's sleep off on the strength
      // of a reading we did not understand; only a reading we understand may justify
      // a hold. `battery` would also be wrong: it would misreport a desktop whose
      // firmware reports 0.
      const script = POWER_QUERY_SCRIPT;
      const branchFor = (codes: string) =>
        new RegExp(
          `@\\(${codes}\\)\\s*-contains\\s*\\$battery\\[0\\]\\.BatteryStatus\\)\\s*\\{\\s*Write-Output\\s*'([a-z]+)'`,
        ).exec(script)?.[1];
      expect(branchFor('1, 4, 5'), 'discharging codes').toBe('battery');
      expect(branchFor('0, 10'), 'undefined codes').toBe('unknown');
      // The branch must come BEFORE the AC fall-through, or it can never be reached.
      const undefinedIdx = script.indexOf("'unknown'; exit 0 }\nWrite-Output 'ac'");
      expect(
        undefinedIdx,
        'undefined-status branch must precede the AC fall-through',
      ).toBeGreaterThan(-1);
    });

    it('re-reads the power source on every watchdog tick, not every other one', async () => {
      // Claude review on #37: the watchdog shared `PROBE_STALE_MS` with the
      // settings-save path, but `lastProbeAt` is stamped when the probe *finishes* —
      // ~0.5s after the tick that started it — so the next tick measured ~59.5s and
      // skipped its re-read. The check therefore ran every ~120s while the UI
      // promised 60s, and a laptop unplugged just after a reading could stay held
      // awake on battery for up to two minutes.
      //
      // The probe must therefore CONSUME time for this test to reproduce the defect:
      // with an instantaneous probe the timestamp lands on the tick boundary and the
      // old code passes. Each probe here burns PROBE_DURATION_MS of the fake clock,
      // exactly as the real PowerShell round trip does.
      const PROBE_DURATION_MS = 500;
      vi.useFakeTimers();
      const h = harness();
      let source: PowerSource = 'ac';
      const probe = vi.fn(async (): Promise<PowerSource> => {
        await vi.advanceTimersByTimeAsync(PROBE_DURATION_MS);
        return source;
      });
      const manager = makeManager(h, 'win32', probe);

      await manager.start();
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });
      let reads = probe.mock.calls.length;

      // Unplug. The watchdog tick fires one interval after the previous tick — which
      // is only ~59.5s after the last probe *finished* — and must still re-read.
      source = 'battery';
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(probe.mock.calls.length, 'the tick after a completed probe must re-read').toBe(
        reads + 1,
      );
      expect(manager.status()).toMatchObject({ active: false, reason: 'battery' });

      // And again on the next tick, so the cadence is one read per interval rather
      // than the ~2 intervals the shared staleness boundary produced.
      reads = probe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POWER_POLL_MS);
      expect(probe.mock.calls.length).toBe(reads + 1);

      manager.stop();
    });

    it('resets the failure state when the switch is turned off, even with no keeper alive', async () => {
      // `killChild()` used to reset `keeperFailed` behind `if (!child) return`, so
      // when the keeper had already died on its own, toggling off and on left the
      // switch reporting "Failed" and refusing to retry for up to 15 minutes.
      vi.useFakeTimers();
      const h = harness();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = true;
      const spawn = vi.fn(() => {
        if (failing) throw new Error('spawn powershell.exe EPERM');
        const child = new FakeChild();
        h.children.push(child);
        queueMicrotask(() => child.emitReady());
        return child as unknown as ChildProcess;
      });
      const manager = createKeepAwake({
        platform: 'win32',
        spawn: spawn as never,
        getPowerSource: () => 'ac',
      });

      await manager.start();
      expect(manager.status()).toMatchObject({ reason: 'keeperFailed' });

      // Switch off, then on again: the re-enable must start from a clean slate.
      manager.stop();
      failing = false;
      // `start()` resolves before the keeper has confirmed its hold (that arrives on
      // the stdout microtask and is reported by the next status read), so assert the
      // state after the READY line has landed. The point of this test is that the
      // retry is not deferred by the old backoff — hence the immediate re-spawn.
      await manager.start();
      await flush();
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });

      manager.stop();
    });

    it('does not treat a late error from a released keeper as a failure', async () => {
      // The `error` handler used to call `noteKeeperFailure()` even when the child was
      // no longer current, so a deliberate release whose grace-period `kill()` then
      // errored was recorded as `keeperFailed`.
      vi.useFakeTimers();
      const h = harness();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const manager = makeManager(h, 'win32', () => 'ac');

      await manager.start();
      await flush();
      expect(manager.status()).toMatchObject({ active: true });
      const child = h.children[0];

      manager.stop();
      // The keeper emits a late error after we let it go.
      child.emit('error', new Error('kill failed'));
      expect(manager.status()).toMatchObject({ reason: 'disabled' });

      await vi.advanceTimersByTimeAsync(KEEPER_EXIT_GRACE_MS);
      expect(manager.status()).toMatchObject({ reason: 'disabled' });
    });
  });
});
