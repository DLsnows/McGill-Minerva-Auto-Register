import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import { createRuntime } from '../scheduler/runtime';
import { broadcast, buildServer } from './server';

const PORT = Number(process.env.PORT ?? 4575);

/**
 * The synchronous last-resort keeper sweep for `process.on('exit')`.
 *
 * It MUST be given the instance that actually spawned the keeper. `process.on('exit')`
 * handlers may only run synchronous code, so the async `stop()` used by the normal close
 * and signal paths cannot be awaited there. An earlier revision had this call a
 * module-level singleton that `createRuntime()` never used, so the sweep could never
 * reach the running keeper and the child only died later via its own stdin-EOF watchdog.
 *
 * Exported (and parameterised) so the wiring itself can be asserted in a test: both the
 * "targets the real instance" and "force-kills rather than cooperatively stopping"
 * properties were exactly what regressed, and neither is observable from a test that
 * only exercises `killChildSync()` directly.
 */
export function releaseKeepAwakeOnExit(keepAwake: { killChildSync(): void }): void {
  keepAwake.killChildSync();
}

export async function main(): Promise<void> {
  const clients = new Set<WebSocket>();
  const runtime = createRuntime((event) => broadcast(clients, event));
  // On startup nothing should be polling — reset any persisted 'watching'
  // targets to 'paused' so the user starts them manually (per-course or Start all).
  const paused = runtime.store.pauseAllWatching();
  if (paused > 0) console.log(`Reset ${paused} watching target(s) to paused on startup.`);
  const app = buildServer(runtime, clients);

  // Keep-awake lifecycle: the keeper child must never outlive this process, so
  // tear it down on a normal close and on both termination signals. The `exit`
  // handler is the last-resort synchronous sweep (signal handlers are not
  // guaranteed to have finished by then).
  let shuttingDown = false;
  const releaseKeepAwake = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.keepAwake.stop();
  };
  app.addHook('onClose', async () => releaseKeepAwake());
  const onSignal = (signal: NodeJS.Signals) => {
    releaseKeepAwake();
    void app.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.on('exit', () => releaseKeepAwakeOnExit(runtime.keepAwake));

  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`AutoRegister API listening on http://127.0.0.1:${PORT}`);
}

/**
 * Whether this module is the process entry point rather than an import.
 *
 * `process.argv[1]` is the script Node was asked to run; ESM has no `require.main`
 * equivalent. Without this guard, importing the module for a test would immediately
 * start a real server on port 4575.
 */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}
