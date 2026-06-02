import * as cheerio from 'cheerio';
import type { SectionStats } from '@autoregister/shared';

/**
 * Parse Minerva's "Sections Found" results HTML into per-CRN seat stats.
 * Pure: no IO. Columns are located by HEADER LABEL (not fixed positions), so the
 * parser is robust to Minerva adding/removing/reordering columns. Header/NOTES/
 * spacer rows are skipped.
 */
export function parseSections(html: string): SectionStats[] {
  const $ = cheerio.load(html);
  const tables = $('table.datadisplaytable').toArray();
  // Require the "Sections Found" caption — do NOT fall back to an arbitrary
  // table, which could misparse wrong seat numbers into a real decision.
  const table = tables.find((t) => $(t).find('caption').text().includes('Sections Found'));
  if (!table) return [];
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
  if (colValues.some((c) => c < 0)) return []; // header not recognized
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
