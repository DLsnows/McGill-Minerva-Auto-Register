import type { ActionKind } from '@autoregister/shared';
import { SessionManager } from '../session/session-manager';
import { closeSession } from '../util/close-session';
import { RegisterClient } from './register-client';

/**
 * Manual verification (GUARDED — dry run unless --confirm):
 *   npm run register -w @autoregister/server -- <term> <crn> <REGISTER|WAITLIST> [--confirm]
 *
 * Without --confirm it only prints what it WOULD do. With --confirm it actually
 * submits to Minerva (this can enroll/waitlist you). Single-session: do not log
 * in elsewhere while this runs.
 */
async function main() {
  const [term, crn, actionArg] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');
  const action = actionArg as ActionKind;
  if (!term || !crn || (action !== 'REGISTER' && action !== 'WAITLIST')) {
    console.error('Usage: register -- <term> <crn> <REGISTER|WAITLIST> [--confirm]');
    process.exit(1);
  }
  if (!confirm) {
    console.log(
      `DRY RUN — would ${action} CRN ${crn} in term ${term}. Re-run with --confirm to actually submit.`,
    );
    process.exit(0);
  }

  const session = new SessionManager();
  await session.launch();
  await session.ensureLoggedIn(() => {
    console.log('\n>>> Log in to Minerva (Duo if prompted) in the opened window...\n');
  });

  const client = new RegisterClient(session);
  console.log(`Submitting ${action} for CRN ${crn} (term ${term})...`);
  const outcome = await client.act(term, crn, action);
  console.log('Outcome:', JSON.stringify(outcome, null, 2));

  await closeSession(session);
  process.exit(0);
}

main().catch((e) => {
  console.error('Register script failed:', e);
  process.exit(1);
});
