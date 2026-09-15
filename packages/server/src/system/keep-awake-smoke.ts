/**
 * Manual, opt-in smoke test for the Windows keep-awake switch.
 *
 *   npm run keep-awake:smoke -w @autoregister/server
 *
 * This is the ONE place that deliberately drives the real thing: it spawns a
 * real keeper child process and reads the real power source, then reports what
 * each step observed and proves that the keeper is gone afterwards. The unit
 * tests never touch PowerShell (they inject a fake spawn / power provider).
 *
 * Exits non-zero if a keeper process is still alive when the script ends.
 */
import { execFileSync } from 'node:child_process';
import { createKeepAwake, KEEPER_SCRIPT } from './keep-awake';

const PS = 'powershell.exe';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is a given pid alive right now? The keeper pid is exact, so this answers
 * "is the child process we spawned still running?" without any command-line
 * matching — which would always also match this probe itself. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const out = execFileSync(
    PS,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
    ],
    { encoding: 'utf8' },
  ).trim();
  return out === 'alive';
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(34)}${String(value)}`);
}

async function main(): Promise<number> {
  console.log('1. platform / script sanity');
  line('process.platform', process.platform);
  line(
    'keeper ES_CONTINUOUS is 2147483648',
    KEEPER_SCRIPT.includes('[uint32]$ES_CONTINUOUS = 2147483648') ? 'yes' : 'no',
  );
  line(
    'keeper requests ES_DISPLAY_REQUIRED',
    KEEPER_SCRIPT.includes('ES_DISPLAY_REQUIRED') ? 'yes' : 'no',
  );
  line('keeper mentions powercfg', KEEPER_SCRIPT.includes('powercfg') ? 'yes' : 'no');

  const events: string[] = [];
  const manager = createKeepAwake({ onEvent: (message) => events.push(message) });

  console.log('\n2. real power-source probe (Get-CimInstance Win32_Battery)');
  const t0 = Date.now();
  // The probe is async now (it used to block the whole event loop); awaiting it here is
  // what makes this a real measurement rather than a read of the empty cache.
  await manager.refreshPowerSource();
  line('getPowerSource()', `${manager.getPowerSource()} (${Date.now() - t0} ms)`);
  line('status()', JSON.stringify(manager.status()));
  line('isSupported()', manager.isSupported());

  if (!manager.isSupported()) {
    console.log('\nNot Windows — the switch is a no-op here. Nothing further to check.');
    return 0;
  }

  console.log('\n3. start() → keeper child process');
  line('keeperPid before start()', String(manager.keeperPid));
  const started = await manager.start();
  const keeperPid = manager.keeperPid;
  line('status() after start()', JSON.stringify(started));
  line('keeperPid', String(keeperPid));
  await sleep(2500);
  line('keeper alive 2.5s later', isAlive(keeperPid) ? 'yes' : 'no');

  console.log('\n4. stop() → keeper child is cleaned up');
  manager.stop();
  line('keeperPid after stop()', String(manager.keeperPid));
  await sleep(3000);
  line('keeper alive 3s after stop()', isAlive(keeperPid) ? 'yes' : 'no');
  line('status() after stop()', JSON.stringify(manager.status()));

  console.log('\n5. battery gating (injected "battery" source)');
  const laptop = createKeepAwake({ getPowerSource: () => 'battery' });
  line('start() on battery', JSON.stringify(await laptop.start()));
  line('keeperPid while on battery', String(laptop.keeperPid));
  laptop.stop();

  console.log('\n6. non-Windows platform (injected) never spawns');
  const other = createKeepAwake({ platform: 'linux' });
  line('start() on linux', JSON.stringify(await other.start()));
  line('keeperPid on linux', String(other.keeperPid));
  other.stop();

  console.log('\n7. console events emitted');
  for (const event of events) line('event', event);

  const leaked = isAlive(keeperPid);
  console.log(
    `\n${leaked ? 'FAIL' : 'OK'} — spawned keeper ${String(keeperPid)} was cleaned up: ${!leaked}`,
  );
  return leaked ? 1 : 0;
}

process.exitCode = await main().catch((err: unknown) => {
  console.error('smoke test failed:', err);
  return 1;
});
