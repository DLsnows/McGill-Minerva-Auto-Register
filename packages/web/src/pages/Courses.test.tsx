import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument());
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
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add course' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(expect.objectContaining({ subject: 'COMP', targetCrn: '2347', faculty: 'Faculty of Science' })));
    // the form resets after a successful add
    await waitFor(() => expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe(''));
  });

  it('shows the required/optional marks in the edit form too (same CourseForm)', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    renderCourses();
    await waitFor(() => expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    // the add form is still mounted, so scope the assertions to the edit form itself
    const editForm = screen.getByRole('button', { name: 'Save' }).closest('form');
    expect(editForm).not.toBeNull();
    expect(within(editForm!).getByText(/marked with \* are required/i)).toBeInTheDocument();
    expect(within(editForm!).getByLabelText('Target CRN')).toHaveAttribute('aria-required', 'true');
    expect(within(editForm!).getByLabelText('Label')).not.toHaveAttribute('aria-required');
    expect(within(editForm!).getByText('(optional)')).toBeInTheDocument();
  });

  it('keeps the per-field error ids unique when the add and edit forms are both mounted', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    renderCourses();
    await waitFor(() => expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const editForm = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    const addForm = screen.getByRole('button', { name: 'Add course' }).closest('form')!;

    // the edit form is prefilled, so clear one required field to make it flag a field too
    await userEvent.click(screen.getByRole('button', { name: 'Add course' })); // add form flagged entirely
    await userEvent.clear(within(editForm).getByLabelText('Target CRN'));
    await userEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    const ids = [addForm, editForm]
      .flatMap((form) => within(form).getAllByText('This field is required.'))
      .map((el) => el.id);
    expect(ids).toHaveLength(7); // 5 from the empty add form + 2 from the edit form (empty in the fixture)
    expect(new Set(ids).size).toBe(ids.length);
    // each input points at its own form's message
    const editTarget = within(editForm).getByLabelText('Target CRN');
    const addTarget = within(addForm).getByLabelText('Target CRN');
    expect(editTarget).toHaveAccessibleDescription('This field is required.');
    expect(addTarget).toHaveAccessibleDescription('This field is required.');
    expect(editTarget.getAttribute('aria-describedby')).not.toBe(addTarget.getAttribute('aria-describedby'));
  });

  it('deletes a target', async () => {
    mockAll([
      { id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
    ]);
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() => expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(del).toHaveBeenCalledWith('t1');
  });
});
