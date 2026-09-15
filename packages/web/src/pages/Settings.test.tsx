import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import SettingsPage from './Settings';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

const LOADED_SETTINGS = {
  pollIntervalMinutes: 30,
  jitterMinutes: 3,
  queryBudget: 100,
  registerBudget: 20,
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
      pollIntervalMinutes: 45,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderSettings();
    await waitFor(() =>
      expect((screen.getByLabelText('Poll interval (min)') as HTMLInputElement).value).toBe('30'),
    );
    await userEvent.clear(screen.getByLabelText('Poll interval (min)'));
    await userEvent.type(screen.getByLabelText('Poll interval (min)'), '45');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMinutes: 45 })),
    );
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
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
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
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
      dryRun: true,
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByLabelText('Dry-run mode'));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true })),
    );
  });
  it('refreshes the budget snapshot too after a save (the stale-remaining bug)', async () => {
    mockAll();
    const getBudget = vi.spyOn(api, 'getBudget');
    vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 10000,
      registerBudget: 20,
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
    vi.spyOn(api, 'getBudget').mockImplementation(() =>
      budgetCalls.n++ === 0 ? Promise.resolve(ZERO_BUDGET) : boom(),
    );
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
    // Exactly one bar: this page reports the `settings` half, nothing reports the
    // `budget` half (this page has no budget UI at all).
    expect(screen.getAllByText(/refresh boom/i)).toHaveLength(1);
  });

  /**
   * Ownership boundary: `budget` feeds the ticker, so the *shell* owns the raw
   * budget error bar. When only the budget half of the post-save refresh fails,
   * this page must not repeat that message — but it must still say something,
   * because the PUT did land and the ticker is now pairing the new limit with a
   * stale snapshot. Silence here would make a successful save indistinguishable
   * from a save that never happened.
   *
   * The note is keyed to `budget.revision`, never to `settings.revision`: in this
   * branch the *settings* re-read succeeded, so a settings-keyed note is retired
   * by the very render that set it and never appears (review catch). The positive
   * assertion below is what pins that down — asserting only the *absence* of the
   * other two strings is exactly how the bug slipped through.
   */
  it('does not repeat a budget-only refresh failure, but still does not claim success', async () => {
    mockAll();
    vi.spyOn(api, 'putSettings').mockResolvedValue(LOADED_SETTINGS);
    const budgetCalls = { n: 0 };
    vi.spyOn(api, 'getBudget').mockImplementation(() =>
      budgetCalls.n++ === 0
        ? Promise.resolve(ZERO_BUDGET)
        : Promise.reject(new Error('budget refresh boom')),
    );
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));

    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(budgetCalls.n).toBeGreaterThan(1));
    expect(screen.queryByText('Saved ✓')).toBeNull();
    // Not the raw budget error (that belongs to the shell's bar), not the
    // settings-refresh message …
    expect(screen.queryByText(/budget refresh boom/i)).toBeNull();
    expect(screen.queryByText(/were saved, but re-reading them failed/i)).toBeNull();
    // … but a save-specific note that is actually on screen, and stays there.
    expect(screen.getByText(/budget snapshot is stale/i)).toBeInTheDocument();

    // A second save re-arms the note rather than letting it lapse silently.
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(budgetCalls.n).toBeGreaterThan(2));
    expect(screen.getByText(/budget snapshot is stale/i)).toBeInTheDocument();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  /**
   * Two overlapping saves would each run their own PUT + refetch pair, and the
   * older continuation's `setSaved(false)` — its read is inevitably superseded by
   * the newer save's — would wipe the "Saved ✓" the newer one had just earned,
   * leaving a persisted save with neither confirmation nor error. The in-flight
   * guard (mirroring `onToggleScheduler`'s `schedBusyRef`) makes the overlap
   * impossible, which this pins.
   *
   * The second click is dispatched through the React handler directly: the button
   * is `disabled` while saving, so `userEvent.click` would be a no-op and the test
   * would pass even with the guard removed. Reading the props off the fiber is the
   * only way to reach the handler with a stale snapshot — the same trick
   * `Dashboard.test.tsx` uses for its disabled control.
   */
  const reachableOnClick = (el: Element): unknown => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    if (!key) throw new Error('no React props found on the element');
    return (el as unknown as Record<string, { onClick?: unknown }>)[key]?.onClick;
  };

  it('ignores a second save while one is in flight, instead of clobbering the flag', async () => {
    mockAll();
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue(LOADED_SETTINGS);
    // The save's re-reads are held, so the second click really does arrive while
    // the first save is still in flight.
    const pending: Array<(v: Awaited<ReturnType<typeof api.getSettings>>) => void> = [];
    let calls = 0;
    vi.spyOn(api, 'getSettings').mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(LOADED_SETTINGS);
      return new Promise((resolve) => pending.push(resolve));
    });
    renderSettings();
    await waitFor(() => screen.getByLabelText('Poll interval (min)'));

    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const button = screen.getByRole('button', { name: /save settings/i });
    expect(button).toBeDisabled();

    // Invoke the handler anyway: only one PUT and one re-read pair may exist.
    const onClick = reachableOnClick(button);
    expect(typeof onClick).toBe('function');
    await act(async () => {
      (onClick as () => void)();
      await Promise.resolve();
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(pending.length).toBeLessThanOrEqual(1);

    // Let the single save finish: confirmed, with the flag intact.
    await act(async () => {
      pending[0](LOADED_SETTINGS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('Saved ✓')).toBeInTheDocument());
    expect(screen.queryByText(/were saved, but re-reading them failed/i)).toBeNull();
  });

  /**
   * Q13 variant A. `form` is seeded from `settings.data`, so when the initial
   * `GET /api/settings` failed the page rendered `if (!form) → "Loading
   * settings…"` forever: no error, no retry, and — because `useResource` never
   * re-runs its mount effect — no way out for the rest of the SPA session short
   * of a full page reload.
   *
   * The page itself does not render the error bar: the shell owns `settings`
   * (see App.tsx), so the message and the retry live there on every route.
   * Rendering on its own, as here, the page must still not claim to be loading.
   */
  it('does not sit on "Loading settings…" forever when the initial GET fails', async () => {
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockImplementation(() =>
      calls++ === 0
        ? Promise.reject(new Error('GET /api/settings failed: 500'))
        : Promise.resolve(LOADED_SETTINGS),
    );
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText(/Settings could not be loaded/i)).toBeInTheDocument(),
    );
    // The permanent spinner is exactly what the defect looked like.
    expect(screen.queryByText(/Loading settings/i)).toBeNull();
    expect(screen.queryByLabelText('Poll interval (min)')).toBeNull();
    // The hint points at the shell's bar, which is where the retry lives.
    expect(screen.getByText(/Retry in the bar above the ticker/i)).toBeInTheDocument();
  });
});
