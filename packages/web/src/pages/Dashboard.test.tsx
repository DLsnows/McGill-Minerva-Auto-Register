import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        lastForcedRunAt: Date.now() - 15_000,
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
});
