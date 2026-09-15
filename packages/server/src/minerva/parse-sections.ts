import * as cheerio from 'cheerio';
import { PageStructureError, type SectionStats } from '@autoregister/shared';

/** Header labels the section parser must find to produce trustworthy numbers. */
const REQUIRED = ['CRN', 'Cap', 'Act', 'Rem', 'WL Cap', 'WL Act', 'WL Rem'] as const;

/**
 * True when a table's markup unmistakably IS a course-sections table — a CRN
 * header plus seat columns — even though its caption is not the one we expect.
 * Used to tell "Minerva renamed the caption" (a page we do not understand) from
 * "this page has no results".
 */
function looksLikeSectionsTable(tableHtml: string): boolean {
  const $ = cheerio.load(tableHtml);
  const labels: string[] = [];
  $('tr')
    .filter((_, tr) => $(tr).find('th.ddheader').length > 0)
    .first()
    .find('th')
    .each((_, th) => {
      labels.push($(th).text().trim().toLowerCase().replace(/\s+/g, ' '));
    });
  return labels.includes('crn') && labels.some((l) => ['cap', 'act', 'rem'].includes(l));
}

/**
 * Parse Minerva's "Sections Found" results HTML into per-CRN seat stats.
 * Pure: no IO. Columns are located by HEADER LABEL (not fixed positions), so the
 * parser is robust to Minerva adding/removing/reordering columns. Header/NOTES/
 * spacer rows are skipped.
 *
 * "This page has no results" and "we do not understand this page" are DIFFERENT
 * answers (audit Q22) and are never conflated:
 * - the results page legitimately reports nothing → `[]`;
 * - a course-sections table is present but unreadable (caption renamed, a
 *   required column renamed/removed) → throws {@link PageStructureError}.
 * The caller turns the first into "this CRN is not in the results" and the
 * second into a page-structure error that does NOT count as a bad CRN.
 */
export function parseSections(html: string): SectionStats[] {
  const $ = cheerio.load(html);
  const tables = $('table.datadisplaytable').toArray();
  // Require the "Sections Found" caption — do NOT fall back to an arbitrary
  // table, which could misparse wrong seat numbers into a real decision.
  const table = tables.find((t) => $(t).find('caption').text().includes('Sections Found'));
  if (!table) {
    // Caption drift: the table is plainly a sections table, we just failed to
    // recognize it. That is a page-structure problem, not an empty result.
    if (tables.some((t) => looksLikeSectionsTable($.html(t)))) {
      throw new PageStructureError(
        'a course-sections table is present but its caption does not read "Sections Found"',
      );
    }
    return []; // no results table on the page at all → genuinely nothing found
  }
  const $table = $(table);

  // Map header label (lowercased, single-spaced) -> column index.
  const idx: Record<string, number> = {};
  $table
    .find('tr')
    .filter((_, tr) => $(tr).find('th.ddheader').length > 0)
    .first()
    .find('th')
    .each((i, th) => {
      const key = $(th).text().trim().toLowerCase().replace(/\s+/g, ' ');
      if (key) idx[key] = i;
    });
  const col = (...names: string[]): number =>
    names.map((n) => idx[n]).find((v) => v !== undefined) ?? -1;
  const cols = {
    crn: col('crn'),
    cap: col('cap'),
    act: col('act'),
    rem: col('rem'),
    wlcap: col('wl cap', 'wlcap'),
    wlact: col('wl act', 'wlact'),
    wlrem: col('wl rem', 'wlrem'),
  };
  const colValues = Object.values(cols);
  if (colValues.some((c) => c < 0)) {
    // The table is there, we just cannot read it: name the missing columns so a
    // Minerva change is diagnosable instead of looking like a bad CRN.
    const missing = REQUIRED.filter((_, i) => colValues[i] < 0);
    throw new PageStructureError(
      `the "Sections Found" table header is not recognized (missing column(s): ${missing.join(', ')})`,
    );
  }
  const maxCol = Math.max(...colValues);

  const out: SectionStats[] = [];
  $table.find('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length <= maxCol) return; // header(th)/NOTES/spacer rows
    const crn = $(tds[cols.crn]).text().trim();
    if (!/^\d{4,5}$/.test(crn)) return;
    const n = (i: number) => Number.parseInt($(tds[i]).text().trim(), 10) || 0;
    out.push({
      crn,
      cap: n(cols.cap),
      act: n(cols.act),
      rem: n(cols.rem),
      wlcap: n(cols.wlcap),
      wlact: n(cols.wlact),
      wlrem: n(cols.wlrem),
    });
  });
  return out;
}
