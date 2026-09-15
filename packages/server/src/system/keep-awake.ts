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

/**
 * How long a power reading stays usable before the next tick re-reads it.
 *
 * Equal to the watchdog interval on purpose: every watchdog tick must therefore see
 * a stale reading and probe (that is how plugging in the charger is noticed), while
 * the `PUT /api/settings` path — which reaches the same `tick()` on every save —
 * reuses the cached reading instead of parking the save behind PowerShell. Both
 * behaviours come from this one number rather than from per-caller flags.
 */
export const PROBE_STALE_MS = POWER_POLL_MS;

/**
 * How long to wait before re-spawning a keeper that failed to start.
 *
 * Without this, a machine where the keeper can never run — `Add-Type` blocked by
 * execution policy, PowerShell unavailable to the child, `SetThreadExecutionState`
 * refused — spawns a doomed process on *every* 60s watchdog tick, forever, logging
 * a warning each time. The retry itself is right (the condition can be transient);
 * the unbounded rate is not. Doubles per consecutive failure, capped here, and
 * resets the moment a keeper confirms its hold.
 */
export const KEEPER_RETRY_MAX_BACKOFF_MS = 15 * 60_000;

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
 * `Win32_Battery.BatteryStatus`: 1 = discharging, 4 = Low, 5 = Critical. Per the
 * Win32_Battery docs 4 and 5 also mean the battery is *draining* — they are not
 * "on AC" — so all three must take the battery branch. Treating 4/5 as `ac` made a
 * laptop at 10% on battery read as "on AC", and the keeper then held the wake
 * request while the battery drained, breaking the one guarantee this feature makes
 * ("on battery the PC still sleeps as usual").
 *
 * Charging/charged states ({2, 3, 6, 7, 8, 9, 11}) and "no battery present" fall
 * through to `ac`/`desktop`; 0 and 10 mean "unknown/undefined", which the
 * `PowerManagementSupported` note below covers.
 */
export const POWER_QUERY_SCRIPT = `
$cimError = $null
$battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue -ErrorVariable cimError)
if ($cimError.Count -gt 0) { Write-Output 'unknown'; exit 0 }
if ($battery.Count -eq 0) { Write-Output 'desktop'; exit 0 }
if (@(1, 4, 5) -contains $battery[0].BatteryStatus) { Write-Output 'battery'; exit 0 }
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

/**
 * Pure decision: keep holding through a probe that could not read the source?
 *
 * Only when the last reading that actually landed was `desktop`. A desktop has no
 * battery at all, so a later `unknown` cannot mean "possibly on battery" — it can
 * only mean the probe failed, and dropping the hold would break the guarantee the
 * UI makes for desktops over a single transient CIM error.
 *
 * Every other case keeps the conservative fail-safe: `ac` is a laptop that may have
 * been unplugged, and `unknown`/`battery` carry no evidence that holding is safe.
 */
export function shouldKeepHoldingThroughFailure(
  powerSource: PowerSource,
  lastSettledSource: PowerSource,
): boolean {
  return powerSource === 'unknown' && lastSettledSource === 'desktop';
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
  /** When the last probe *attempt* finished, or `undefined` if none ever did.
   * Drives the staleness rule in `tick()`/`refreshPowerSourceIfUnknown()`: a fresh
   * reading is reused, a stale one is re-read. Set on failure too, so a doomed probe
   * cannot be retried once per request. */
  private lastProbeAt: number | undefined;
  /** The last power reading that actually landed (never set by a failed probe).
   * Distinguishes "this is a desktop, the probe just hiccuped" from "we have never
   * read this machine" — see `shouldKeepHoldingThroughFailure()`. */
  private lastSource: PowerSource = 'unknown';
  /** Set when a keeper we started exited on its own, or could not be spawned.
   *
   * Sticky for *reporting*: it stays set across retries until a keeper actually
   * confirms its hold, so the UI's "the helper could not run" does not flicker back
   * to "starting" once per retry. `keeperRetryAt` is the separate, transient half
   * that governs when the next attempt is allowed. */
  private keeperFailed = false;
  /** Consecutive failed keeper starts, and when the next attempt is allowed. */
  private keeperFailures = 0;
  private keeperRetryAt = 0;
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

  /** Injectable clock, so a test can drive probe staleness without waiting 60s. */
  private now(): number {
    return Date.now();
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
    // Bounded by the same freshness rule as `tick()`, which is what keeps this from
    // spawning a doomed PowerShell process on every call: a *failed* probe also
    // leaves the source 'unknown', so a plain `powerSource !== 'unknown'` check here
    // meant that for as long as CIM kept failing, each `GET /api/power` poll (the
    // settings page polls it every 30s) spawned another probe that could not
    // succeed. `probeSettled` identifies "the reading landed and failed" — the case
    // that must not retry on every poll — while still allowing a retry once the
    // reading is stale, so a machine whose first probe failed does recover.
    if (!this.isSupported()) return;
    if (this.lastProbeAt !== undefined && this.now() - this.lastProbeAt < PROBE_STALE_MS) return;
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
      // Remember the last reading that actually landed, separately from the current
      // one: a later failed probe overwrites `powerSource` with `unknown`, and
      // losing the fact that this is a desktop would drop a hold that is safe to
      // keep. See `shouldKeepHoldingThroughFailure()`.
      this.lastSource = this.powerSource;
    } catch (err) {
      console.error(
        '[keep-awake] power probe failed:',
        err instanceof Error ? err.message : String(err),
      );
      this.powerSource = 'unknown';
    } finally {
      // Either way the reading is settled now, so 'pending' no longer applies…
      this.probeSettled = true;
      // …and the attempt is timestamped, so a *failed* probe is not retried once per
      // request — only once the reading goes stale (see `PROBE_STALE_MS`).
      this.lastProbeAt = this.now();
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
   * Probes only while no reading has ever landed; see `tick()` for why an
   * unconditional probe here was wrong. In short, `apply()` calls this on *every*
   * `PUT /api/settings`, so probing each time parked an unrelated settings save
   * behind a PowerShell round trip (~0.5s typical, up to `QUERY_TIMEOUT_MS` when
   * PowerShell is slow or broken — the exact machine this feature promises to
   * degrade gracefully on). The 60s watchdog owns keeping the reading current; the
   * first reading is the only one a caller genuinely has to wait for.
   */
  async start(intervalMs = POWER_POLL_MS): Promise<KeepAwakeStatus> {
    this.settingEnabled = true;
    if (!this.isSupported()) {
      // Nothing to do off Windows — never spawn anything.
      return this.status();
    }
    this.intervalMs = intervalMs;
    // No argument: `tick()` itself decides whether the cached reading is stale. This
    // is the call reached from `apply()` on every settings save, so it must reuse a
    // fresh reading instead of probing again.
    await this.tick();
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
  /** Synchronous best-effort cleanup for `process.on('exit')`.
   *
   * Note the ordering: the "not a failure" reset happens only when there *was* a
   * child. An earlier revision reset it before the `if (!child) return`, which meant
   * a keeper that had already died — precisely the failed-spawn / abnormal-exit case
   * — kept its `keeperFailed` flag set through the exit sweep. */
  killChildSync(): void {
    const child = this.child;
    this.child = undefined;
    this.keeperReady = false;
    if (!child) return;
    this.clearKeeperFailure();
    try {
      child.stdin?.destroy();
      child.kill();
    } catch {
      // Process already gone — nothing left to clean up.
    }
  }

  private async tick(): Promise<void> {
    if (!this.isSupported()) return;
    // Probe only when the cached reading is actually stale.
    //
    // This one rule covers both callers, which want opposite things:
    //
    //   * the 60s watchdog must re-read, because noticing that the charger was
    //     plugged in *is* its job — its interval equals `PROBE_STALE_MS`, so every
    //     watchdog tick sees a stale reading and probes;
    //   * `start()` must NOT re-read when a fresh reading exists, because `apply()`
    //     calls it on *every* `PUT /api/settings` — re-probing there parked an
    //     unrelated settings save behind a PowerShell round trip (~0.5s typically,
    //     up to `QUERY_TIMEOUT_MS` on the slow/hung machine this feature exists to
    //     degrade gracefully on). The single-flight in `probeOnce()` does not help:
    //     in steady state nothing is in flight, so every save started a fresh probe.
    //
    // A reading that has never landed is always stale, so the first tick (and each
    // `start()` on a machine whose probe keeps failing) still waits for one.
    if (this.lastProbeAt === undefined || this.now() - this.lastProbeAt >= PROBE_STALE_MS) {
      await this.probeOnce();
    }
    const hold = shouldHold(this.powerSource, this.settingEnabled);
    // A transient probe failure must not drop a hold we know is safe. `unknown`
    // normally means "cannot establish AC vs battery", and releasing is the right
    // fail-safe — but on a machine already established as a *desktop* there is no
    // battery to protect, so `unknown` can only mean "the probe failed", and killing
    // the keeper would silently break the UI's "stays awake the whole time the switch
    // is on" promise over one CIM hiccup. A laptop last seen on `ac` is deliberately
    // NOT covered: there, `unknown` may mean the charger was pulled.
    const keepHolding = hold || shouldKeepHoldingThroughFailure(this.powerSource, this.lastSource);
    if (keepHolding && !this.child) {
      // Retry a failed keeper, but not on every tick: a machine where it can never
      // start would otherwise spawn a doomed PowerShell process every 60s forever.
      if (this.now() >= this.keeperRetryAt) this.spawnKeeper();
    } else if (!keepHolding && this.child) {
      this.killChild();
    }
    // While disabled the cached source still drives the UI wording.
  }

  /** Record a failed keeper start and schedule the next attempt with backoff. */
  private noteKeeperFailure(): void {
    this.keeperFailed = true;
    this.keeperFailures += 1;
    // 60s, 2m, 4m, 8m, then capped at 15m. One retry per watchdog tick at first, so
    // a transient failure still recovers within a minute.
    const backoff = Math.min(
      this.intervalMs * 2 ** (this.keeperFailures - 1),
      KEEPER_RETRY_MAX_BACKOFF_MS,
    );
    this.keeperRetryAt = this.now() + backoff;
  }

  /** A deliberate release or a confirmed hold: nothing is wrong, retry immediately. */
  private clearKeeperFailure(): void {
    this.keeperFailed = false;
    this.keeperFailures = 0;
    this.keeperRetryAt = 0;
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
      this.noteKeeperFailure();
      return;
    }
    this.child = child;
    this.keeperReady = false;
    // `keeperFailed` is deliberately NOT cleared here: wiping it on every attempt
    // made the reported reason flip terminal → 'starting' → terminal once per
    // retry, so a permanently broken machine never showed a stable explanation. It
    // clears when a keeper confirms its hold, or when the switch is turned off.
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
        // A confirmed hold means the environment is healthy again: drop the failure
        // state and the backoff so a later failure starts over at one retry per tick.
        this.clearKeeperFailure();
        this.onEvent('keep-awake: sleep prevention active (display still turns off)', 'info');
      }
    });
    child.on('error', (err) => {
      console.error('[keep-awake] keeper error:', err.message);
      if (this.child === child) {
        this.child = undefined;
        this.keeperReady = false;
      }
      this.noteKeeperFailure();
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
      this.noteKeeperFailure();
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
    this.clearKeeperFailure();
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
