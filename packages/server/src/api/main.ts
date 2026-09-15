import type { WebSocket } from 'ws';
import { createRuntime } from '../scheduler/runtime';
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
  // A cycle that finds the session gone is the earliest reliable evidence that
  // it is gone. Feed it back into the status the API reports, otherwise
  // `GET /api/session` keeps answering 'authenticated' while the scheduler has
  // paused every target — the UI then shows a green "Active" over a stopped
  // engine. The status change broadcasts a warn event, so the UI learns without
  // polling (which would mean really navigating to Minerva on a timer).
  runtime.scheduler.setSessionLostHandler((reason) => {
    if (app.sessions.markLoggedOut()) console.log(`Session lost: ${reason}`);
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`AutoRegister API listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
