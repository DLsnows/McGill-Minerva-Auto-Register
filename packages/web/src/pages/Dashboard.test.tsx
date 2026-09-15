import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Dashboard from './Dashboard';
import { api, ApiError, SESSION_NOT_READY } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';

/**
 * Read a React `onClick` handler straight off an element.
 *
 * Needed to test the *handler* of a disabled control: the browser (and jsdom)
 * refuses to dispatch a click to a disabled button, but the handler still runs if
 * it is reached with a stale snapshot of the session. Walking the React fiber is
 * the only way in without exporting the callback for the test's sake.
 */
function reachableOnClick(el: Element): unknown {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (!key) throw new Error('no React props found on the element');
  return (el as unknown as Record<string, { onClick?: unknown }>)[key]?.onClick;
}

vi.mock('../lib/useEventStream', () => ({
  useEventStream: () => ({
    events: [{ id: 'e', ts: Date.now(), level: 'info', message: 'hello-console' }],
    connected: true,
    clear: () => {},
  }),
}));

function mockApi(targets: Awaited<ReturnType<typeof api.getTargets>>, sessionStatus: 'authenticated' | 'logged-out') {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: sessionStatus });
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
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

  it('master toggle reads "Start all" when every course is paused/terminal', async () => {
    mockApi(
      [{ id: 'p1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'paused', createdAt: 0 }],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /start all/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /stop all/i })).toBeNull();
  });

  it('master toggle reads "Stop all" when a course is watching', async () => {
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /stop all/i })).toBeInTheDocument());
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
    const startAll = vi.spyOn(api, 'startAll').mockResolvedValue({ running: true, resumed: 0 });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    expect(startAll).toHaveBeenCalled();
  });

  it('refetches budget + targets when a log event streams in (live update, no manual refresh)', async () => {
    const getTargets = vi.spyOn(api, 'getTargets').mockResolvedValue([]);
    const getBudget = vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
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

  /**
   * Q12 regression. The server now refuses to start an engine it cannot honour
   * (`409 { code: 'session-not-ready' }`). A refusal the user cannot see is just
   * as bad as the silent success it replaced, so the reason must be rendered —
   * and localized, not the raw server prose or a generic "toggle failed".
   */
  it('shows why the engine refused to start (session-not-ready)', async () => {
    mockApi(
      [{ id: 'p1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'paused', createdAt: 0 }],
      'authenticated',
    );
    // The UI still believes it is authenticated (stale snapshot); the server is
    // the one that knows better. Resuming a single course also starts the engine,
    // which is where that disagreement surfaces.
    let calls = 0;
    const getSession = vi
      .spyOn(api, 'getSession')
      .mockImplementation(async () => ({ status: ++calls === 1 ? 'authenticated' : 'logged-out' }));
    vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    vi.spyOn(api, 'startScheduler').mockRejectedValue(
      new ApiError('Not logged in — open the Session tab and log in before starting the engine.', {
        code: SESSION_NOT_READY,
        httpStatus: 409,
        sessionStatus: 'logged-out',
      }),
    );
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1)); // session landed
    expect(screen.queryByText(/Session is not active/i)).toBeNull(); // still "authenticated"
    await userEvent.click(screen.getByRole('button', { name: /resume/i }));

    // Localized reason, not a generic "Scheduler toggle failed." — the phrasing
    // below is the i18n string's, not the server's.
    await waitFor(() =>
      expect(
        screen.getByText(/Not logged in — open the Session tab and log in before starting the engine\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Scheduler toggle failed/)).toBeNull();
    // The refusal proved the session snapshot was stale, so this path must re-read
    // it too (reported in review: only the master-toggle path did).
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByText(/Session is not active/i)).toBeInTheDocument());
  });

  it('re-reads the session when the server refuses a start, so the banner appears', async () => {
    mockApi([], 'authenticated');
    let calls = 0;
    const getSession = vi
      .spyOn(api, 'getSession')
      .mockImplementation(async () => ({ status: ++calls === 1 ? 'authenticated' : 'logged-out' }));
    vi.spyOn(api, 'startAll').mockRejectedValue(
      new ApiError('stop', { code: SESSION_NOT_READY, httpStatus: 409 }),
    );
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    expect(getSession).toHaveBeenCalledTimes(1); // mount fetch
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(1));
    // The banner keys off the session resource, so it only appears if the refusal
    // actually triggered a re-read of the session.
    await waitFor(() =>
      expect(screen.getByText(/Session is not active/i)).toBeInTheDocument(),
    );
  });

  it('explains a click that cannot do anything (no session, nothing watching)', async () => {
    mockApi([], 'logged-out');
    renderDashboard();
    const start = await screen.findByRole('button', { name: /start all/i });
    // The button is disabled in this state, but the reason must not be a mystery:
    // the label explains it, and the handler must say it too rather than silently
    // returning (which is what it used to do).
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Log in first');

    const onClick = reachableOnClick(start);
    expect(onClick).toBeTypeOf('function');
    await act(async () => {
      await (onClick as () => Promise<void>)();
    });
    await waitFor(() =>
      expect(screen.getByText(/Not logged in — open the Session tab/)).toBeInTheDocument(),
    );
  });

  /**
   * Q41 regression: `GET /api/scheduler` was fetched on every render of the shell
   * and never displayed, so "did the engine actually start?" had no answer in the
   * UI — only the master button's label, which tracks stored course states.
   */
  it('renders the engine state from GET /api/scheduler', async () => {
    mockApi([], 'authenticated');
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: true });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Engine · running/i)).toBeInTheDocument());
    expect(screen.queryByText(/Engine · stopped/i)).toBeNull();
  });

  it('renders the engine as stopped when the scheduler is not running', async () => {
    mockApi([], 'authenticated'); // mockApi defaults to { running: false }
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Engine · stopped/i)).toBeInTheDocument());
  });

  it('shows the engine as stopped even while courses are watching (the old confusion)', async () => {
    // Stored state says "watching", the engine says otherwise. Both facts must be
    // visible instead of the stored state standing in for the engine's.
    mockApi(
      [{ id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
      'authenticated',
    );
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Engine · stopped/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /stop all/i })).toBeInTheDocument();
  });
});
