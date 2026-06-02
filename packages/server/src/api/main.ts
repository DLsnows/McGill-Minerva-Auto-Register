import type { WebSocket } from 'ws';
import { createRuntime } from '../scheduler/runtime';
import { broadcast, buildServer } from './server';

const PORT = Number(process.env.PORT ?? 4575);

async function main() {
  const clients = new Set<WebSocket>();
  const runtime = createRuntime((event) => broadcast(clients, event));
  const app = buildServer(runtime, clients);
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`AutoRegister API listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
