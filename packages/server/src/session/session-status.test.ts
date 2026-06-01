import { describe, it, expect } from 'vitest';
import { classifySession } from './session-status';

describe('classifySession', () => {
  it('authenticated when on a pban1 page with course content', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/bwskfreg.P_AltPin',
        bodyText: 'quick add or drop course sections current schedule',
      }),
    ).toBe('authenticated');
  });

  it('logged-out when redirected to a login endpoint', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/twbkwbis.P_WWWLogin',
        bodyText: 'user id pin login',
      }),
    ).toBe('logged-out');
  });

  it('logged-out when redirected off-domain to SSO', () => {
    expect(
      classifySession({
        url: 'https://login.microsoftonline.com/common/oauth2/authorize',
        bodyText: 'sign in',
      }),
    ).toBe('logged-out');
  });

  it('authenticated on a pban1 url even if body has incidental login-ish text (url wins)', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/twbkwbis.P_GenMenu',
        bodyText: 'sign in as a different user',
      }),
    ).toBe('authenticated');
  });

  it('logged-out on a non-pban1 page detected via body markers', () => {
    expect(
      classifySession({
        url: 'https://sso.mcgill.ca/landing',
        bodyText: 'please enter your username and password',
      }),
    ).toBe('logged-out');
  });
});
