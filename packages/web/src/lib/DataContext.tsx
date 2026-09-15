import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LogEvent, Settings, WatchTarget } from '@autoregister/shared';
import { api, type BudgetSnapshot, type SchedulerState, type SessionInfo } from './api';
import { useResource, type Resource } from './useResource';
import { useEventStream } from './useEventStream';

export interface DataContextValue {
  targets: Resource<WatchTarget[]>;
  session: Resource<SessionInfo>;
  budget: Resource<BudgetSnapshot>;
  settings: Resource<Settings>;
  scheduler: Resource<SchedulerState>;
}

/** Log levels that mean "something is wrong in the automation right now". A
 * dropped session always lands here (the scheduler pauses the targets and logs
 * `Session not active …` at warn level), which is what makes the session
 * resource refreshable without probing on a timer. */
const SESSION_RELEVANT_LEVELS: ReadonlySet<LogEvent['level']> = new Set(['warn', 'error']);

/** Minimum spacing between event-driven session refetches.
 *
 * Every `GET /api/session` that reports 'authenticated' triggers a lazy live
 * check that really navigates the automation browser to Minerva
 * (`SessionManager.isLoggedIn` → `page.goto(PROTECTED_PROBE_URL)`). Refetching
 * once per warn/error line of a failure storm would turn one dead session into a
 * burst of real requests against the school's server — exactly the pacing
 * violation this fix must not introduce. One coalesced refresh per window is
 * enough: the session is a slowly-changing, all-or-nothing fact, and a single
 * refresh is what ends the UI's lie either way. */
export const SESSION_REFRESH_THROTTLE_MS = 10_000;

/** The id of the most recent warn/error event, or undefined when there is none.
 * Used as the effect trigger so several lines from one cycle collapse into a
 * single refetch (the value only changes when a new qualifying line arrives). */
export function lastSessionRelevantEventId(events: LogEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (SESSION_RELEVANT_LEVELS.has(events[i].level)) return events[i].id;
  }
  return undefined;
}

/**
 * Event-driven refresh of the session resource.
 *
 * Root cause this exists for: the session resource was fetched once at mount and
 * never again, while the server keeps detecting (and pausing targets on) an
 * expired session. The UI therefore kept showing a green "Active" dot and
 * "Authenticated — automation can run" long after polling had stopped.
 *
 * Driven by the event stream (sub-second latency), never by a timer: the point of
 * the fix is to stop the UI from lying, not to start probing Minerva on a
 * schedule.
 *
 * `snapshotTick` increments every time the server replays its history (`recent`)
 * on (re)connect. A replay is handled by *identity*, not by trust: an event whose
 * id this client has already received is history and is ignored (otherwise merely
 * opening the console after any past failure would fire a real navigation to
 * Minerva), but a relevant event that arrives in a replay **while the app is
 * running** happened during a disconnect and is genuinely news — the session may
 * have died while the socket was down, and no live line is coming for it. Those
 * trigger exactly one refresh, and the freshness throttle is reset so the refresh
 * cannot be swallowed by an unrelated event fired just before the drop.
 */
export function useSessionRefreshFromEvents(
  events: LogEvent[],
  session: Resource<SessionInfo>,
  snapshotTick = 0,
): void {
  const lastRelevantId = lastSessionRelevantEventId(events);
  const lastRefreshedId = useRef<string | undefined>(undefined);
  const lastRefreshedAt = useRef(0);
  /** Relevant event ids already delivered to this client. */
  const seenRelevant = useRef(new Set<string>());
  const lastSnapshotTick = useRef(snapshotTick);
  // Read the latest refetch through a ref so a new event never needs the (fresh
  // object every render) resource as an effect dependency.
  const refetchRef = useRef(session.refetch);
  useEffect(() => {
    refetchRef.current = session.refetch;
  });

  useEffect(() => {
    if (lastRelevantId === undefined) return;
    // Same event seen again (re-render, reconnect) — nothing new to react to.
    if (lastRelevantId === lastRefreshedId.current) return;
    const now = Date.now();
    if (now - lastRefreshedAt.current < SESSION_REFRESH_THROTTLE_MS) return;
    lastRefreshedId.current = lastRelevantId;
    lastRefreshedAt.current = now;
    void refetchRef.current();
  }, [lastRelevantId]);

  // Every event the app has already been handed, relevant or not — the basis for
  // deciding, on a reconnect, whether the replay carries anything new.
  useEffect(() => {
    for (const e of events) seenRelevant.current.add(e.id);
  }, [events]);

  // A (re)connect replays the server's history — decide what in it is news.
  useEffect(() => {
    if (snapshotTick === lastSnapshotTick.current) return;
    lastSnapshotTick.current = snapshotTick;
    const hasUnseen = events.some(
      (e) => SESSION_RELEVANT_LEVELS.has(e.level) && !seenRelevant.current.has(e.id),
    );
    if (!hasUnseen) return;
    // The replayed lines have already been delivered (they are in `seenRelevant`
    // by the time the next render runs), so only a *later* live event should count
    // as new again. Resetting the freshness clock is deliberate: without it an
    // event that fired just before the drop would throttle this refresh away.
    lastRefreshedId.current = lastRelevantId;
    lastRefreshedAt.current = Date.now();
    void refetchRef.current();
  }, [snapshotTick, events, lastRelevantId]);
}
const DataContext = createContext<DataContextValue | null>(null);

/** Loads the shared app resources once and shares them with every page. */
export function DataProvider({ children }: { children: ReactNode }) {
  const targets = useResource(() => api.getTargets());
  const session = useResource(() => api.getSession());
  const budget = useResource(() => api.getBudget());
  const settings = useResource(() => api.getSettings());
  const scheduler = useResource(() => api.getScheduler());

  // The session must be re-checked from anywhere in the app (the user may never
  // open the Dashboard), so the provider — not a page — subscribes to the stream.
  // `snapshotTick` increments whenever the server replays its history on
  // (re)connect, which is how the refresh tells old lines from live ones.
  const [snapshotTick, setSnapshotTick] = useState(0);
  const onSeed = useCallback(() => setSnapshotTick((n) => n + 1), []);
  const { events } = useEventStream(500, onSeed);
  useSessionRefreshFromEvents(events, session, snapshotTick);

  // Each resource is referentially stable until its own data changes (see
  // useResource), so this memo only produces a new value when something changed.
  const value = useMemo<DataContextValue>(
    () => ({ targets, session, budget, settings, scheduler }),
    [targets, session, budget, settings, scheduler],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
}
