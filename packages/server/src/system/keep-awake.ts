import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/**
 * Windows "keep awake" switch.
 *
 * Holds `ES_SYSTEM_REQUIRED` (and deliberately *not* `ES_DISPLAY_REQUIRED`) from
 * a long-lived PowerShell child process, so the machine stops auto-sleeping
 * while the display still turns off normally. Only the child holds the request,
 * so the moment it exits the machine is back to its normal power behaviour —
 * nothing about the user's power plan is ever modified (no `powercfg /change`).
 *
 * Laptops only keep awake on AC: on battery the request is dropped and the PC
 * sleeps as usual.
 */

export type PowerSource = 'ac' | 'battery' | 'desktop' | 'unknown';

export type KeepAwakeReason =
  'active' | 'battery' | 'disabled' | 'unsupported' | 'unavailable' | 'pending';

export interface KeepAwakeStatus {
  /** The platform can host the keeper (Windows only). */
  supported: boolean;
  /** The value stored in settings. */
  settingEnabled: boolean;
  /** A keeper process is currently holding the wake request. */
  active: boolean;
  powerSource: PowerSource;
  reason: KeepAwakeReason;
}

export interface KeepAwake {
  isSupported(): boolean;
  /** Reads the current power source (cheap: one CIM query, ~200 ms). */
  getPowerSource(): PowerSource;
  /** Pid of the live keeper child process, or `undefined` when none is running.
   * Used by the manual smoke test to prove the child is really gone. */
  readonly keeperPid: number | undefined;
  start(intervalMs?: number): KeepAwakeStatus;
  stop(): KeepAwakeStatus;
  /** Current state. Probes the power source when it has not been read yet;
   * pass `false` for a pure read of the cached value. */
  status(probeIfStale?: boolean): KeepAwakeStatus;
  /** Apply a persisted setting: `start()` when on, `stop()` when off. */
  apply(settings: { keepAwake?: boolean }): KeepAwakeStatus;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

export interface KeepAwakeDeps {
  /** Overridable for tests (never call the real `process.platform` there). */
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  /** Overridable for tests: the real one shells out to PowerShell. */
  getPowerSource?: () => PowerSource;
  onEvent?: (message: string, level: 'info' | 'warn') => void;
}

/** How often the keeper re-asserts the request, and how often its stdin poll
 * loop checks whether we asked it to quit. */
export const KEEPER_REFRESH_SECONDS = 5;

/** How often we re-check the power source to follow AC ↔ battery changes. */
export const POWER_POLL_MS = 60_000;

/** Grace period before force-killing a keeper that did not exit on its own. */
export const KEEPER_EXIT_GRACE_MS = 4_000;

/** Timeout for the one-shot PowerShell power queries. */
const QUERY_TIMEOUT_MS = 15_000;

const PS_EXE = process.env.AUTOREG_POWERSHELL ?? 'powershell.exe';

// Shared by the keeper and the one-shot power query. `0x80000000` cannot be
// written as a PowerShell hex literal: it is parsed as a negative Int32 and the
// `[uint32]` cast then throws, so ES_CONTINUOUS uses its decimal value instead.
const P_INTEROP = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
`;

/**
 * The keeper: holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED and exits (releasing the
 * request) when stdin reaches EOF or when it receives `QUIT`.
 */
export const KEEPER_SCRIPT = `
${P_INTEROP}
[uint32]$ES_CONTINUOUS = 2147483648
[uint32]$ES_SYSTEM_REQUIRED = 1
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if ([Awake]::SetThreadExecutionState($flags) -eq 0) { exit 3 }
Write-Output 'READY'
[Console]::Out.Flush()
while ($true) {
  Start-Sleep -Seconds ${KEEPER_REFRESH_SECONDS}
  if ([Console]::In.Peek() -eq -1) { break }
  if ([Awake]::SetThreadExecutionState($flags) -eq 0) { break }
}
[void][Awake]::SetThreadExecutionState($ES_CONTINUOUS)
exit 0
`;

/**
 * One-shot power-source probe. Prints exactly one of:
 * `desktop` (no battery, i.e. a tower/mini), `ac`, `battery`, or nothing when
 * the query itself failed (→ `unknown`).
 *
 * `Win32_Battery.BatteryStatus`: 2 = AC, 1 = discharging. A present-but-idle
 * battery can report other values; those fall back to `ac` because
 * `PowerManagementSupported`/status are unreliable on some firmware.
 */
export const POWER_QUERY_SCRIPT = `
$battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
if ($battery.Count -eq 0) { Write-Output 'desktop'; exit 0 }
if ($battery[0].BatteryStatus -eq 1) { Write-Output 'battery'; exit 0 }
Write-Output 'ac'
`;

/** Run a PowerShell snippet and return its trimmed stdout, or `undefined` when
 * PowerShell is missing / errors / times out. Never throws. */
function runPowerShell(script: string): string | undefined {
  try {
    return execFileSync(PS_EXE, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
  } catch (err) {
    console.error(
      '[keep-awake] PowerShell query failed:',
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/** Map the probe's stdout to a `PowerSource`. Anything unexpected (PowerShell
 * missing, non-zero exit, garbage output) is `unknown` — never a guess. */
export function parsePowerSourceOutput(out: string | undefined): PowerSource {
  const value = out?.trim();
  if (value === 'desktop' || value === 'ac' || value === 'battery') return value;
  return 'unknown';
}

/** Detect the power source via `Win32_Battery` (no admin rights needed). */
export function detectPowerSource(): PowerSource {
  return parsePowerSourceOutput(runPowerShell(POWER_QUERY_SCRIPT));
}

/** Pure decision: should a keeper hold the wake request right now? */
export function shouldHold(powerSource: PowerSource, settingEnabled: boolean): boolean {
  if (!settingEnabled) return false;
  if (powerSource === 'ac' || powerSource === 'desktop') return true;
  return false;
}

function reasonFor(
  powerSource: PowerSource,
  settingEnabled: boolean,
  active: boolean,
): KeepAwakeReason {
  if (active) return 'active';
  if (!settingEnabled) return 'disabled';
  if (powerSource === 'battery') return 'battery';
  // Enabled but not holding: the platform/power state cannot be established
  // (PowerShell missing, probe failed, ...).
  return 'unavailable';
}

class KeepAwakeManager implements KeepAwake {
  private readonly platform: NodeJS.Platform;
  private readonly spawnChild: SpawnFn;
  private readonly probe: () => PowerSource;
  private readonly onEvent: (message: string, level: 'info' | 'warn') => void;

  private child?: ChildProcess;
  private timer?: ReturnType<typeof setInterval>;
  private powerSource: PowerSource = 'unknown';
  private settingEnabled = false;
  private intervalMs = POWER_POLL_MS;

  constructor(deps: KeepAwakeDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.spawnChild = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.probe = deps.getPowerSource ?? detectPowerSource;
    this.onEvent = deps.onEvent ?? (() => undefined);
  }

  isSupported(): boolean {
    return this.platform === 'win32';
  }

  get keeperPid(): number | undefined {
    return this.child?.pid;
  }

  getPowerSource(): PowerSource {
    if (!this.isSupported()) return 'unknown';
    try {
      this.powerSource = this.probe();
    } catch (err) {
      console.error(
        '[keep-awake] power probe failed:',
        err instanceof Error ? err.message : String(err),
      );
      this.powerSource = 'unknown';
    }
    return this.powerSource;
  }

  start(intervalMs = POWER_POLL_MS): KeepAwakeStatus {
    this.settingEnabled = true;
    if (!this.isSupported()) {
      // Nothing to do off Windows — never spawn anything.
      return this.status();
    }
    this.intervalMs = intervalMs;
    this.tick();
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      // Never let the watchdog alone keep the process alive.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    return this.status();
  }

  stop(): KeepAwakeStatus {
    this.settingEnabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.killChild(true);
    return this.status();
  }

  status(probeIfStale = true): KeepAwakeStatus {
    const supported = this.isSupported();
    // Without a probe the UI would show "disabled" with an unknown power source
    // and could not say "waiting for AC" before the switch is ever turned on.
    if (probeIfStale && supported && this.powerSource === 'unknown') this.getPowerSource();
    const active = this.child !== undefined;
    return {
      supported,
      settingEnabled: this.settingEnabled,
      active,
      powerSource: this.powerSource,
      reason: supported ? reasonFor(this.powerSource, this.settingEnabled, active) : 'unsupported',
    };
  }

  apply(settings: { keepAwake?: boolean }): KeepAwakeStatus {
    return settings.keepAwake === true ? this.start(this.intervalMs) : this.stop();
  }

  /** Synchronous best-effort cleanup for `process.on('exit')`. */
  killChildSync(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin?.destroy();
      child.kill();
    } catch {
      // Process already gone — nothing left to clean up.
    }
  }

  private tick(): void {
    if (!this.isSupported()) return;
    const source = this.getPowerSource();
    const hold = shouldHold(source, this.settingEnabled);
    if (hold && !this.child) {
      this.spawnKeeper();
    } else if (!hold && this.child) {
      this.killChild(false);
    }
    // While disabled the cached source still drives the UI wording.
  }

  private spawnKeeper(): void {
    let child: ChildProcess;
    try {
      child = this.spawnChild(
        PS_EXE,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', KEEPER_SCRIPT],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
      );
    } catch (err) {
      console.error(
        '[keep-awake] failed to spawn keeper:',
        err instanceof Error ? err.message : String(err),
      );
      this.powerSource = 'unknown';
      return;
    }
    this.child = child;
    // Do not hold the event loop open on the keeper; the exit hooks below (and
    // the fact that its stdin closes with our own stdio) clean it up.
    child.unref?.();
    child.stdout?.on('data', () => undefined);
    child.on('error', (err) => {
      console.error('[keep-awake] keeper error:', err.message);
      if (this.child === child) this.child = undefined;
      this.powerSource = 'unknown';
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (code === 0 || signal) return;
      console.warn(
        `[keep-awake] keeper exited unexpectedly (code ${String(code)}) — wake request released.`,
      );
    });
    this.onEvent('keep-awake: sleep prevention active (display still turns off)', 'info');
  }

  private killChild(sync: boolean): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      // Closing stdin is the cooperative path: the keeper sees EOF, restores
      // ES_CONTINUOUS and exits on its own within one refresh tick.
      child.stdin?.end();
      if (sync) {
        child.kill();
      } else {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Already exited.
          }
        }, KEEPER_EXIT_GRACE_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }
    } catch {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
    this.onEvent('keep-awake: sleep prevention released', 'info');
  }
}

/** A manager above, plus the synchronous last-resort sweep used by `exit`. */
export interface KeepAwakeManagerHandle extends KeepAwake {
  killChildSync(): void;
}

export function createKeepAwake(deps: KeepAwakeDeps = {}): KeepAwakeManagerHandle {
  return new KeepAwakeManager(deps);
}

const singleton = createKeepAwake();

/**
 * The process-wide keeper.
 *
 * NOTE: the running server does NOT use this instance — `createRuntime()` builds
 * its own so it can wire `onEvent` into the store. This singleton exists purely
 * as the synchronous last-resort cleanup target for `process.on('exit')`, which
 * cannot reach into the runtime.
 */
export function killKeepAwakeSync(): void {
  singleton.killChildSync();
}
