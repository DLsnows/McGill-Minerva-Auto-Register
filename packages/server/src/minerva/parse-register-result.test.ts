import { describe, it, expect } from 'vitest';
import { parseRegisterResult } from './parse-register-result';

const sched = (crn: string, status: string) => `
<table class="datadisplaytable" summary="Current Schedule">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
<tr><td class="dddefault">${status}</td>
<td class="dddefault"><select name="RSTS_IN"><option value="">None</option><option value="DW">Web Drop</option></select></td>
<td class="dddefault">${crn}</td></tr>
</table>`;

const err = (crn: string, status: string, withLW: boolean) => `
<table class="datadisplaytable" summary="This table is used to present Registration Errors.">
<tr><th class="ddheader">Status</th><th class="ddheader">Action</th><th class="ddheader">CRN</th></tr>
<tr><td class="dddefault"><a href="x">${status}</a></td>
<td class="dddefault">${
  withLW
    ? '<select name="RSTS_IN"><option value="">None</option><option value="LW">(Add(ed) to Waitlist)</option></select>'
    : '&nbsp;'
}</td>
<td class="dddefault">${crn}</td></tr>
</table>`;

describe('parseRegisterResult', () => {
  it('registered when CRN is in Current Schedule as Web Registered', () => {
    expect(parseRegisterResult(sched('1788', 'Web Registered on May 28, 2026'), '1788').kind).toBe(
      'registered',
    );
  });

  it('waitlisted when CRN in Current Schedule shows a waitlist status', () => {
    expect(parseRegisterResult(sched('1814', 'Waitlist on Jun 01, 2026'), '1814').kind).toBe(
      'waitlisted',
    );
  });

  it('waitlist-available on Open-Space Reserved for Waitlist with an LW action', () => {
    expect(
      parseRegisterResult(err('1814', 'Open-Space(s) Reserved for Waitlist', true), '1814').kind,
    ).toBe('waitlist-available');
  });

  it('waitlist-full on Closed - Waitlist Full', () => {
    expect(parseRegisterResult(err('2347', 'Closed - Waitlist Full', false), '2347').kind).toBe(
      'waitlist-full',
    );
  });

  it('closed on Closed - Class Full', () => {
    expect(parseRegisterResult(err('2347', 'Closed - Class Full', false), '2347').kind).toBe(
      'closed',
    );
  });

  it('error on an unknown registration error, capturing the message', () => {
    const r = parseRegisterResult(err('9999', 'Maximum Hours Exceeded', false), '9999');
    expect(r.kind).toBe('error');
    expect(r.message).toContain('Maximum Hours');
  });

  it('not-found when the CRN is absent', () => {
    expect(parseRegisterResult(sched('1788', 'Web Registered'), '5555').kind).toBe('not-found');
  });
});
