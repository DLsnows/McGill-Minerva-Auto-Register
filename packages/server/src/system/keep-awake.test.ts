import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  KEEPER_REFRESH_SECONDS,
  POWER_POLL_MS,
  createKeepAwake,
  detectPowerSource,
  parsePowerSourceOutput,
  shouldHold,
  type PowerSource,
} from './keep-awake';

/** Minimal stand-in for a spawned child: no PowerShell is ever executed. */
class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  unref = vi.fn();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn(), destroy: vi.fn(), write: vi.fn() };
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

interface Harness {
  children: FakeChild[];
  spawn: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const children: FakeChild[] = [];
  return {
    children,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }),
  };
}

function makeManager(
  h: Harness,
  platform: NodeJS.Platform = 'win32',
  source: () => PowerSource = () => 'ac',
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

describe('keep-awake', () => {
  describe('platform support', () => {
    it('is supported on win32 only', () => {
      const h = harness();
      expect(makeManager(h, 'win32').isSupported()).toBe(true);
      for (const platform of ['linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
        expect(makeManager(h, platform).isSupported()).toBe(false);
      }
    });

    it('is a no-op off Windows: nothing is spawned and status says unsupported', () => {
      const h = harness();
      const manager = makeManager(h, 'linux', () => 'ac');
      const status = manager.start();
      expect(h.spawn).not.toHaveBeenCalled();
      expect(manager.stop());
      expect(h.spawn).not.toHaveBeenCalled();
      expect(status).toMatchObject({ supported: false, active: false, reason: 'unsupported' });
      expect(manager.getPowerSource()).toBe('unknown');
    });
  });

  describe('power-source gating', () => {
    it('holds on AC and on a desktop, never on battery', () => {
      expect(shouldHold('ac', true)).toBe(true);
      expect(shouldHold('desktop', true)).toBe(true);
      expect(shouldHold('battery', true)).toBe(false);
      expect(shouldHold('unknown', true)).toBe(false);
      // Disabled wins over everything.
      expect(shouldHold('ac', false)).toBe(false);
      expect(shouldHold('desktop', false)).toBe(false);
    });

    it('does NOT start a keeper while on battery', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'battery');
      const status = manager.start();
      expect(h.spawn).not.toHaveBeenCalled();
      expect(status).toMatchObject({ active: false, settingEnabled: true, reason: 'battery' });
    });

    it('starts a keeper on AC and stops it again when switching to battery', () => {
      vi.useFakeTimers();
      const h = harness();
      let source: PowerSource = 'battery';
      const manager = makeManager(h, 'win32', () => source);

      expect(manager.start()).toMatchObject({ active: false, reason: 'battery' });

      // Plug the charger in: the 60s watchdog picks the change up.
      source = 'ac';
      vi.advanceTimersByTime(POWER_POLL_MS);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(manager.status()).toMatchObject({ active: true, reason: 'active' });
      const child = h.children[0];

      // Unplug: the hold is released (stdin closed, then killed after the grace period).
      source = 'battery';
      vi.advanceTimersByTime(POWER_POLL_MS);
      expect(child.stdin.end).toHaveBeenCalled();
      expect(manager.status()).toMatchObject({ active: false, reason: 'battery' });

      manager.stop();
    });

    it('reports "unavailable" when the probe cannot establish the power source', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'unknown');
      expect(manager.start()).toMatchObject({ active: false, reason: 'unavailable' });
      expect(h.spawn).not.toHaveBeenCalled();
      manager.stop();
    });

    it('probes the power source on a status() read so the UI can say "on battery" before the switch is on', () => {
      const h = harness();
      const probe = vi.fn((): PowerSource => 'battery');
      const manager = makeManager(h, 'win32', probe);
      const status = manager.status();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(status).toMatchObject({ settingEnabled: false, powerSource: 'battery' });
      // A second read uses the cached value (no extra PowerShell call)…
      manager.status();
      expect(probe).toHaveBeenCalledTimes(1);
      // …unless explicitly asked for a pure cached read.
      manager.status(false);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('swallows a throwing probe instead of crashing the server', () => {
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
    it('spawns PowerShell with the documented ES_* flags and no ES_DISPLAY_REQUIRED', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();

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

    it('does not re-spawn while a keeper is already holding the request', () => {
      vi.useFakeTimers();
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();
      manager.start();
      vi.advanceTimersByTime(POWER_POLL_MS * 3);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('stop() terminates the keeper child (cooperative EOF + force kill)', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();
      const child = h.children[0];

      const status = manager.stop();
      expect(child.stdin.end).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
      expect(status).toMatchObject({ active: false, settingEnabled: false, reason: 'disabled' });
    });

    it('stop() is idempotent and does not throw without a child', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      expect(() => {
        manager.stop();
        manager.stop();
      }).not.toThrow();
      manager.start();
      manager.stop();
      expect(() => manager.stop()).not.toThrow();
    });

    it('clears the power watchdog so nothing keeps ticking after stop()', () => {
      vi.useFakeTimers();
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();
      manager.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a failed spawn degrades to unavailable instead of throwing', () => {
      const spawn = vi.fn(() => {
        throw new Error('spawn powershell.exe ENOENT');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const manager = createKeepAwake({
        platform: 'win32',
        spawn: spawn as never,
        getPowerSource: () => 'ac',
      });
      expect(() => manager.start()).not.toThrow();
      expect(manager.status()).toMatchObject({ active: false, reason: 'unavailable' });
      expect(errorSpy).toHaveBeenCalled();
      manager.stop();
    });

    it('a keeper that exits on its own is forgotten (no stale "active")', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();
      expect(manager.status().active).toBe(true);
      h.children[0].emit('exit', 0, null);
      expect(manager.status().active).toBe(false);
      manager.stop();
    });

    it('killChildSync() force-kills the child (the process "exit" sweep)', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');
      manager.start();
      const child = h.children[0];
      manager.killChildSync();
      expect(child.stdin.destroy).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
      expect(manager.status().active).toBe(false);
      manager.stop();
    });
  });

  describe('apply()', () => {
    it('start()s when the setting is on and stop()s when it is off', () => {
      const h = harness();
      const manager = makeManager(h, 'win32', () => 'ac');

      expect(manager.apply({ keepAwake: true })).toMatchObject({
        active: true,
        settingEnabled: true,
      });
      expect(h.spawn).toHaveBeenCalledTimes(1);

      expect(manager.apply({ keepAwake: false })).toMatchObject({
        active: false,
        reason: 'disabled',
      });

      // An absent field counts as "off" — the default is opt-in.
      manager.apply({ keepAwake: true });
      expect(manager.apply({})).toMatchObject({ active: false });
    });
  });

  describe('detectPowerSource parsing', () => {
    it('parses the PowerShell probe output', () => {
      expect(parsePowerSourceOutput('desktop')).toBe('desktop');
      expect(parsePowerSourceOutput('ac')).toBe('ac');
      expect(parsePowerSourceOutput('battery')).toBe('battery');
      expect(parsePowerSourceOutput('battery\n')).toBe('battery');
      expect(parsePowerSourceOutput('  ac  ')).toBe('ac');
      // PowerShell unavailable / empty output / err
      expect(parsePowerSourceOutput(undefined)).toBe('unknown');
      expect(parsePowerSourceOutput('')).toBe('unknown');
      expect(parsePowerSourceOutput('something else')).toBe('unknown');
    });

    it('power queries never throw (PowerShell missing ⇒ unknown)', () => {
      // The real detector shells out to powershell.exe; wherever it cannot run
      // the answer must be `unknown`, never an exception.
      expect(['ac', 'battery', 'desktop', 'unknown']).toContain(detectPowerSource());
    });
  });
});
