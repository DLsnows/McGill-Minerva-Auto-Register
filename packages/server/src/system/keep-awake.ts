import { execFile, execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

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
  | 'active'
  | 'battery'
  | 'disabled'
  | 'unsupported'
  | 'unavailable'
  | 'keeperFailed'
  | 'pending'
  | 'starting';

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
  /** Last known power source. Cheap and synchronous — it reads the cache, never the
   * machine. Use `refreshPowerSource()` to actually probe. */
  getPowerSource(): PowerSource;
  /** Await a fresh probe. Off every request path by design. */
  refreshPowerSource(): Promise<PowerSource>;
  /** Pid of the live keeper child process, or `undefined` when none is running.
   * Used by the manual smoke test to prove the child is really gone. */
  readonly keeperPid: number | undefined;
  start(intervalMs?: number): Promise<KeepAwakeStatus>;
  stop(): KeepAwakeStatus;
  /** Current state. Non-blocking: the first call kicks off a probe in the background
   * and the reading shows up on a later call. Pass `false` to skip even that. */
  status(probeIfStale?: boolean): KeepAwakeStatus;
  /** Apply a persisted setting: `start()` when on, `stop()` when off. */
  apply(settings: { keepAwake?: boolean }): Promise<KeepAwakeStatus>;
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
  /** Overridable for tests: the real one shells out to PowerShell. May be async —
   * the manager awaits it, so a slow probe never blocks the event loop. */
  getPowerSource?: () => PowerSource | Promise<PowerSource>;
  onEvent?: (message: string, level: 'info' | 'warn') => void;
}

/** How often the keeper re-asserts the request, and how often its stdin poll
 * loop checks whether we asked it to quit. */
export const KEEPER_REFRESH_SECONDS = 5;

/** How often we re-check the power source to follow AC ↔ battery changes. */
export const POWER_POLL_MS = 60_000;

/** Grace period before force-killing a keeper that did not exit on its own. */
export const KEEPER_EXIT_GRACE_MS = 4_000;

/** The keeper prints this once `SetThreadExecutionState` has returned non-zero —
 * the only proof that the machine is actually being held awake. */
export const KEEPER_READY = 'READY';

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
Write-Output '${KEEPER_READY}'
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
 * `desktop` (no battery, i.e. a tower/mini), `ac`, `battery`, or `unknown` when
 * the query itself failed.
 *
 * `-ErrorVariable` is load-bearing: `-ErrorAction SilentlyContinue` alone makes a
 * *failed* query look identical to a *successful, empty* one, so a laptop whose
 * CIM/WMI provider errors out would be reported as `desktop` and — because
 * desktops hold on any power — the machine would stay awake **on battery**,
 * silently breaking the one guarantee this feature makes. A failure must degrade
 * to `unknown` (→ "unavailable"), never to a hold.
 *
 * `Win32_Battery.BatteryStatus`: 2 = AC, 1 = discharging. A present-but-idle
 * battery can report other values; those fall back to `ac` because
 * `PowerManagementSupported`/status are unreliable on some firmware.
 */
export const POWER_QUERY_SCRIPT = `
$cimError = $null
$battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue -ErrorVariable cimError)
if ($cimError.Count -gt 0) { Write-Output 'unknown'; exit 0 }
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

/**
 * Async twin of `runPowerShell`.
 *
 * The synchronous version blocks the whole event loop for as long as PowerShell takes
 * (up to `QUERY_TIMEOUT_MS`). That is unacceptable here: this server drives a
 * registration scheduler and a WebSocket stream, and the settings page polls
 * `GET /api/power` every 30s — on a machine where PowerShell is slow or broken (the
 * exact case this feature promises to degrade gracefully for) each poll would freeze
 * the scheduler and the UI for up to 15s, repeatedly.
 */
function runPowerShellAsync(script: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.error(
            '[keep-awake] PowerShell query failed:',
            err instanceof Error ? err.message : String(err),
          );
          resolve(undefined);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Map the probe's stdout to a `PowerSource`. Anything unexpected (PowerShell
 * missing, non-zero exit, garbage output) is `unknown` — never a guess. */
export function parsePowerSourceOutput(out: string | undefined): PowerSource {
  const value = out?.trim();
  if (value === 'desktop' || value === 'ac' || value === 'battery') return value;
  return 'unknown';
}

/** Synchronous probe. Kept for one-shot/cold-start use and for the tests, which inject
 * their own source. Prefer `detectPowerSourceAsync()` anywhere on a request path. */
export function detectPowerSource(): PowerSource {
  return parsePowerSourceOutput(runPowerShell(POWER_QUERY_SCRIPT));
}

/** Non-blocking probe used everywhere on a live server path. */
export async function detectPowerSourceAsync(): Promise<PowerSource> {
  return parsePowerSourceOutput(await runPowerShellAsync(POWER_QUERY_SCRIPT));
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
  starting: boolean,
  probeSettled: boolean,
  keeperFailed: boolean,
): KeepAwakeReason {
  if (active) return 'active';
  if (!settingEnabled) return 'disabled';
  if (powerSource === 'battery') return 'battery';
  // Enabled, no hold, and the last keeper *we started* died on its own (blocked
  // `Add-Type` under an execution policy, `SetThreadExecutionState` returning 0, …).
  // The power source is fine — reporting 'unavailable' here would blame the probe
  // for something that is not its fault.
  if (keeperFailed) return 'keeperFailed';
  // A keeper is running but has not confirmed the hold yet (its `READY` line is in
  // flight). The machine is about to be held — this must NOT read as active, and it
  // must not read as a failure either.
  if (starting) return 'starting';
  // Enabled, no keeper yet, and no reading has landed yet: the first probe is still
  // in flight (it is async now, so the switch can be on for a moment before the first
  // reading arrives). 'pending' rather than 'unavailable' so the UI does not briefly
  // claim the platform cannot be used.
  if (powerSource === 'unknown' && !probeSettled) return 'pending';
  // Enabled but not holding, and the reading is settled — so the hold was refused for
  // another reason (PowerShell missing, the probe failed, ...).
  return 'unavailable';
}

class KeepAwakeManager implements KeepAwake {
  private readonly platform: NodeJS.Platform;
  private readonly spawnChild: SpawnFn;
  private readonly probe: () => PowerSource | Promise<PowerSource>;
  private readonly onEvent: (message: string, level: 'info' | 'warn') => void;

  private child?: ChildProcess;
  private timer?: ReturnType<typeof setInterval>;
  private powerSource: PowerSource = 'unknown';
  private settingEnabled = false;
  private intervalMs = POWER_POLL_MS;
  /** In-flight cold-start probe, so concurrent `/api/power` polls share one spawn. */
  private probeInFlight?: Promise<void>;
  /** Whether a probe has ever completed (successfully or not). Distinguishes an
   * in-flight first probe from a settled "we could not read it" outcome. */
  private probeSettled = false;
  /** Set when a keeper we started exited on its own; cleared when one is running. */
  private keeperFailed = false;
  /** Set once the keeper has confirmed it holds the request (its `READY` line).
   * `this.child` alone is not enough: it exists between spawn and that confirmation. */
  private keeperReady = false;

  constructor(deps: KeepAwakeDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.spawnChild = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    // The async detector, NOT the sync one: this default runs on every live-server
    // path (the 60s watchdog, `start()` on save/startup, the first `/api/power`).
    // `detectPowerSource` uses `execFileSync` and would stall the scheduler, the
    // session manager and the WebSocket stream for the whole PowerShell round trip
    // (up to `QUERY_TIMEOUT_MS`). Inject `getPowerSource` to drive the sync path.
    this.probe = deps.getPowerSource ?? detectPowerSourceAsync;
    this.onEvent = deps.onEvent ?? (() => undefined);
  }

  isSupported(): boolean {
    return this.platform === 'win32';
  }

  get keeperPid(): number | undefined {
    return this.child?.pid;
  }

  getPowerSource(): PowerSource {
    return this.powerSource;
  }

  /**
   * Refresh the cached power source if it has never been established.
   *
   * Deliberately does NOT probe on every call. `status()` sits behind `GET /api/power`,
   * which the settings page polls every 30s, so probing there meant a PowerShell spawn
   * per poll — and, with the old synchronous probe, a repeated event-loop stall.
   * The 60s watchdog is what keeps the reading current once the switch is on; this only
   * covers the cold-start case so the UI can say "waiting for AC" before the first tick.
   *
   * Concurrent callers share one in-flight probe instead of stacking spawns.
   */
  refreshPowerSourceIfUnknown(): void {
    if (!this.isSupported() || this.powerSource !== 'unknown' || this.probeInFlight) return;
    void this.probeOnce();
  }

  /**
   * Await a fresh power-source reading. Not on any request path — `status()` deliberately
   * stays non-blocking — but useful for startup/warm-up and for the smoke script, which
   * needs the real value rather than the empty cache.
   */
  async refreshPowerSource(): Promise<PowerSource> {
    if (this.isSupported()) await this.probePowerSource();
    return this.powerSource;
  }

  private async probePowerSource(): Promise<void> {
    try {
      this.powerSource = await this.probe();
    } catch (err) {
      console.error(
        '[keep-awake] power probe failed:',
        err instanceof Error ? err.message : String(err),
      );
      this.powerSource = 'unknown';
    } finally {
      // Either way the reading is settled now, so 'pending' no longer applies.
      this.probeSettled = true;
    }
  }

  /** The shared single-flight probe. Concurrent callers await the *same* PowerShell
   * spawn instead of stacking one each. */
  private probeOnce(): Promise<void> {
    this.probeInFlight ??= this.probePowerSource().finally(() => {
      this.probeInFlight = undefined;
    });
    return this.probeInFlight;
  }

  /**
   * Turn the switch on.
   *
   * `tick(true)` forces a fresh reading only when none has ever landed. It must NOT
   * probe unconditionally: `PUT /api/settings` awaits `apply()`, so re-probing on
   * every save would park an unrelated settings save behind a PowerShell round trip
   * (~0.5s typical, up to `QUERY_TIMEOUT_MS` when PowerShell is slow or broken — the
   * exact machine this feature promises to degrade gracefully on). The 60s watchdog
   * owns keeping the reading current; the first reading is the only one a caller
   * genuinely has to wait for.
   */
  async start(intervalMs = POWER_POLL_MS): Promise<KeepAwakeStatus> {
    this.settingEnabled = true;
    if (!this.isSupported()) {
      // Nothing to do off Windows — never spawn anything.
      return this.status();
    }
    this.intervalMs = intervalMs;
    await this.tick(true);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
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
    this.killChild();
    return this.status();
  }

  status(probeIfStale = true): KeepAwakeStatus {
    const supported = this.isSupported();
    // Kick off a one-off probe the first time (so the UI can say "waiting for AC"
    // before the switch is ever turned on) but never wait for it here: this method is
    // on a 30s-polled request path and must stay non-blocking. The result lands in the
    // cache and is visible on the next poll.
    if (probeIfStale) this.refreshPowerSourceIfUnknown();
    // `active` means the keeper really holds the request — not merely that a child
    // process exists. Between spawn and the keeper's `READY` line the machine is not
    // awake yet, and a keeper that dies immediately (blocked `Add-Type`) must never be
    // reported as "Active — the PC will not sleep".
    const active = this.child !== undefined && this.keeperReady;
    return {
      supported,
      settingEnabled: this.settingEnabled,
      active,
      powerSource: this.powerSource,
      reason: supported
        ? reasonFor(
            this.powerSource,
            this.settingEnabled,
            active,
            this.child !== undefined && !this.keeperReady,
            this.probeSettled,
            this.keeperFailed,
          )
        : 'unsupported',
    };
  }

  async apply(settings: { keepAwake?: boolean }): Promise<KeepAwakeStatus> {
    return settings.keepAwake === true ? this.start(this.intervalMs) : this.stop();
  }

  /** Synchronous best-effort cleanup for `process.on('exit')`. */
  killChildSync(): void {
    const child = this.child;
    this.child = undefined;
    this.keeperReady = false;
    if (!child) return;
    this.keeperFailed = false;
    try {
      child.stdin?.destroy();
      child.kill();
    } catch {
      // Process already gone — nothing left to clean up.
    }
  }

  private async tick(probe = true): Promise<void> {
    if (!this.isSupported()) return;
    // Only the first tick (and the watchdog) probes; see `start()` for why.
    if (probe || this.powerSource === 'unknown') await this.probeOnce();
    const hold = shouldHold(this.powerSource, this.settingEnabled);
    if (hold && !this.child) {
      this.spawnKeeper();
    } else if (!hold && this.child) {
      this.killChild();
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
      // The source itself was read fine; it is the keeper that could not run.
      this.keeperFailed = true;
      return;
    }
    this.child = child;
    this.keeperReady = false;
    this.keeperFailed = false;
    // Do not hold the event loop open on the keeper; the exit hooks below (and
    // the fact that its stdin closes with our own stdio) clean it up.
    child.unref?.();
    // The keeper prints READY only after `SetThreadExecutionState` returned non-zero,
    // so this line is the actual proof that the machine is being held awake.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      if (this.child !== child || this.keeperReady) return;
      if (String(chunk).includes(KEEPER_READY)) {
        this.keeperReady = true;
        this.keeperFailed = false;
        this.onEvent('keep-awake: sleep prevention active (display still turns off)', 'info');
      }
    });
    child.on('error', (err) => {
      console.error('[keep-awake] keeper error:', err.message);
      if (this.child === child) {
        this.child = undefined;
        this.keeperReady = false;
      }
      this.keeperFailed = true;
    });
    child.on('exit', (code, signal) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) {
        this.child = undefined;
        this.keeperReady = false;
      }
      // A code-0/signal exit is one *we* asked for (stop()/killChild): not a failure.
      // Anything else means the keeper died on its own, and nothing is holding sleep
      // off — surface that as such instead of blaming the power-source probe.
      if (code === 0 || signal || !wasCurrent) return;
      this.keeperFailed = true;
      console.warn(
        `[keep-awake] keeper exited unexpectedly (code ${String(code)}) — wake request released.`,
      );
    });
  }

  /**
   * Release the hold, gracefully first.
   *
   * Closing stdin is the cooperative path — the keeper sees EOF, restores
   * `ES_CONTINUOUS` and exits on its own within one refresh tick — and a forced
   * `kill()` follows only after `KEEPER_EXIT_GRACE_MS`. This applies to EVERY
   * release path, including the main "switch off" one: an earlier revision
   * hard-killed here while the docs promised the grace period, so the documented
   * behaviour only held for the battery path.
   *
   * The method stays synchronous (the caller gets the status immediately); only the
   * fallback kill is deferred.
   */
  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    this.keeperReady = false;
    if (!child) return;
    // We are shutting this keeper down on purpose, so its exit is not a failure.
    this.keeperFailed = false;
    try {
      child.stdin?.end();
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already exited.
        }
      }, KEEPER_EXIT_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();
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
