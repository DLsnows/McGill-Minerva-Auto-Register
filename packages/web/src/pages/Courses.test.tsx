import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Courses from './Courses';
import { api } from '../lib/api';

function mockAll(targets: Awaited<ReturnType<typeof api.getTargets>>) {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue({ query: 100, register: 20 });
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
}

const renderCourses = () =>
  render(
    <DataProvider>
      <Courses />
    </DataProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('Courses', () => {
  it('lists existing targets', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    renderCourses();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
  });

  it('adds a course via the form', async () => {
    mockAll([]);
    const add = vi.spyOn(api, 'addTarget').mockResolvedValue({
      id: 'new', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0,
    });
    renderCourses();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add course' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ subject: 'COMP', targetCrn: '2347' })));
    // the form resets after a successful add
    await waitFor(() => expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe(''));
  });

  it('deletes a target', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(del).toHaveBeenCalledWith('t1');
  });
});
