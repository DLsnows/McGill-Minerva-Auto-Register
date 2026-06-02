import { decide } from '@autoregister/shared';
import { SessionManager } from '../session/session-manager';
import { closeSession } from '../util/close-session';
import { QueryClient } from './query-client';

/**
 * Manual verification (logs in if needed, then queries — all in one session):
 *   npm run query -w @autoregister/server -- <term> <subject> <courseNumber> <targetCrn> [faculty]
 * e.g. npm run query -w @autoregister/server -- 202609 COMP 551 2348
 *
 * NOTE: Minerva enforces a single active session. Do not log into Minerva
 * elsewhere while this runs, or this session will be evicted.
 */
async function main() {
  const [term, subject, courseNumber, targetCrn, faculty] = process.argv.slice(2);
  if (!term || !subject || !courseNumber || !targetCrn) {
    console.error('Usage: query -- <term> <subject> <courseNumber> <targetCrn> [faculty]');
    process.exit(1);
  }
  const session = new SessionManager();
  await session.launch();
  await session.ensureLoggedIn(() => {
    console.log('\n>>> Not logged in (or session evicted). Please log in to Minerva');
    console.log('>>> (complete Duo 2FA if prompted) in the opened window...\n');
  });

  const client = new QueryClient(session);
  const sections = await client.getSections({ term, subject, courseNumber, targetCrn, faculty });
  console.log('Parsed sections:', JSON.stringify(sections, null, 2));
  const stats = sections.find((s) => s.crn === targetCrn);
  console.log(
    'Target check:',
    stats ? JSON.stringify({ stats, decision: decide(stats) }, null, 2) : `CRN ${targetCrn} not found`,
  );

  await closeSession(session);
  process.exit(0);
}

main().catch((e) => {
  console.error('Query script failed:', e);
  process.exit(1);
});
