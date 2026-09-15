import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Session from './Session';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';
import { installFakeWebSocket, lastFakeSocket } from '../test-setup';

function mockAll(status: 'authenticated' | 'logged-out' | 'logging-in') {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderSession = () =>
  render(
    <DataProvider>
      <Session />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Session', () => {
  it('shows the current status', async () => {
    mockAll('authenticated');
    renderSession();
    await waitFor(() => expect(screen.getByText('Authenticated')).toBeInTheDocument());
  });

  it('triggers login on button click', async () => {
    mockAll('logged-out');
    const login = vi.spyOn(api, 'login').mockResolvedValue({ started: true });
    renderSession();
    await waitFor(() => screen.getByRole('button', { name: /log in/i }));
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(login).toHaveBeenCalled();
  });

  it('disables the login button while the server reports logging-in', async () => {
    mockAll('logging-in');
    renderSession();
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
  });

  it('surfaces a login error', async () => {
    mockAll('logged-out');
    vi.spyOn(api, 'login').mockRejectedValue(new Error('login boom'));
    renderSession();
    await waitFor(() => screen.getByRole('button', { name: /log in/i }));
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    await waitFor(() => expect(screen.getByText(/login boom/i)).toBeInTheDocument());
  });

  /**
   * Q7 regression, from the page the audit called out by name: "Authenticated —
   * automation can run" stayed on screen after Minerva evicted the session,
   * because this page only ever re-read the status while `logging-in` (or after a
   * manual login click). The session is now refreshed from the event stream, so
   * the scheduler's warn line flips this page without a reload.
   */
  it('follows the session to logged-out when the server reports it was evicted', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    let calls = 0;
    const getSession = vi
      .spyOn(api, 'getSession')
      .mockImplementation(async () => ({ status: ++calls === 1 ? 'authenticated' : 'logged-out' }));
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000,
      queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });

    installFakeWebSocket();
    renderSession();
    await waitFor(() => expect(screen.getByText('Authenticated')).toBeInTheDocument());
    expect(screen.getByText('Authenticated — automation can run.')).toBeInTheDocument();

    act(() =>
      lastFakeSocket()?.emit({
        type: 'event',
        event: {
          id: 'e1',
          ts: Date.now(),
          level: 'warn',
          message: 'Session not active (logged out / evicted) — paused; please re-login',
        },
      }),
    );

    await waitFor(() => expect(screen.getByText('Logged out')).toBeInTheDocument());
    expect(screen.queryByText('Authenticated — automation can run.')).toBeNull();
    expect(getSession.mock.calls.length).toBeGreaterThan(1);
  });
});
