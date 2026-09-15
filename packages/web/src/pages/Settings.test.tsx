import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import SettingsPage from './Settings';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

const LOADED_SETTINGS = {
  pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
  notify: { desktop: true, sound: true, email: false },
};

function mockAll() {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue(LOADED_SETTINGS);
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
  vi.spyOn(api, 'getPower').mockResolvedValue({
    supported: false, enabled: false, active: false, powerSource: 'unknown', reason: 'unsupported',
  });
}

/** The Windows keep-awake controller is available and reports `reason`. */
function mockPower(reason: 'active' | 'battery' | 'disabled' | 'unavailable' = 'disabled') {
  return vi.spyOn(api, 'getPower').mockResolvedValue({
    supported: true,
    enabled: reason === 'active',
    active: reason === 'active',
    powerSource: reason === 'battery' ? 'battery' : 'ac',
    reason,
  });
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

  it('has no email / SMTP UI at all (feature temporarily sunset)', async () => {
    mockAll();
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));
    // The toggle, the section heading and every SMTP input are gone.
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/smtp/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /setup guide/i })).not.toBeInTheDocument();
    // No stray label/text mentions it either.
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/smtp/i)).not.toBeInTheDocument();
    // The channels that stay are still rendered.
    expect(screen.getByLabelText('Desktop notifications')).toBeInTheDocument();
    expect(screen.getByLabelText('Sound')).toBeInTheDocument();
  });

  it('saves the notify channels with email forced off', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: false, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Desktop notifications'));
    await userEvent.click(screen.getByLabelText('Desktop notifications'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        expect.objectContaining({ notify: { desktop: false, sound: true, email: false } }),
      ),
    );
  });

  it('surfaces a save error', async () => {
    mockAll();
    vi.spyOn(api, 'putSettings').mockRejectedValue(new Error('save boom'));
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(screen.getByText(/save boom/i)).toBeInTheDocument());
  });

  it('saves the dry-run toggle', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false }, dryRun: true,
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true })));
  });
  it('refreshes the budget snapshot too after a save (the stale-remaining bug)', async () => {
    mockAll();
    const getBudget = vi.spyOn(api, 'getBudget');
    vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 10000, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));
    const before = getBudget.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    // Saving the daily limits must re-read the budget: without this the shell
    // pairs the new limit with the previous snapshot's used-count.
    await waitFor(() => expect(getBudget.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByText('Saved ✓')).toBeInTheDocument());
  });

  it('surfaces an error and does not claim success when the post-save refresh fails', async () => {
    mockAll();
    vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    // The mount fetches succeed; both post-save refetches fail.
    const boom = () => Promise.reject(new Error('refresh boom'));
    const budgetCalls = { n: 0 };
    const settingsCalls = { n: 0 };
    vi.spyOn(api, 'getBudget').mockImplementation(() => (budgetCalls.n++ === 0 ? Promise.resolve(ZERO_BUDGET) : boom()));
    vi.spyOn(api, 'getSettings').mockImplementation(() =>
      settingsCalls.n++ === 0 ? Promise.resolve(LOADED_SETTINGS) : boom(),
    );
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));

    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(budgetCalls.n).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByText(/refresh boom/i)).toBeInTheDocument());
    expect(screen.queryByText('Saved ✓')).toBeNull();
    // The PUT resolved before the refetches ran, so the settings *were* persisted.
    // Reporting this as a save failure would tell the user the opposite of the truth.
    expect(screen.getByText(/were saved, but re-reading them failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to save settings/i)).toBeNull();
  });
});

describe('Settings — keep-awake (Windows only)', () => {
  it('renders nothing at all when the platform is not supported', async () => {
    mockAll(); // getPower → supported: false
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));
    // Wait for the power probe to have settled before asserting absence.
    await waitFor(() => expect(api.getPower).toHaveBeenCalled());
    expect(screen.queryByLabelText('Keep this PC awake')).not.toBeInTheDocument();
    expect(screen.queryByText('Power (Windows)')).not.toBeInTheDocument();
    expect(screen.queryByTestId('keep-awake-status')).not.toBeInTheDocument();
  });

  it('renders the switch plus the full explanation when supported', async () => {
    mockAll();
    mockPower('disabled');
    renderSettings();
    await waitFor(() => screen.getByLabelText('Keep this PC awake'));

    expect(screen.getByText('Power (Windows)')).toBeInTheDocument();
    // The four things the user asked to be told clearly:
    expect(screen.getByText(/will not go to sleep while the switch is on/i)).toBeInTheDocument();
    expect(screen.getByText(/display still turns off normally/i)).toBeInTheDocument();
    expect(screen.getByText(/only applies while the charger is connected/i)).toBeInTheDocument();
    expect(screen.getByText(/on battery the PC still sleeps/i)).toBeInTheDocument();
    expect(screen.getByText(/normal power behaviour resumes immediately/i)).toBeInTheDocument();
  });

  it('shows the live status reported by GET /api/power', async () => {
    mockAll();
    mockPower('active');
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('keep-awake-status')).toHaveTextContent(/Active — the PC will not sleep/i));
  });

  it('shows the waiting-for-AC status on battery', async () => {
    mockAll();
    mockPower('battery');
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('keep-awake-status')).toHaveTextContent(/Waiting for AC power/i),
    );
  });

  it('saves the switch and refreshes the live status', async () => {
    mockAll();
    const power = mockPower('disabled');
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false }, keepAwake: true,
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Keep this PC awake'));
    await userEvent.click(screen.getByLabelText('Keep this PC awake'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ keepAwake: true })));
    // Initial load + post-save refresh.
    await waitFor(() => expect(power).toHaveBeenCalledTimes(2));
  });

  it('polls the status so a mid-session power change is reflected', async () => {
    mockAll();
    const power = mockPower('disabled');
    // Fake timers must be installed BEFORE render: the interval is created on
    // whatever clock exists at mount time (same pattern as Session.poll.test).
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderSettings();
      });
      expect(power).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('keep-awake-status')).toHaveTextContent(/^Status: Off$/);

      // The server releases the hold when a laptop switches to battery; the open
      // settings page must not keep claiming it is active.
      power.mockResolvedValue({
        supported: true, enabled: true, active: false, powerSource: 'battery', reason: 'battery',
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(power.mock.calls.length).toBeGreaterThan(1);
      expect(screen.getByTestId('keep-awake-status')).toHaveTextContent(/Waiting for AC power/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
