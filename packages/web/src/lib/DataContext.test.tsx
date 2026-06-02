import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataProvider, useData } from './DataContext';
import { api } from './api';

function Probe() {
  const { targets, scheduler } = useData();
  return (
    <div>
      <span>targets:{targets.data?.length ?? '-'}</span>
      <span>running:{String(scheduler.data?.running ?? '-')}</span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('DataProvider', () => {
  it('loads and exposes the shared resources', async () => {
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      { id: 't1', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: true });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(screen.getByText('targets:1')).toBeInTheDocument());
    expect(screen.getByText('running:true')).toBeInTheDocument();
  });

  it('throws if useData is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useData/);
    spy.mockRestore();
  });
});
