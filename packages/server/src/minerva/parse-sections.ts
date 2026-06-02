import * as cheerio from 'cheerio';
import type { SectionStats } from '@autoregister/shared';

/**
 * Parse Minerva's "Sections Found" results HTML into per-CRN seat stats.
 * Pure: no IO. Robust to NOTES/spacer/header rows.
 */
export function parseSections(html: string): SectionStats[] {
  const $ = cheerio.load(html);
  const tables = $('table.datadisplaytable').toArray();
  const table =
    tables.find((t) => $(t).find('caption').text().includes('Sections Found')) ?? tables[0];
  if (!table) return [];

  const out: SectionStats[] = [];
  $(table)
    .find('tr')
    .each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 16) return; // header (th) / notes / spacer rows
      const crn = $(tds[1]).text().trim();
      if (!/^\d{4,5}$/.test(crn)) return;
      const n = (i: number) => Number.parseInt($(tds[i]).text().trim(), 10) || 0;
      out.push({
        crn,
        cap: n(10),
        act: n(11),
        rem: n(12),
        wlcap: n(13),
        wlact: n(14),
        wlrem: n(15),
      });
    });
  return out;
}
