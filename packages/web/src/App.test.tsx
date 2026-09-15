import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DataProvider } from './lib/DataContext';
import { ZERO_BUDGET } from './lib/budget-fixture';
import { api } from './lib/api';
import App from './App';

const LOADED_SETTINGS: Awaited<ReturnType<typeof api.getSettings>> = {
  pollIntervalMinutes: 30,
  jitterMinutes: 3,
  opPauseMs: 3000,
  opJitterMs: 1000,
  queryBudget: 100,
  registerBudget: 20,
  notify: { desktop: true, sound: true, email: false },
};

/** Fails the first call, then serves `ok` — models one transient 5xx followed by
 * a successful retry. Counts calls so the test can prove `refetch` really
 * re-ran the fetch instead of the component merely re-rendering. */
function failingOnceThen<T>(ok: T, failure: Error): () => Promise<T> {
  let calls = 0;
  return () => (calls++ === 0 ? Promise.reject(failure) : Promise.resolve(ok));
}

function mockShell(
  overrides: {
    settings?: Awaited<ReturnType<typeof api.getSettings>>;
    budget?: typeof ZERO_BUDGET;
    getSettings?: () => Promise<Awaited<ReturnType<typeof api.getSettings>>>;
    getBudget?: () => Promise<typeof ZERO_BUDGET>;
    getTargets?: () => Promise<Awaited<ReturnType<typeof api.getTargets>>>;
  } = {},
) {
  vi.spyOn(api, 'getTargets').mockImplementation(
    overrides.getTargets ?? (() => Promise.resolve([])),
  );
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockImplementation(
    overrides.getBudget ?? (() => Promise.resolve(overrides.budget ?? ZERO_BUDGET)),
  );
  vi.spyOn(api, 'getSettings').mockImplementation(
    overrides.getSettings ?? (() => Promise.resolve(overrides.settings ?? LOADED_SETTINGS)),
  );
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <DataProvider>
        <App />
      </DataProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('App shell', () => {
  it('shows a placeholder until the budget snapshot arrives instead of a hard-coded default', async () => {
    mockShell();
    renderApp();
    // Rendered before the mocked fetches resolve → no invented "0 / 100". The
    // watched-count and interval cells are unresolved too (targets and settings
    // have not landed either), so they show the placeholder as well — a "0" there
    // would claim "nothing is watched" and a "30" would invent a poll cadence.
    expect(screen.getAllByText('— / —')).toHaveLength(4);
    await waitFor(() => expect(screen.getByText('0 / 100')).toBeInTheDocument());
    expect(screen.getByText('0 / 20')).toBeInTheDocument();
    // Both budget cells resolved into real numbers.
    expect(screen.getByTestId('ticker-query')).toHaveTextContent('0 / 100');
    expect(screen.getByTestId('ticker-register')).toHaveTextContent('0 / 20');
  });

  /**
   * Regression for the reported bug: with a low limit (1000) already partly
   * spent, raising the limit to 10000 rendered "9000 / 1000" because the shell
   * subtracted a stale "remaining" count from the *new* limit and never
   * re-read the budget after a settings save.
   */
  it('renders the new limit together with the new used-count right after saving updated budgets', async () => {
    mockShell({
      settings: {
        pollIntervalMinutes: 30,
        jitterMinutes: 3,
        opPauseMs: 3000,
        opJitterMs: 1000,
        queryBudget: 1000,
        registerBudget: 20,
        notify: { desktop: true, sound: true, email: false },
      },
      budget: {
        query: { used: 900, limit: 1000, remaining: 100 },
        register: { used: 4, limit: 20, remaining: 16 },
      },
    });
    vi.spyOn(api, 'putSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      opPauseMs: 3000,
      opJitterMs: 1000,
      queryBudget: 10000,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    renderApp();
    await waitFor(() => expect(screen.getByText('900 / 1000')).toBeInTheDocument());
    expect(screen.getByText('4 / 20')).toBeInTheDocument();

    // The server is now the single source of truth for both halves.
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      opPauseMs: 3000,
      opJitterMs: 1000,
      queryBudget: 10000,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getBudget').mockResolvedValue({
      query: { used: 900, limit: 10000, remaining: 9100 },
      register: { used: 4, limit: 20, remaining: 16 },
    });

    await waitFor(() => screen.getByRole('button', { name: /save settings/i }));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(screen.getByText('900 / 10000')).toBeInTheDocument());
    // The bug's signature: a numerator larger than the denominator.
    expect(screen.queryByText('9100 / 10000')).toBeNull();
    expect(screen.queryByText('9000 / 1000')).toBeNull();
  });

  /**
   * Q13 variant B/B′. `GET /api/settings` and `GET /api/budget` used to be read
   * with `?? <fallback>`, so a single failed fetch left the ticker showing an
   * invented poll cadence (30 ± 3) or an invented "0 / 100" — a numerator that
   * looked like "nothing has been queried today" while the real budget could
   * already be exhausted. Nothing in `packages/web/src` read `resource.error`,
   * so the failure was invisible and there was no way to retry it.
   */
  it('reports a settings failure on every route, with a retry, and only once', async () => {
    mockShell({
      getSettings: failingOnceThen(
        LOADED_SETTINGS,
        new Error('GET /api/settings failed: 500 — busy'),
      ),
    });
    renderApp();

    await waitFor(() =>
      expect(screen.getByText(/Could not load Poll cadence:/i)).toBeInTheDocument(),
    );
    // No invented cadence: the interval cell is the one the failure left
    // unresolved (targets and budget loaded fine and keep their honest numbers).
    expect(screen.queryByText(/± 3 min/)).toBeNull();
    expect(screen.queryByText(/^30 /)).toBeNull();
    expect(screen.queryAllByText('— / —')).toHaveLength(1);
    expect(screen.getByTestId('ticker-query')).toHaveTextContent('0 / 100');
    // The raw API message is kept: it carries the status the user needs to judge a retry.
    expect(screen.getByText(/GET \/api\/settings failed: 500/)).toBeInTheDocument();
    // This route is /settings, whose page consumes the same resource. The shell
    // owns the bar (the ticker cells that went blank are its own), and the page
    // stays quiet — one failure still yields one bar and one retry button.
    expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(1);
    expect(screen.queryByText(/Loading settings/i)).toBeNull();
    // The page explains the blank form without repeating the message.
    expect(screen.getByText(/Settings could not be loaded/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    // Retry really re-runs the fetch: the form appears from the recovered data
    // and the ticker's cadence cell fills in (no page reload).
    await waitFor(() => expect(screen.getByLabelText('Poll interval (min)')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/± 3 min/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load Poll cadence:/i)).toBeNull();
  });

  it('surfaces a settings failure on a route whose page does not use it', async () => {
    // Regression guard for the review finding: with ownership pinned to "the
    // Settings page", a settings failure was invisible on the Dashboard — which
    // is where users land. The ticker just showed a placeholder, with no
    // explanation and no retry unless you happened to navigate to /settings.
    mockShell({
      getSettings: failingOnceThen(LOADED_SETTINGS, new Error('GET /api/settings failed: 500')),
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <DataProvider>
          <App />
        </DataProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText(/Could not load Poll cadence:/i)).toBeInTheDocument(),
    );
    expect(screen.queryAllByText('— / —')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText(/± 3 min/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load Poll cadence:/i)).toBeNull();
  });

  it('shows a retry bar and a budget placeholder when /api/budget fails', async () => {
    mockShell({
      getBudget: failingOnceThen(ZERO_BUDGET, new Error('GET /api/budget failed: 503')),
    });
    renderApp();

    await waitFor(() =>
      expect(screen.getByText(/Could not load Today's budget/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/GET \/api\/budget failed: 503/)).toBeInTheDocument();
    // Never a made-up "0 / 100" — the placeholder is the honest answer.
    expect(screen.getByTestId('ticker-query')).toHaveTextContent('— / —');
    expect(screen.getByTestId('ticker-register')).toHaveTextContent('— / —');
    expect(screen.queryByText('0 / 100')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByTestId('ticker-query')).toHaveTextContent('0 / 100'));
    expect(screen.getByTestId('ticker-register')).toHaveTextContent('0 / 20');
    expect(screen.queryByText(/Could not load Today's budget/i)).toBeNull();
  });

  it('renders the error bars above the ticker cells they explain', async () => {
    // The Settings page hint points at "the bar above the ticker", so the bars
    // must actually be there rather than under the row of cells they belong to.
    mockShell({
      getBudget: failingOnceThen(ZERO_BUDGET, new Error('GET /api/budget failed: 503')),
    });
    renderApp();
    await waitFor(() =>
      expect(screen.getByText(/Could not load Today's budget/i)).toBeInTheDocument(),
    );

    const shell = document.querySelector('.app-shell');
    expect(shell).not.toBeNull();
    const bar = shell!.querySelector('.res-errbar');
    const ticker = shell!.querySelector('.ticker');
    expect(bar).not.toBeNull();
    expect(ticker).not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the ticker comes after the bar.
    expect(bar!.compareDocumentPosition(ticker!) & 4).toBe(4);
  });

  it('surfaces a targets failure on a route whose page does not render the list', async () => {
    // Same reasoning as the settings case above, applied to the watched-count
    // cell: on /session nothing else consumes `targets`, so without a shell bar
    // the only trace of a failed GET is a `— / —` with no explanation or retry.
    mockShell({ getTargets: () => Promise.reject(new Error('GET /api/targets failed: 503')) });
    render(
      <MemoryRouter initialEntries={['/session']}>
        <DataProvider>
          <App />
        </DataProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText(/Could not load Watched courses/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/GET \/api\/targets failed: 503/)).toBeInTheDocument();
    // One bar, one retry, and the watched cell stays a placeholder rather than
    // claiming "0 watched".
    expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(1);
    expect(screen.queryAllByText('— / —')).toHaveLength(1);

    const getTargets = vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/Could not load Watched courses/i)).toBeNull());
    expect(getTargets).toHaveBeenCalled();
  });

  it('retires the Settings save note when the shell\u2019s retry re-reads successfully', async () => {
    // The note ("saved, but re-reading failed") is owned by the page, but the only
    // retry button for `settings` lives in the shell bar above the ticker. A landed
    // re-read must retire the note wherever it was triggered from, otherwise it
    // keeps asserting something that is no longer true after a successful retry.
    let settingsCalls = 0;
    mockShell({
      getSettings: () => {
        settingsCalls += 1;
        // 1: mount — succeeds, so the form is usable. 2: the post-save re-read —
        // fails, which is what leaves the stale note. 3: retry — succeeds.
        return settingsCalls === 2
          ? Promise.reject(new Error('GET /api/settings failed: 500'))
          : Promise.resolve(LOADED_SETTINGS);
      },
    });
    vi.spyOn(api, 'putSettings').mockResolvedValue(LOADED_SETTINGS);
    renderApp();

    await waitFor(() => expect(screen.getByLabelText('Poll interval (min)')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(screen.getByText(/were saved, but re-reading them failed/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Saved ✓')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    // The shell's bar and the page's stale note are both gone; the write is
    // acknowledged as saved only now, on the re-read that actually landed.
    await waitFor(() => expect(screen.queryByText(/Could not load Poll cadence/i)).toBeNull());
    expect(screen.queryByText(/were saved, but re-reading them failed/i)).toBeNull();
    expect(settingsCalls).toBeGreaterThan(2);
  });

  it('treats a trailing-slash route as the page that owns the targets bar', async () => {
    // react-router matches `/courses/` to the same route as `/courses`, so the
    // ownership check has to match it too — otherwise the shell stacks its own
    // targets bar on top of the page's and one failure gets two retry buttons.
    mockShell({ getTargets: () => Promise.reject(new Error('GET /api/targets failed: 503')) });
    render(
      <MemoryRouter initialEntries={['/courses/']}>
        <DataProvider>
          <App />
        </DataProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText(/Could not load Course list/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Could not load Watched courses/i)).toBeNull();
    expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(1);
  });

  it('does not render the watched-count placeholder when the list loaded and is empty', async () => {
    // Guards the inverse mistake: treating a successfully-read empty list as
    // "unavailable" would hide the legitimate "0 watched" from the user.
    mockShell();
    renderApp();
    await waitFor(() => expect(screen.getByTestId('ticker-query')).toHaveTextContent('0 / 100'));
    // Scoped to the ticker: "no placeholder here" is only meaningful if the
    // ticker actually rendered and resolved. An unscoped assertion would also
    // pass on a page with no ticker at all.
    const ticker = document.querySelector('.ticker');
    expect(ticker).not.toBeNull();
    expect(within(ticker as HTMLElement).queryAllByText('— / —')).toHaveLength(0);
    expect(within(ticker as HTMLElement).getByText('0')).toBeInTheDocument();
    expect(within(ticker as HTMLElement).getByText(/± 3 min/)).toBeInTheDocument();
  });
});
