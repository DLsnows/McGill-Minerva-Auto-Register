import type { CourseQuery, Decision, SectionStats } from '@autoregister/shared';
import { decide } from '@autoregister/shared';
import { MINERVA_BASE } from '../session/config';
import type { SessionManager } from '../session/session-manager';
import { humanPause } from '../util/pacing';
import { parseSections } from './parse-sections';

const TERM_SELECT_URL = `${MINERVA_BASE}/bwskfcls.p_sel_crse_search`;

export interface CourseCheck {
  stats: SectionStats;
  decision: Decision;
}

/** Drives Minerva's advanced course search and parses results. */
export class QueryClient {
  constructor(private readonly session: SessionManager) {}

  /** Run the advanced search and return all parsed sections for the query. */
  async getSections(query: CourseQuery): Promise<SectionStats[]> {
    const page = await this.session.getPage();

    // 1. Term select page → submit term (posts to p_proc_term_date).
    await humanPause();
    await page.goto(TERM_SELECT_URL, { waitUntil: 'domcontentloaded' });
    await humanPause();
    await page.selectOption('select[name="p_term"]', query.term);
    await humanPause();
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('form[action*="p_proc_term_date"] input[type="submit"]'),
    ]);

    // 2. Basic search page → pick subject, go to the Advanced Search form (P_GetCrse).
    await humanPause();
    await page.selectOption('select[name="sel_subj"]', query.subject);
    await humanPause();
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('input[name="SUB_BTN"][value="Advanced Search"]'),
    ]);

    // 3. Advanced form → subject + optional faculty + course number → Get Course Sections.
    await humanPause();
    await page.selectOption('select[name="sel_subj"]', query.subject);
    if (query.faculty) {
      await humanPause();
      await page
        .selectOption('select[name="sel_coll"]', query.faculty)
        .catch((e: unknown) =>
          console.warn(
            'faculty (sel_coll) not applied, continuing:',
            e instanceof Error ? e.message : e,
          ),
        );
    }
    await humanPause();
    await page.fill('input[name="sel_crse"]', query.courseNumber);
    await humanPause();
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('input[name="SUB_BTN"][value="Get Course Sections"]'),
    ]);

    // 4. Parse the results page (P_GetCrse_Advanced). Soft-wait for the table
    // (don't throw on a legitimate no-results page).
    await page.waitForSelector('table.datadisplaytable', { timeout: 8000 }).catch(() => undefined);
    return parseSections(await page.content());
  }

  /** Find the target CRN's stats and run the decision engine. Null if not found. */
  async checkCourse(query: CourseQuery): Promise<CourseCheck | null> {
    const sections = await this.getSections(query);
    const stats = sections.find((s) => s.crn === query.targetCrn);
    if (!stats) return null;
    return { stats, decision: decide(stats) };
  }
}
