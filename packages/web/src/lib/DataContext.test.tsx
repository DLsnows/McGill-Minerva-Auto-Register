import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { LogEvent } from '@autoregister/shared';
import {
  DataProvider,
  SESSION_REFRESH_THROTTLE_MS,
  lastSessionRelevantEventId,
  useData,
} from './DataContext';
import { api } from './api';
import { ZERO_BUDGET } from './budget-fixture';
import { installFakeWebSocket, lastFakeSocket } from '../test-setup';

function Probe() {
  const { targets, scheduler, session } = useData();
  return (
    <div>
      <span>targets:{targets.data?.length ?? '-'}</span>
      <span>running:{String(scheduler.data?.running ?? '-')}</span>
      <span>session:{session.data?.status ?? '-'}</span>
    </div>
  );
}

function mockResources() {
  vi.spyOn(api, 'getTargets').mockResolvedValue([
    { id: 't1', term: '202701', subject: 'COMP', courseNumber: '551', targetCrn: '2347', mode: 'auto', status: 'watching', createdAt: 0 },
  ]);
  vi.spyOn(api, 'getBudget').mockResolvedValue(ZERO_BUDGET);
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    pollIntervalMinutes: 30, jitterMinutes: 3, queryBudget: 100, registerBudget: 20,
    notify: { desktop: true, sound: true, email: false },
  });
  vi.spyOn(api, 'getScheduler').mockResolvedValue({ running: true });
}

let eventSeq = 0;
function event(level: LogEvent['level'], message = 'x'): LogEvent {
  eventSeq += 1;
  return { id: `e${eventSeq}`, ts: eventSeq, level, message };
}

/** Deliver a live event frame to the socket DataProvider opened. */
function streamEvent(e: LogEvent) {
  act(() => lastFakeSocket()?.emit({ type: 'event', event: e }));
}

beforeEach(() => {
  installFakeWebSocket();
  eventSeq = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('DataProvider', () => {
  it('loads and exposes the shared resources', async () => {
    mockResources();
    vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });

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

/**
 * Q7 regression. The session resource used to be fetched once at mount and never
 * again, so after Minerva evicted the session the UI kept rendering a green
 * "Active" dot while the server had already paused every target. The client must
 * re-read the session when the server says something went wrong — and must NOT do
 * it on a timer, because `GET /api/session` really navigates to Minerva.
 */
describe('DataProvider session truth (Q7)', () => {
  it('re-reads the session when a warn event arrives, and the UI follows the server', async () => {
    mockResources();
    const getSession = vi
      .spyOn(api, 'getSession')
      .mockResolvedValueOnce({ status: 'authenticated' })
      .mockResolvedValue({ status: 'logged-out' });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(screen.getByText('session:authenticated')).toBeInTheDocument());
    expect(getSession).toHaveBeenCalledTimes(1);

    // The scheduler detects the eviction and logs it at warn level.
    streamEvent(event('warn', 'Session not active (logged out / evicted) — paused; please re-login'));

    await waitFor(() => expect(screen.getByText('session:logged-out')).toBeInTheDocument());
    expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('re-reads the session on an error event too', async () => {
    mockResources();
    const getSession = vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'logged-out' });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));

    streamEvent(event('error', 'Query failed: boom'));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('does not re-read the session for routine info/ok/action events', async () => {
    mockResources();
    const getSession = vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'authenticated' });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));

    streamEvent(event('info', 'No opening — full'));
    streamEvent(event('ok', 'Registered COMP 551!'));
    streamEvent(event('action', 'Opening found'));
    // Give any (incorrect) effect a chance to run before asserting.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('throttles a failure storm into one refresh per window', async () => {
    mockResources();
    const getSession = vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'logged-out' });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));

    // A single broken cycle can emit several warn/error lines in a row. Each one
    // maps to a real navigation to Minerva server-side, so they must coalesce.
    streamEvent(event('warn', 'first'));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    streamEvent(event('error', 'second'));
    streamEvent(event('warn', 'third'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getSession).toHaveBeenCalledTimes(2);

    // Once the window elapses the next warn is acted on again.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + SESSION_REFRESH_THROTTLE_MS + 1);
    streamEvent(event('warn', 'fourth'));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(3));
  });

  it('ignores the reconnect snapshot but still acts on events after it', async () => {
    mockResources();
    const getSession = vi.spyOn(api, 'getSession').mockResolvedValue({ status: 'logged-out' });

    render(
      <DataProvider>
        <Probe />
      </DataProvider>,
    );
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));

    // `recent` is what the server replays on every (re)connect — it can contain
    // hours-old warn lines that say nothing about the session right now.
    act(() =>
      lastFakeSocket()?.emit({
        type: 'recent',
        events: [event('warn', 'stale warning from a previous session'), event('error', 'stale error')],
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(getSession).toHaveBeenCalledTimes(1);

    // A *new* line after the snapshot is live news and must still refresh.
    streamEvent(event('warn', 'Session not active (logged out / evicted)'));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('lastSessionRelevantEventId picks the newest warn/error line only', () => {
    expect(lastSessionRelevantEventId([])).toBeUndefined();
    expect(lastSessionRelevantEventId([event('info'), event('ok')])).toBeUndefined();
    const warn = event('warn');
    expect(lastSessionRelevantEventId([event('info'), warn, event('ok')])).toBe(warn.id);
  });
});
