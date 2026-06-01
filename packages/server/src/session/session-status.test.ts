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

  it('logged-out when body shows a login form even on a pban1 url', () => {
    expect(
      classifySession({
        url: 'https://horizon.mcgill.ca/pban1/twbkwbis.P_GenMenu',
        bodyText: 'please enter your mcgill username and password',
      }),
    ).toBe('logged-out');
  });
});
