import { SessionManager } from './session-manager';
import { closeSession } from '../util/close-session';

/**
 * Run with: npm run session:login -w @autoregister/server
 * Launches the persistent browser; if not logged in, waits for the user to
 * complete Duo manually, then confirms and persists the session.
 */
async function main() {
  const session = new SessionManager();
  await session.launch();
  console.log('Browser launched. Checking session...');

  await session.ensureLoggedIn(() => {
    console.log('\n>>> Please log in to Minerva (incl. Duo 2FA) in the opened window.');
    console.log('>>> Waiting for login to complete (up to 5 minutes)...\n');
  });

  console.log('✓ Logged in. Session cookies are saved in the persistent profile.');
  console.log('You can close the browser window. Re-running will reuse this session.');
  await closeSession(session);
  process.exit(0);
}

main().catch((err) => {
  console.error('Login script failed:', err);
  process.exit(1);
});
