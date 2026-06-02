import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Session from './Session';
import { api } from '../lib/api';

function mockAll(status: 'authenticated' | 'logged-out') {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
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
    await waitFor(() => expect(screen.getByText('authenticated')).toBeInTheDocument());
  });

  it('triggers login on button click', async () => {
    mockAll('logged-out');
    const login = vi.spyOn(api, 'login').mockResolvedValue({ started: true });
    renderSession();
    await waitFor(() => screen.getByRole('button', { name: /log in/i }));
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(login).toHaveBeenCalled();
  });

  it('surfaces a login error', async () => {
    mockAll('logged-out');
    vi.spyOn(api, 'login').mockRejectedValue(new Error('login boom'));
    renderSession();
    await waitFor(() => screen.getByRole('button', { name: /log in/i }));
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    await waitFor(() => expect(screen.getByText(/login boom/i)).toBeInTheDocument());
  });
});
