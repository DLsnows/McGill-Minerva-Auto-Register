import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import SettingsPage from './Settings';
import { api } from '../lib/api';

function mockAll() {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderSettings = () =>
  render(
    <DataProvider>
      <SettingsPage />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Settings', () => {
  it('prefills and saves general settings', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 45, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() => expect((screen.getByLabelText('Poll interval (min)') as HTMLInputElement).value).toBe('30'));
    await userEvent.clear(screen.getByLabelText('Poll interval (min)'));
    await userEvent.type(screen.getByLabelText('Poll interval (min)'), '45');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMinutes: 45 })));
  });

  it('blocks save when email notify is on but email fields are incomplete', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    await waitFor(() => screen.getByLabelText('Email notifications'));
    await userEvent.click(screen.getByLabelText('Email notifications'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/email .*required/i)).toBeInTheDocument();
  });

  it('links to the email setup guide', async () => {
    mockAll();
    renderSettings();
    await waitFor(() => screen.getByLabelText('Email notifications'));
    const link = screen.getByRole('link', { name: /setup guide/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('EMAIL_SETUP.md'));
  });
});
