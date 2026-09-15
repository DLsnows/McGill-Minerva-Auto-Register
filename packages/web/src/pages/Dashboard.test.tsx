import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Dashboard from './Dashboard';
import { api } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({
    events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }],
    connected: true,
    clear: () => {},
  }),
}));

function mockApi(
  targets: Awaited<ReturnType<typeof api.getTargets>>,
  sessionStatus: 'authenticated' | 'logged-out',
  engineRunning = false,
) {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: sessionStatus });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: engineRunning });
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

  it('master toggle reads "Start all" when every course is paused/terminal', async () => {
    mockApi(
      [{ id: 'p1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'paused', createdAt: 0 }],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /start all/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /stop all/i })).toBeNull();
  });

  // REGRESSION for the top user report: "the first Start after adding a course
  // does not actually start polling — you have to close the app and press
  // 'Start all' again."
  //
  // New courses default to status 'watching' while the engine is NOT running.
  // The master switch used to key both its label and its action off "is any
  // course watching?", so it read "Stop all" and the first click ran stop-all —
  // pausing every course and stopping the engine, the exact opposite of what the
  // user asked for. The switch must follow the ENGINE state, not the course list.
  it('REGRESSION: with watching courses but a stopped engine the master switch offers Start all and calls startAll (never stopAll)', async () => {
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
      false, // engine NOT running
    );
    const startAll = vi
      .spyOn(api, 'startAll')
      .mockResolvedValue({ running: true, resumed: 0, recovered: 0, skipped: 0 });
    const stopAll = vi.spyOn(api, 'stopAll').mockResolvedValue({ running: false, paused: 1 });

    renderDashboard();

    const start = await screen.findByRole('button', { name: /start all/i });
    expect(screen.queryByRole('button', { name: /stop all/i })).toBeNull();

    await userEvent.click(start);
    expect(startAll).toHaveBeenCalledTimes(1);
    expect(stopAll).not.toHaveBeenCalled();
  });

  it('master switch reads "Stop all" and stops when the engine is actually running', async () => {
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
      true, // engine running
    );
    const stopAll = vi.spyOn(api, 'stopAll').mockResolvedValue({ running: false, paused: 1 });
    const startAll = vi
      .spyOn(api, 'startAll')
      .mockResolvedValue({ running: true, resumed: 0, recovered: 0, skipped: 0 });
    renderDashboard();
    const stop = await screen.findByRole('button', { name: /stop all/i });
    expect(screen.queryByRole('button', { name: /start all/i })).toBeNull();
    await userEvent.click(stop);
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(startAll).not.toHaveBeenCalled();
  });

  it('warns that watching courses are not actually being polled while the engine is stopped', async () => {
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
      false,
    );
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/engine is stopped — these courses are listed as watching/i)).toBeInTheDocument(),
    );
  });

  it('clears the console from the Clear button', async () => {
    mockApi([], 'authenticated');
    const clearEvents = vi.spyOn(api, 'clearEvents').mockResolvedValue({ ok: true });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /clear/i }));
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(clearEvents).toHaveBeenCalled();
  });

  it('surfaces a console-clear failure with its own message', async () => {
    mockApi([], 'authenticated');
    vi.spyOn(api, 'clearEvents').mockRejectedValue(new Error('clear boom'));
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /clear/i }));
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    await waitFor(() => expect(screen.getByText(/clear boom/i)).toBeInTheDocument());
  });

  it('pauses a single course from its card', async () => {
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
    );
    const update = vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /pause/i }));
    await userEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(update).toHaveBeenCalledWith('w1', { status: 'paused' });
  });

  it('resumes a paused course through the resume endpoint (which also starts the engine)', async () => {
    mockApi(
      [{ id: 'p1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'paused', createdAt: 0 }],
      'authenticated',
    );
    const resumeTarget = vi.spyOn(api, 'resumeTarget').mockResolvedValue({ running: true, status: 'watching' });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /^▶ resume$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^▶ resume$/i }));
    expect(resumeTarget).toHaveBeenCalledWith('p1');
  });

  it('disables "Start all" when not logged in', async () => {
    mockApi(
      [{ id: 'p1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'paused', createdAt: 0 }],
      'logged-out',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /start all/i })).toBeDisabled());
  });

  it('starts all from the Dashboard master toggle', async () => {
    mockApi([], 'authenticated');
    const startAll = vi
      .spyOn(api, 'startAll')
      .mockResolvedValue({ running: true, resumed: 0, recovered: 0, skipped: 0 });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    expect(startAll).toHaveBeenCalled();
  });

  it('reports what "Start all" did (resumed / recovered / finished counts)', async () => {
    mockApi([], 'authenticated');
    vi.spyOn(api, 'startAll').mockResolvedValue({ running: true, resumed: 2, recovered: 1, skipped: 3 });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    await waitFor(() =>
      expect(screen.getByText(/2 resumed, 1 recovered from error, 3 already finished/i)).toBeInTheDocument(),
    );
  });

  // The three-strikes failure breaker parks a course in 'error'. That used to be
  // a dead end: no pause, no resume, no immediate run, and start-all skipped it —
  // so the only way back was deleting the course.
  it('offers a recovery action on an error card and calls the resume endpoint', async () => {
    mockApi(
      [{ id: 'e1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'error', createdAt: 0 }],
      'authenticated',
    );
    const resumeTarget = vi.spyOn(api, 'resumeTarget').mockResolvedValue({ running: true, status: 'watching' });
    renderDashboard();
    const retry = await screen.findByRole('button', { name: /resume watching/i });
    await userEvent.click(retry);
    expect(resumeTarget).toHaveBeenCalledWith('e1');
  });

  it('refetches budget + targets when a log event streams in (live update, no manual refresh)', async () => {
    const getTargets = vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    const getBudget = vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, opPauseMs: 3000, opJitterMs: 1000, queryBudget: 100, registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderDashboard();
    // Mount fetch (useResource) + the event-driven refetch (mocked event id 'e')
    // → each endpoint is hit at least twice without any manual page refresh.
    await waitFor(() => {
      expect(getBudget.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(getTargets.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('surfaces a scheduler toggle error', async () => {
    mockApi([], 'authenticated');
    vi.spyOn(api, 'startAll').mockRejectedValue(new Error('sched boom'));
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    await waitFor(() => expect(screen.getByText(/sched boom/i)).toBeInTheDocument());
  });
});
