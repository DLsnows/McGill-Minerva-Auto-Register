import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Courses from './Courses';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

function mockAll(targets: Awaited<ReturnType<typeof api.getTargets>>) {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30,
    jitterMinutes: 3,
    queryBudget: 100,
    registerBudget: 20,
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
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        mode: 'auto',
        status: 'watching',
        createdAt: 0,
      },
    ]);
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );
  });

  it('adds a course via the form', async () => {
    mockAll([]);
    const add = vi.spyOn(api, 'addTarget').mockResolvedValue({
      id: 'new',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto',
      status: 'watching',
      createdAt: 0,
    });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument(),
    );
    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add course' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'COMP',
          targetCrn: '2347',
          faculty: 'Faculty of Science',
        }),
      ),
    );
    // the form resets after a successful add
    await waitFor(() =>
      expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe(''),
    );
  });

  it('shows the required/optional marks in the edit form too (same CourseForm)', async () => {
    mockAll([
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        mode: 'auto',
        status: 'watching',
        createdAt: 0,
      },
    ]);
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );
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
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        mode: 'auto',
        status: 'watching',
        createdAt: 0,
      },
    ]);
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );
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
    expect(editTarget.getAttribute('aria-describedby')).not.toBe(
      addTarget.getAttribute('aria-describedby'),
    );
  });

  it('deletes a target', async () => {
    mockAll([
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        mode: 'auto',
        status: 'watching',
        createdAt: 0,
      },
    ]);
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(del).toHaveBeenCalledWith('t1');
  });

  // Q3: the server revives a breaker-stopped target when a query field is edited
  // (that is literally what the error message tells the user to fix). Saving one
  // must therefore also make sure the engine is running — otherwise the course
  // flips back to "watching" with nothing polling it.
  it('starts the scheduler after saving a correction to an errored course', async () => {
    mockAll([
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        faculty: 'Faculty of Science',
        mode: 'auto',
        status: 'error',
        createdAt: 0,
      },
    ]);
    vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    const startScheduler = vi.spyOn(api, 'startScheduler').mockResolvedValue({ running: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const editForm = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    await userEvent.clear(within(editForm).getByLabelText('Target CRN'));
    await userEvent.type(within(editForm).getByLabelText('Target CRN'), '2222');
    await userEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(startScheduler).toHaveBeenCalled());
  });

  it('does not touch the scheduler when saving an edit to a non-errored course', async () => {
    mockAll([
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        faculty: 'Faculty of Science',
        mode: 'auto',
        status: 'watching',
        createdAt: 0,
      },
    ]);
    vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    const startScheduler = vi.spyOn(api, 'startScheduler').mockResolvedValue({ running: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const editForm = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    await userEvent.clear(within(editForm).getByLabelText('Target CRN'));
    await userEvent.type(within(editForm).getByLabelText('Target CRN'), '2222');
    await userEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateTarget).toHaveBeenCalled());
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it('still reports success but warns when the post-save scheduler start fails', async () => {
    mockAll([
      {
        id: 't1',
        label: 'COMP 551',
        term: '202701',
        subject: 'COMP',
        courseNumber: '551',
        targetCrn: '2347',
        faculty: 'Faculty of Science',
        mode: 'auto',
        status: 'error',
        createdAt: 0,
      },
    ]);
    vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    vi.spyOn(api, 'startScheduler').mockRejectedValue(new Error('engine down'));
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const editForm = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    await userEvent.clear(within(editForm).getByLabelText('Target CRN'));
    await userEvent.type(within(editForm).getByLabelText('Target CRN'), '2222');
    await userEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    // The save itself succeeded, so it must not be reported as a failed save —
    // but the broken engine has to be visible.
    await waitFor(() =>
      expect(screen.getByText(/starting the scheduler failed/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/engine down/)).toBeNull();
  });

  /**
   * Q13 variant C, Courses page: a failed `GET /api/targets` rendered "No courses
   * yet." — indistinguishable from a genuinely empty configuration, with no retry
   * entry point. That is the state in which a user re-adds a course they still
   * have, and `addTarget` does not de-duplicate, so the mistake produces a second
   * watch target for the same CRN.
   */
  it('shows an error bar with a working retry instead of "No courses yet." when /api/targets fails', async () => {
    const watchTarget = {
      id: 't1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    };
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() =>
      calls++ === 0
        ? Promise.reject(new Error('GET /api/targets failed: 503'))
        : Promise.resolve([watchTarget]),
    );
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderCourses();

    await waitFor(() =>
      expect(screen.getByText(/Could not load Course list/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No courses yet/i)).toBeNull();
    expect(screen.getByText(/GET \/api\/targets failed: 503/)).toBeInTheDocument();
    // The add form stays usable while the list is unreadable.
    expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Could not load Course list/i)).toBeNull();
  });

  it('reports a stale list when the post-mutation refresh fails instead of a clean success', async () => {
    // `refetch` records its failure and returns it rather than throwing, so the
    // old `await targets.refetch()` inside the try block let a failed refresh
    // through as success — with no explanation at all.
    const watchTarget = {
      id: 't1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    };
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() => {
      calls += 1;
      // 1st: the mount read. 2nd: the post-mutation refresh — fails. 3rd: retry.
      return calls === 2
        ? Promise.reject(new Error('refresh boom'))
        : Promise.resolve([watchTarget]);
    });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(del).toHaveBeenCalledWith('t1');
    // Two separate messages are on screen by design: the mutation-level note and
    // the resource error bar that marks the list itself as unreadable/stale.
    await waitFor(() =>
      expect(screen.getByText(/re-reading the course list failed/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Could not load Course list/i)).toBeInTheDocument();
    // The list the client still holds is not thrown away by the failed refresh.
    expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument();

    // Retrying from the resource bar recovers the list AND retires the stale note
    // above it — leaving "re-reading failed" next to a freshly read list would be
    // simply untrue.
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/Could not load Course list/i)).toBeNull());
    expect(screen.queryByText(/re-reading the course list failed/i)).toBeNull();
    expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument();
    expect(calls).toBeGreaterThan(2);
  });

  /**
   * A successful `add` whose follow-up refresh fails still added the course. If
   * the form reset were keyed off "the list is current again" instead of "the
   * write landed", the fields would stay filled after a successful add — and a
   * second click would create a duplicate target, which `addTarget` does not
   * de-duplicate. (The reviewed regression: `run` used to return one boolean for
   * both halves.)
   */
  it('clears the add form when the course was added but the list refresh failed', async () => {
    const added = {
      id: 'new',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    };
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() => {
      calls += 1;
      // 1: mount. 2: the refresh after the add — fails.
      return calls === 2 ? Promise.reject(new Error('refresh boom')) : Promise.resolve([]);
    });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    const add = vi.spyOn(api, 'addTarget').mockResolvedValue(added);
    renderCourses();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument(),
    );

    await userEvent.type(screen.getByLabelText('Term'), '202701');
    await userEvent.type(screen.getByLabelText('Subject'), 'COMP');
    await userEvent.type(screen.getByLabelText('Faculty'), 'Faculty of Science');
    await userEvent.type(screen.getByLabelText('Course #'), '551');
    await userEvent.type(screen.getByLabelText('Target CRN'), '2347');
    await userEvent.click(screen.getByRole('button', { name: 'Add course' }));

    expect(add).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText(/re-reading the course list failed/i)).toBeInTheDocument(),
    );
    // The write landed, so the form must be empty again — otherwise the next
    // click re-adds the very same course.
    await waitFor(() =>
      expect((screen.getByLabelText('Target CRN') as HTMLInputElement).value).toBe(''),
    );
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('');
  });

  /**
   * A *superseded* refetch is not a failure. Reporting it as "re-reading the course
   * list failed" would be false (a newer read won and the list is current), and
   * because the winner has already bumped `revision`, the note could be armed
   * against a revision the retirement effect had passed — leaving it stuck forever.
   * Reachable by clicking two mutation buttons quickly: neither is disabled while
   * `run()` is in flight, so the loser of the race reports `superseded`.
   */
  it('does not report a superseded list read as a failed one', async () => {
    const watchTarget = {
      id: 't1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    };
    // Reads after the first never settle on their own: the second delete's refetch
    // is left in flight while the third supersedes it.
    const pending: Array<(v: Awaited<ReturnType<typeof api.getTargets>>) => void> = [];
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([watchTarget]);
      return new Promise((resolve) => pending.push(resolve));
    });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValue({ ok: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    // Two mutations in quick succession: their refetches race.
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(del).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));

    // Let the *older* refetch resolve last, so it is the superseded one.
    await act(async () => {
      pending[1]([watchTarget]);
      await Promise.resolve();
    });
    await act(async () => {
      pending[0]([watchTarget]);
      await Promise.resolve();
    });

    // The superseded continuation must not have written a "re-reading failed" note.
    expect(screen.queryByText(/re-reading the course list failed/i)).toBeNull();
  });

  /**
   * The two things `err` carries retire differently. A *successful* list retry
   * only disproves the "re-reading failed" note; a mutation that threw is still
   * true, and the same slot reports it, so the retry must not wipe it.
   */
  it('keeps an unrelated operation failure when a list retry succeeds', async () => {
    const watchTarget = {
      id: 't1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    };
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() => {
      calls += 1;
      // 1: mount. 2: the refresh after the first delete — fails. 3: retry — works.
      return calls === 2
        ? Promise.reject(new Error('refresh boom'))
        : Promise.resolve([watchTarget]);
    });
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    const del = vi.spyOn(api, 'removeTarget').mockResolvedValueOnce({ ok: true });
    renderCourses();
    await waitFor(() =>
      expect(screen.getByText('COMP 551', { selector: '.title' })).toBeInTheDocument(),
    );

    // 1st delete: the mutation succeeds, its refresh fails.
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() =>
      expect(screen.getByText(/re-reading the course list failed/i)).toBeInTheDocument(),
    );

    // 2nd delete: now the mutation itself throws.
    del.mockRejectedValueOnce(new Error('delete boom'));
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(screen.getByText(/delete boom/)).toBeInTheDocument());

    // Retrying the list must not erase the still-true mutation failure.
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/Could not load Course list/i)).toBeNull());
    expect(screen.getByText(/delete boom/)).toBeInTheDocument();
    expect(screen.queryByText(/re-reading the course list failed/i)).toBeNull();
  });
});
