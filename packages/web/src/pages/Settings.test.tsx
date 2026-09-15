import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import SettingsPage from './Settings';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

const LOADED_SETTINGS = {
  pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
  notify: { desktop: true, sound: true, email: false },
};

function mockAll() {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue(LOADED_SETTINGS);
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
      pollIntervalMinutes: 45, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() => expect((screen.getByLabelText('Poll interval (min)') as HTMLInputElement).value).toBe('30'));
    await userEvent.clear(screen.getByLabelText('Poll interval (min)'));
    await userEvent.type(screen.getByLabelText('Poll interval (min)'), '45');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMinutes: 45 })));
  });

  it('still lets a min-0 field be cleared to 0 (the empty->NaN rule is scoped to pacing)', async () => {
    // Regression from scoping: the empty -> NaN coercion was briefly applied to every
    // numeric input, which broke two perfectly valid inputs. `jitterMinutes` and
    // `registerBudget` both have a server bound of `min(0)`, so clearing them is a
    // legitimate way to store 0 -- with the coercion they became NaN -> null -> a raw
    // 400 zod dump. Only the two operation-speed fields opt in.
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    const jitter = await screen.findByLabelText('Jitter (min)');
    await userEvent.clear(jitter);
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ jitterMinutes: 0 })),
    );
  });

  it('has no email / SMTP UI at all (feature temporarily sunset)', async () => {    mockAll();
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
      pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
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
      pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
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
      pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 10000, registerBudget: 20,
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

  it('prefills and saves the operation-speed settings', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    const pause = await screen.findByLabelText('Pause between operations (ms)');
    const jitter = screen.getByLabelText('Operation jitter (± ms)');
    expect((pause as HTMLInputElement).value).toBe('3000');
    expect((jitter as HTMLInputElement).value).toBe('1000');
    // The section is separate from — and worded differently from — the poll interval.
    expect(screen.getByRole('heading', { name: /operation speed/i })).toBeInTheDocument();

    await userEvent.clear(pause);
    await userEvent.type(pause, '1500');
    await userEvent.clear(jitter);
    await userEvent.type(jitter, '400');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ opPauseMs: 1500, opJitterMs: 400 })),
    );
  });

  it('refuses to save an out-of-range operation speed', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    const pause = await screen.findByLabelText('Pause between operations (ms)');
    await userEvent.clear(pause);
    await userEvent.type(pause, '100'); // below the 250ms anti-detection floor
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(put).not.toHaveBeenCalled();
    // The error bar (not just the hint) names the accepted range.
    expect(screen.getByText(/nothing was saved/i).textContent).toContain('250–60000 ms');
  });

  it('refuses to save an operation pause above the maximum', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    const pause = await screen.findByLabelText('Pause between operations (ms)');
    await userEvent.clear(pause);
    await userEvent.type(pause, '70000');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing was saved/i)).toBeInTheDocument();
  });

  it('refuses to save an emptied operation pause instead of silently storing 0', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({} as never);
    renderSettings();
    const pause = await screen.findByLabelText('Pause between operations (ms)');
    await userEvent.clear(pause);
    // `Number('')` is 0, so the naive handler made this snap back to a visible "0" the
    // moment the user cleared it — the silently-stored zero this validation exists to
    // prevent, and a contradiction of the field's own comment. The empty string now maps
    // to NaN, so the field stays empty.
    expect(pause).toHaveValue(null);
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing was saved/i).textContent).toContain('250–60000 ms');
  });
});
