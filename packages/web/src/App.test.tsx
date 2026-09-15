import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DataProvider } from './lib/DataContext';
import { ZERO_BUDGET } from './lib/budget-fixture';
import { api } from './lib/api';
import App from './App';

function mockShell(
  overrides: {
    settings?: Awaited<ReturnType<typeof api.getSettings>>;
    budget?: typeof ZERO_BUDGET;
  } = {},
) {
  vi.spyOn(api, 'getTargets').mockResolvedValue([]);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue(overrides.budget ?? ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue(
    overrides.settings ?? {
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      opPauseMs: 3000,
      opJitterMs: 1000,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    },
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
    // Rendered before the mocked fetches resolve → no invented "0 / 100".
    expect(screen.getAllByText('— / —')).toHaveLength(2);
    await waitFor(() => expect(screen.getByText('0 / 100')).toBeInTheDocument());
    expect(screen.getByText('0 / 20')).toBeInTheDocument();
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
});
