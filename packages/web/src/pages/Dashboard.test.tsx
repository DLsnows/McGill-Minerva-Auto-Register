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
      [{ id: 't1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 }],
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

  // ── manual run feedback (audit Q16/Q60/Q23) ────────────────────────────────
  // Before the fix `onRun` awaited api.runTarget and cleared the running state in
  // `finally`: a dropped request produced no visible change at all, so these
  // tests fail against the old behaviour (no status element ever renders).

  const watching = [
    { id: 'w1', label: 'COMP 551', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto' as const, status: 'watching' as const, createdAt: 0 },
  ];

  it('tells the user when a manual run was dropped because one is already running', async () => {
    vi.useFakeTimers();
    try {
      mockApi(watching, 'authenticated');
      const t0 = Date.now();
      // Real shape: the server echoes the window start on every 200 body.
      vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'in progress', lastForcedRunAt: t0 });
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

  // Review finding (5th round): the "already running" notice was written once and
  // never retired, so once the cycle finished the card showed it next to a fresh
  // "last poll just now" — two lines contradicting each other.
  it('retires the "already running" notice once the cycle it described has finished', async () => {
    mockApi(watching, 'authenticated');
    vi.spyOn(api, 'runTarget').mockResolvedValue({ started: false, reason: 'in progress' });
    const getTargets = vi.spyOn(api, 'getTargets').mockResolvedValue(watching);
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /register now/i }));
    await userEvent.click(screen.getByRole('button', { name: /register now/i }));
    await waitFor(() => expect(screen.getByTestId('run-notice')).toHaveTextContent(/already running/i));

    // The cycle that the notice described finishes: its log line arrives on the
    // live stream, the Dashboard refetches targets, and the refreshed target
    // reports a poll that happened after the drop — so the drop is history.
    getTargets.mockResolvedValue([{ ...watching[0], lastPolledAt: Date.now() }]);
    streamEvent('cycle finished');
    await waitFor(() => expect(screen.queryByTestId('run-notice')).toBeNull());
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
      expect(screen.getByTestId('run-notice')).toHaveTextContent(/This check was not started.*target is paused/i),
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
    await waitFor(() => expect(screen.getByTestId('run-notice')).toHaveTextContent(/starting a manual check/i));
    expect(screen.getByRole('button', { name: /… running/i })).toBeDisabled();
    resolveRun({ started: true, retryAfterMs: 60_000 });
    // An accepted run leaves no "starting…" claim behind; the card switches to
    // the cooldown notice — the cycle announces itself in the console.
    await waitFor(() => expect(screen.getByTestId('run-notice')).toHaveTextContent(/throttled to one per minute/i));
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
});
