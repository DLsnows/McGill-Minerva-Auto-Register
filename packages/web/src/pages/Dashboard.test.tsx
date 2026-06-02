import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Dashboard from './Dashboard';
import { api } from '../lib/api';

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({ events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }], connected: true }),
}));

function mockApi(targets: Awaited<ReturnType<typeof api.getTargets>>, sessionStatus: 'authenticated' | 'logged-out') {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: sessionStatus });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderDashboard = () =>
  render(
    <DataProvider>
      <Dashboard />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Dashboard', () => {
  it('loads targets and renders a card + console', async () => {
    mockApi(
      [{ id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.getByText('hello-console')).toBeInTheDocument();
    expect(screen.getByText('Watched Courses')).toBeInTheDocument();
  });

  it('shows the empty state when there are no targets', async () => {
    mockApi([], 'logged-out');
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });

  it('starts the scheduler from the Dashboard toggle', async () => {
    mockApi([], 'authenticated');
    const start = vi.spyOn(api, 'startScheduler').mockResolvedValue({ running: true });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start/i }));
    await userEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(start).toHaveBeenCalled();
  });
});
