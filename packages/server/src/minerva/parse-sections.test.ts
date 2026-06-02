import { describe, it, expect } from 'vitest';
import { parseSections } from './parse-sections';

// Synthetic fixture mirroring Minerva's real structure (no personal data).
const FIXTURE = `
<table class="datadisplaytable"><caption class="captiontext">Sections Found</caption>
<tr><th colspan="26" class="ddtitle">Computer Science (Sci)</th></tr>
<tr><th class="ddheader">Select</th><th class="ddheader">CRN</th><th class="ddheader">Subj</th>
<th class="ddheader">Crse</th><th class="ddheader">Sec</th><th class="ddheader">Type</th>
<th class="ddheader">Cred</th><th class="ddheader">Title</th><th class="ddheader">Days</th>
<th class="ddheader">Time</th><th class="ddheader">Cap</th><th class="ddheader">Act</th>
<th class="ddheader">Rem</th><th class="ddheader">WLCap</th><th class="ddheader">WLAct</th>
<th class="ddheader">WLRem</th><th class="ddheader">Instr</th><th class="ddheader">Date</th>
<th class="ddheader">Loc</th><th class="ddheader">Status</th></tr>
<tr>
<td class="dddefault"><abbr title="Closed">C</abbr></td>
<td class="dddefault"><a href="x">2347</a></td>
<td class="dddefault">COMP</td><td class="dddefault">551</td><td class="dddefault">001</td>
<td class="dddefault">Lecture</td><td class="dddefault">4.000</td><td class="dddefault">Applied ML</td>
<td class="dddefault">MW</td><td class="dddefault">08:35-09:55</td>
<td class="dddefault">140</td><td class="dddefault">140</td><td class="dddefault">0</td>
<td class="dddefault">28</td><td class="dddefault">28</td><td class="dddefault">0</td>
<td class="dddefault">Prof</td><td class="dddefault">08/31-12/04</td><td class="dddefault">LEA 219</td>
<td class="dddefault">Active</td>
</tr>
<tr><td class="dddefault">&nbsp;</td><td colspan="25" class="dddefault">NOTES: Waitlist section.</td></tr>
<tr><td colspan="26" class="dddefault">&nbsp;</td></tr>
<tr>
<td class="dddefault"><input type="checkbox" name="sel_crn" value="2348 202609"></td>
<td class="dddefault"><a href="x">2348</a></td>
<td class="dddefault">COMP</td><td class="dddefault">551</td><td class="dddefault">002</td>
<td class="dddefault">Lecture</td><td class="dddefault">4.000</td><td class="dddefault">Applied ML</td>
<td class="dddefault">MW</td><td class="dddefault">08:35-09:55</td>
<td class="dddefault">40</td><td class="dddefault">11</td><td class="dddefault">29</td>
<td class="dddefault">8</td><td class="dddefault">0</td><td class="dddefault">8</td>
<td class="dddefault">Prof</td><td class="dddefault">08/31-12/04</td><td class="dddefault">LEA 219</td>
<td class="dddefault">Active</td>
</tr>
</table>`;

describe('parseSections', () => {
  it('parses each section row into SectionStats keyed by CRN', () => {
    const rows = parseSections(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      crn: '2347',
      cap: 140,
      act: 140,
      rem: 0,
      wlcap: 28,
      wlact: 28,
      wlrem: 0,
    });
    expect(rows[1]).toEqual({
      crn: '2348',
      cap: 40,
      act: 11,
      rem: 29,
      wlcap: 8,
      wlact: 0,
      wlrem: 8,
    });
  });

  it('skips NOTES and spacer rows and the header row', () => {
    expect(parseSections(FIXTURE).every((r) => /^\d{4,5}$/.test(r.crn))).toBe(true);
  });

  it('returns empty array when no sections table is present', () => {
    expect(parseSections('<html><body>No classes found</body></html>')).toEqual([]);
  });
});
