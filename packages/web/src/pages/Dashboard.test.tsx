import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataProvider } from '../lib/DataContext';
import Dashboard from './Dashboard';
import { api, ApiError, SESSION_NOT_READY } from '../lib/api';
import { ZERO_BUDGET } from '../lib/budget-fixture';
import { installFakeWebSocket, lastFakeSocket } from '../test-setup';

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

function mockApi(
  targets: Awaited<ReturnType<typeof api.getTargets>>,
  sessionStatus: 'authenticated' | 'logged-out',
) {
  vi.spyOn(api, 'getTargets').mockResolvedValue(targets);
  vi.spyOn(api, 'getSession').mockResolvedValue({ status: sessionStatus });
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

/** Deliver a live event frame on the tab's single stream socket. */
function streamEvent(message: string) {
  act(() =>
    lastFakeSocket()?.emit({
      type: 'event',
      event: { id: `live-${message}`, ts: Date.now(), level: 'info', message },
    }),
  );
}

const renderDashboard = () =>
  render(
    <DataProvider>
      <Dashboard />
    </DataProvider>,
  );

beforeEach(() => installFakeWebSocket());
afterEach(() => vi.restoreAllMocks());

describe('Dashboard', () => {
  it('loads targets and renders a card + console', async () => {
    mockApi(
      [
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
      ],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.getByText('Watched Courses')).toBeInTheDocument();
    // The console renders the shared stream (the same socket the whole tab uses).
    streamEvent('hello-console');
    await waitFor(() => expect(screen.getByText('hello-console')).toBeInTheDocument());
  });

  it('shows the empty state when there are no targets', async () => {
    mockApi([], 'logged-out');
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });

  it('master toggle reads "Start all" when every course is paused/terminal', async () => {
    mockApi(
      [
        {
          id: 'p1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'paused',
          createdAt: 0,
        },
      ],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /start all/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /stop all/i })).toBeNull();
  });

  it('master toggle reads "Stop all" when a course is watching', async () => {
    mockApi(
      [
        {
          id: 'w1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'watching',
          createdAt: 0,
        },
      ],
      'authenticated',
    );
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /stop all/i })).toBeInTheDocument(),
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
      [
        {
          id: 'w1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'watching',
          createdAt: 0,
        },
      ],
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
      [
        {
          id: 'p1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'paused',
          createdAt: 0,
        },
      ],
      'logged-out',
    );
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /start all/i })).toBeDisabled());
  });

  it('starts all from the Dashboard master toggle', async () => {
    mockApi([], 'authenticated');
    const startAll = vi
      .spyOn(api, 'startAll')
      .mockResolvedValue({ running: true, resumed: 0, skipped: 0, errored: 0 });
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
      pollIntervalMinutes: 30,
      jitterMinutes: 3,
      queryBudget: 100,
      registerBudget: 20,
      notify: { desktop: true, sound: true, email: false },
    });
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderDashboard();
    await waitFor(() => expect(getBudget).toHaveBeenCalledTimes(1)); // mount fetch
    streamEvent('a poll finished');
    // The event-driven refetch hits both endpoints without a manual page refresh.
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

  // --- Q3/Q20: recovering from the `error` state -----------------------------

  it('resumes an errored course through the dedicated resume route, not a raw PATCH', async () => {
    const errored = {
      id: 'e1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'error' as const,
      createdAt: 0,
    };
    mockApi([errored], 'authenticated');
    const resume = vi
      .spyOn(api, 'resumeTarget')
      .mockResolvedValue({ resumed: true, status: 'watching' });
    const patch = vi.spyOn(api, 'updateTarget').mockResolvedValue({} as never);
    const startScheduler = vi.spyOn(api, 'startScheduler').mockResolvedValue({ running: true });
    renderDashboard();

    const btn = await screen.findByRole('button', { name: /resume watching/i });
    await userEvent.click(btn);

    // A plain status PATCH would leave the failure streak intact, so the target
    // would trip straight back into 'error' on the next blip.
    expect(resume).toHaveBeenCalledWith('e1');
    expect(patch).not.toHaveBeenCalled();
    expect(startScheduler).toHaveBeenCalled(); // and something is actually polling it
  });

  it('tells the user how many courses "Start all" skipped, and why', async () => {
    mockApi(
      [
        {
          id: 'e1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'error',
          createdAt: 0,
        },
      ],
      'authenticated',
    );
    vi.spyOn(api, 'startAll').mockResolvedValue({
      running: true,
      resumed: 0,
      skipped: 1,
      errored: 1,
    });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));

    // Before: the response was discarded, so the click looked like a no-op.
    await waitFor(() => expect(screen.getByText(/skipped 1/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /resume watching/i })).toBeInTheDocument();
  });

  it('reports a resumption count when Start all restores paused courses', async () => {
    mockApi(
      [
        {
          id: 'p1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'paused',
          createdAt: 0,
        },
      ],
      'authenticated',
    );
    vi.spyOn(api, 'startAll').mockResolvedValue({
      running: true,
      resumed: 2,
      skipped: 0,
      errored: 0,
    });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /start all/i }));
    await userEvent.click(screen.getByRole('button', { name: /start all/i }));
    await waitFor(() => expect(screen.getByText(/resumed 2 course/i)).toBeInTheDocument());
  });

  /**
   * Q12 regression. The server now refuses to start an engine it cannot honour
   * (`409 { code: 'session-not-ready' }`). A refusal the user cannot see is just
   * as bad as the silent success it replaced, so the reason must be rendered —
   * and localized, not the raw server prose or a generic "toggle failed".
   */
  it('shows why the engine refused to start (session-not-ready)', async () => {
    mockApi(
      [
        {
          id: 'p1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'paused',
          createdAt: 0,
        },
      ],
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
        screen.getByText(
          /Not logged in — open the Session tab and log in before starting the engine\./,
        ),
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
    await waitFor(() => expect(screen.getByText(/Session is not active/i)).toBeInTheDocument());
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
      [
        {
          id: 'w1',
          label: 'COMP 551',
          term: '202701',
          subject: 'COMP',
          courseNumber: '551',
          targetCrn: '2347',
          mode: 'auto',
          status: 'watching',
          createdAt: 0,
        },
      ],
      'authenticated',
    );
    vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: false });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Engine · stopped/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /stop all/i })).toBeInTheDocument();
  });

  // ── manual run feedback (audit Q16/Q60/Q23) ────────────────────────────────
  // Before the fix `onRun` awaited api.runTarget and cleared the running state in
  // `finally`: a dropped request produced no visible change at all, so these
  // tests fail against the old behaviour (no status element ever renders).

  const watching = [
    {
      id: 'w1',
      label: 'COMP 551',
      term: '202701',
      subject: 'COMP',
      courseNumber: '551',
      targetCrn: '2347',
      mode: 'auto' as const,
      status: 'watching' as const,
      createdAt: 0,
    },
  ];

  it('tells the user when a manual run was dropped because one is already running', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      const t0 = Date.now();
      // Real shape: the server echoes the window start on every 200 body.
      vi.spyOn(api, 'runTarget').mockResolvedValue({
        started: false,
        reason: 'in progress',
        lastForcedRunAt: t0,
      });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/already running/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review findings, rounds 5–7: the "already running" notice was written once and
  // never retired, so it ended up pinned next to a fresh "last poll just now" or a
  // REGISTERED badge — the contradiction it exists to remove.
  //
  // Two rounds tried to infer "the cycle finished" from target state and both
  // failed: `lastPolledAt` is written mid-cycle (a click landing after the query
  // captured an already-advanced value, so the notice could never be retired), and
  // `nextPollAt` is only rewritten by the exit paths that schedule another cycle —
  // the terminal outcomes (`registered`, `waitlisted`, lost session → `paused`,
  // FAILURE_LIMIT → `error`) never touch it, while `PUT /api/settings` →
  // `rescheduleWatching()` rewrote it with no cycle finishing at all.
  //
  // So the notice is retracted on a *status* change (unambiguous: the cycle ended
  // in a terminal state) and otherwise expires on its own (NOTICE_TTL_MS).
  it('retires the "already running" notice when the running cycle ends in a terminal state', async () => {
    const scheduled = {
      ...watching[0],
      lastPolledAt: Date.now() - 5_000,
      nextPollAt: Date.now() + 60_000,
    };
    mockApi([scheduled], 'authenticated');
    vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'in progress' });
    // `mockResolvedValueOnce` for the mount fetch, so the refreshed targets below
    // are actually what the assertion sees (a mock that keeps returning the old
    // list would let the test pass without the retirement ever running).
    const getTargets = vi
      .spyOn(api, 'getTargets')
      .mockResolvedValueOnce([scheduled])
      .mockResolvedValue([scheduled]);
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /register now/i }));
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    await waitFor(() =>
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/already running/i),
    );

    // The running cycle registers the course. That path sets the status and returns
    // WITHOUT rescheduling — it never touches `nextPollAt`, which is why the
    // previous `nextPollAt`-based signal left the notice pinned here forever.
    getTargets.mockResolvedValue([{ ...scheduled, status: 'registered' as const }]);
    streamEvent('Registered COMP 551! 🎉');
    await waitFor(() => expect(screen.queryByTestId('run-notice')).toBeNull());
    expect(screen.getByText('REGISTERED')).toBeInTheDocument();
  });

  it('expires the "already running" notice on its own when no status change arrives', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'in progress' });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/already running/i);

      // A cycle that schedules another poll leaves `status` at 'watching', so no
      // signal distinguishes "still running" from "finished and rescheduled". The
      // bounded lifetime is what keeps the notice from being stranded.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(screen.queryByTestId('run-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding (8th round): an elapsed local estimate must not block the
  // server's `lastForcedRunAt` fallback forever. It is retired on the next
  // refetch, so a window started elsewhere (another tab) still renders here.
  it('lets a newer server-reported window take over once the local estimate has elapsed', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      vi.spyOn(api, 'runTarget').mockResolvedValue({
        started: false,
        reason: 'cooldown',
        retryAfterMs: 5_000,
      });
      const getTargets = vi.spyOn(api, 'getTargets').mockResolvedValue(watching);
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();

      // The 5s window elapses locally: with no server window anywhere, the button
      // must come back rather than staying stuck on a spent estimate.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeEnabled();

      // A refetch then reports a window that started just now (a manual run from
      // another tab). The retired estimate must not shadow it: the cooldown is
      // visible again straight away instead of only after a rejected click.
      // (`act` flushes the refetch promise; `waitFor` cannot be used here because
      // it polls with timers that fake time never advances.)
      getTargets.mockResolvedValue([{ ...watching[0], lastForcedRunAt: Date.now() }]);
      await act(async () => {
        streamEvent('Immediate cycle started elsewhere');
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 60s/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding (6th round): the in-flight seed must not read as an *active*
  // cooldown on a card whose `now` is stale. With a near-past seed (`Date.now() -
  // 1000`) and a `now` ~25s behind, `cooldownRemainingMs` returned ~24s, so a
  // dropped run showed a frozen "Try again in Ns" instead of its verdict and left
  // the button disabled even though the server would accept a retry.
  it('does not fake a cooldown on a card whose tick is stale when a run is dropped', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'in progress' });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Let the card's idle heartbeat go stale before the click.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const notice = screen.getByTestId('run-notice');
      expect(notice).toHaveTextContent(/already running/i);
      expect(notice).not.toHaveTextContent(/Try again in \d+s/i);
      // The server would accept a retry, so the button must be usable again.
      expect(screen.getByRole('button', { name: /register now/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding: with a fixed error message ("Try again in 45s") the countdown
  // was a lie, and no test caught it because the mocks fed the *wrong* response
  // shape (no `retryAfterMs`) — the opposite of what the server sends. These two
  // tests use the real shape and read the numbers back out of the render.
  it('tells the user the manual run was throttled, and counts the window down', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      // A real rejection reports the remainder of a window that already started.
      vi.spyOn(api, 'runTarget').mockResolvedValue({
        started: false,
        reason: 'cooldown',
        retryAfterMs: 45_000,
      });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/throttled to one per minute/i);
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 45s/i);
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 44s/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unknown drop reason neutrally instead of implying the worst', async () => {
    mockApi(watching, 'authenticated');
    vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'target is paused' });
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /register now/i }));
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    await waitFor(() =>
      expect(screen.getByTestId('run-notice')).toHaveTextContent(
        /This check was not started.*target is paused/i,
      ),
    );
  });

  it('surfaces a failed run request instead of clearing the spinner silently', async () => {
    mockApi(watching, 'authenticated');
    vi.spyOn(api, 'runTarget').mockRejectedValue(new Error('run boom'));
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /register now/i }));
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    await waitFor(() => expect(screen.getByTestId('run-notice')).toHaveTextContent(/run boom/i));
  });

  // Review finding (9th round): a request that fails carries no verdict, so it must
  // not leave the in-flight `-Infinity` seed suppressing the `target.lastForcedRunAt`
  // fallback — a window started in another tab would then not render here.
  //
  // Implemented by the *retirement effect*, not by special-casing the catch branch:
  // the seed is already expired, so the next targets refetch drops it. This test
  // pins that composition; an explicit `clearCooling()` in the catch was tried and
  // removed as dead code (the test passes without it).
  it('gives the server fallback back after a failed run request', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      // The request fails without saying anything about the cooldown.
      vi.spyOn(api, 'runTarget').mockRejectedValue(new Error('run boom'));
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/run boom/i);

      // Meanwhile another tab starts a manual run, which the server records on the
      // target. With the seed cleared, that window renders here immediately.
      vi.spyOn(api, 'getTargets').mockResolvedValue([
        { ...watching[0], lastForcedRunAt: Date.now() },
      ]);
      await act(async () => {
        streamEvent('Immediate cycle started elsewhere');
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/throttled to one per minute/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an in-flight starting notice while the run request is pending', async () => {
    mockApi(watching, 'authenticated');
    let resolveRun!: (v: { started: boolean; retryAfterMs: number }) => void;
    vi.spyOn(api, 'runTarget').mockReturnValue(
      new Promise((r) => {
        resolveRun = r;
      }),
    );
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /register now/i }));
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    // The button goes back to its idle label only once the POST settles, and the
    // card keeps a visible notice the whole time — no more one-frame flash.
    await waitFor(() =>
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/starting a manual check/i),
    );
    expect(screen.getByRole('button', { name: /… running/i })).toBeDisabled();
    resolveRun({ started: true, retryAfterMs: 60_000 });
    // An accepted run leaves no "starting…" claim behind; the card switches to
    // the cooldown notice — the cycle announces itself in the console.
    await waitFor(() =>
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/throttled to one per minute/i),
    );
  });

  // Review finding: after an *accepted* run the button stayed enabled for the
  // whole window, so the next click just bounced off the server with 'cooldown'.
  // Fake timers from the start (installing them mid-test leaves the card's
  // already-scheduled tick on the real clock) and `fireEvent` rather than
  // `userEvent`, whose own delay scheduling fights fake timers.
  it('disables Register now for the whole window after an accepted run', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      const runTarget = vi
        .spyOn(api, 'runTarget')
        .mockResolvedValue({ started: true, retryAfterMs: 60_000, lastForcedRunAt: Date.now() });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // flush the mount fetches
      });
      // Let the card's slow tick go stale before the click: with the interval
      // based refresh this used to render a nonsense "Try again in 80s" for one
      // frame (a server epoch minus a 20s-old `now`).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // flush the run POST
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 60s/i);
      expect(runTarget).toHaveBeenCalledTimes(1); // no second request was possible

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(screen.queryByTestId('run-notice')).toBeNull();
      expect(screen.getByRole('button', { name: /register now/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding: the cooldown notice was a frozen string. It must tick down.
  it('counts the cooldown notice down instead of freezing it', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      mockApi(watching, 'authenticated');
      vi.spyOn(api, 'runTarget').mockResolvedValue({
        started: false,
        reason: 'cooldown',
        retryAfterMs: 5_000,
        lastForcedRunAt: t0 - 55_000, // 5s of the 60s window left
      });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 5s/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 2s/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(screen.queryByTestId('run-notice')).toBeNull();
      expect(screen.getByRole('button', { name: /register now/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding (2nd round): `markCooling` stored the window's *start* where an
  // end instant is expected, which made its countdown dead. Now it is built from
  // the `retryAfterMs` duration, on the client's own clock.
  it('anchors the countdown to the retryAfterMs duration it was given', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      // No `lastForcedRunAt` at all: the duration must be enough on its own.
      vi.spyOn(api, 'runTarget').mockResolvedValue({
        started: false,
        reason: 'cooldown',
        retryAfterMs: 8_000,
      });
      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: /register now/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: /register now/i })).toBeDisabled();
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/Try again in 8s/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(screen.queryByTestId('run-notice')).toBeNull();
      expect(screen.getByRole('button', { name: /register now/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding (4th round): `cooldownRemainingMs` combined the local estimate
  // and the server epoch with `Math.max`, so the stored epoch always participated
  // — with a fast server clock that inflates the countdown, and a refetch landing
  // mid-window makes a live countdown jump upwards (45s → 180s).
  //
  // The precedence rule itself is pinned in `lib/api.test.ts`
  // ("uses the local estimate alone…", "keeps an expired local estimate
  // authoritative…"), which fails with the old `Math.max`. An earlier version of
  // this test drove the same scenario through the Dashboard, but the refetch it
  // relied on never actually fired, so the skewed value never reached the card and
  // the test passed for the wrong reason — it was deleted in favour of the unit test.
  /**
   * Q13 variant C. `/api/targets` failing left `targets.data` undefined, and the
   * page rendered its empty state for that — the same screen as "you watch
   * nothing". Nothing in the app read `resource.error`, so the user was told
   * their configuration was empty and, having no retry entry point, the natural
   * move was to re-add the courses (which `addTarget` happily duplicates).
   */
  it('shows an error bar with a working retry instead of the empty state when /api/targets fails', async () => {
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
    // The list stays unreadable until the user retries: the mocked event stream
    // makes the Dashboard refetch targets on mount, and a counter-based mock
    // would let that second call succeed and quietly erase the failure.
    let failing = true;
    let calls = 0;
    vi.spyOn(api, 'getTargets').mockImplementation(() => {
      calls += 1;
      return failing
        ? Promise.reject(new Error('GET /api/targets failed: 503'))
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
    renderDashboard();

    await waitFor(() =>
      expect(screen.getByText(/Could not load Course list/i)).toBeInTheDocument(),
    );
    // The defect was the *empty state* showing for a failed load.
    expect(screen.queryByText(/No courses watched/i)).toBeNull();
    expect(screen.queryByText(/Loading courses/i)).toBeNull();
    expect(screen.getByText(/GET \/api\/targets failed: 503/)).toBeInTheDocument();
    const callsBeforeRetry = calls;

    failing = false;
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    // Retry re-runs the fetch: the real course shows up and the bar goes away.
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load Course list/i)).toBeNull();
    expect(calls).toBeGreaterThan(callsBeforeRetry);
  });

  it('does not claim a target list is empty before it has been read', async () => {
    // A list that has not arrived yet is not an empty list. Showing "No courses
    // watched yet" during the initial fetch is the same lie as showing it after a
    // failure, and it also invites a duplicate re-add.
    let release!: (v: Awaited<ReturnType<typeof api.getTargets>>) => void;
    vi.spyOn(api, 'getTargets').mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
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
    renderDashboard();

    expect(screen.getByText(/Loading courses/i)).toBeInTheDocument();
    expect(screen.queryByText(/No courses watched/i)).toBeNull();

    await act(async () => {
      release([]);
    });
    // A list that really is empty renders the empty state, not a stuck spinner.
    await waitFor(() => expect(screen.getByText(/No courses watched/i)).toBeInTheDocument());
  });

  /**
   * `refetch` keeps the last successful `data` on failure, so a later blip means
   * "stale data + an error", not "no data". Replacing the whole list with the bar
   * would throw away information the client still holds — and it is inconsistent
   * with the ticker, which keeps rendering the stale budget snapshot under its
   * own bar.
   */
  it('keeps the (stale) course list on screen when a later refetch fails', async () => {
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
    let failing = false;
    vi.spyOn(api, 'getTargets').mockImplementation(() =>
      failing ? Promise.reject(new Error('refresh boom')) : Promise.resolve([watchTarget]),
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
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/COMP 551/)).toBeInTheDocument());

    // First read succeeded; the next one (a manual pause refetch) fails.
    failing = true;
    await userEvent.click(screen.getByRole('button', { name: /pause/i }));

    await waitFor(() =>
      expect(screen.getByText(/Could not load Course list/i)).toBeInTheDocument(),
    );
    // The bar is additive: the last good list survives underneath it.
    expect(screen.getByText(/COMP 551/)).toBeInTheDocument();
    expect(screen.queryByText(/No courses watched/i)).toBeNull();
    expect(screen.queryByText(/Loading courses/i)).toBeNull();
  });
});
