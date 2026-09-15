import type { WebSocket } from 'ws';
import { createRuntime } from '../scheduler/runtime';
import { killKeepAwakeSync } from '../system/keep-awake';
import { broadcast, buildServer } from './server';

const PORT = Number(process.env.PORT ?? 4575);

async function main() {
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
  process.on('exit', () => killKeepAwakeSync());

  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`AutoRegister API listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
