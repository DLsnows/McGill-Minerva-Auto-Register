import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import { api } from '../lib/api';

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({ events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }], connected: true }),
}));

afterEach(() => vi.restoreAllMocks());

describe('Dashboard', () => {
  it('loads targets and renders a card + console', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 88, register: 19 });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.getByText('hello-console')).toBeInTheDocument();
    expect(screen.getByText('Watched Courses')).toBeInTheDocument();
  });

  it('shows the empty state when there are no targets', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'logged-out' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });
});
