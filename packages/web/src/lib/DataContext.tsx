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

/** The live event stream, owned once by the provider and shared with every page. */
export interface EventStreamValue {
  events: LogEvent[];
  connected: boolean;
  clear: () => void;
}

export interface DataContextValue {
  targets: Resource<WatchTarget[]>;
  session: Resource<SessionInfo>;
  budget: Resource<BudgetSnapshot>;
  settings: Resource<Settings>;
  scheduler: Resource<SchedulerState>;
  /** The one `/api/stream` subscription for this tab (see DataProvider). */
  stream: EventStreamValue;
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
 * refresh is what ends the UI's lie either way.
 *
 * Throttling is *deferring*, never dropping: an event that lands inside the
 * window schedules the refresh for the end of it. Dropping it would mean one
 * unrelated error could swallow the eviction warning that follows it a moment
 * later, leaving the UI lying until some later event happened to arrive. */
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
 * on (re)connect. A replay is classified by **id identity**, not by any ordering
 * derived from the id: production ids are `randomUUID()` (the store and
 * `sessionEvent` both use it), so no numeric tail of them is a sequence number —
 * a watermark built from one classifies events at random, both missing real
 * evictions and firing pointless probes. Ids this client has already been handed
 * are history and are ignored (otherwise merely opening the console after any past
 * failure would fire a real navigation to Minerva); a relevant line seen for the
 * first time in a replay happened during a disconnect and is news — the session
 * may have died while the socket was down, and no live line is coming for it.
 */
export function useSessionRefreshFromEvents(
  events: LogEvent[],
  session: Resource<SessionInfo>,
  snapshotTick = 0,
): void {
  const lastRelevantId = lastSessionRelevantEventId(events);
  const lastRefreshedId = useRef<string | undefined>(undefined);
  const lastRefreshedAt = useRef(0);
  /** Every event id already delivered to this client (see the doc comment). */
  const seenIds = useRef(new Set<string>());
  const lastSnapshotTick = useRef(snapshotTick);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The deferred branch reads the trigger through a ref so the timer always sees
  // the newest relevant id rather than the one captured when it was armed.
  const lastRelevantIdRef = useRef(lastRelevantId);
  lastRelevantIdRef.current = lastRelevantId;
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
    const wait = SESSION_REFRESH_THROTTLE_MS - (Date.now() - lastRefreshedAt.current);
    if (wait > 0) {
      // Inside the window: defer, do not drop. The deferred call is idempotent
      // (a newer event re-arms it and only one timer is ever pending).
      if (pending.current === undefined) {
        pending.current = setTimeout(() => {
          pending.current = undefined;
          const id = lastRelevantIdRef.current;
          if (id === undefined || id === lastRefreshedId.current) return;
          lastRefreshedId.current = id;
          lastRefreshedAt.current = Date.now();
          void refetchRef.current();
        }, wait);
      }
      return;
    }
    lastRefreshedId.current = lastRelevantId;
    lastRefreshedAt.current = Date.now();
    void refetchRef.current();
  }, [lastRelevantId]);

  useEffect(
    () => () => {
      clearTimeout(pending.current);
      pending.current = undefined;
    },
    [],
  );

  // Every event the app has already been handed, relevant or not — the basis for
  // deciding, on a reconnect, whether the replay carries anything new.
  useEffect(() => {
    for (const e of events) seenIds.current.add(e.id);
  }, [events]);

  // A (re)connect replays the server's history — decide what in it is news.
  useEffect(() => {
    if (snapshotTick === lastSnapshotTick.current) return;
    lastSnapshotTick.current = snapshotTick;
    const hasUnseen = events.some(
      (e) => SESSION_RELEVANT_LEVELS.has(e.level) && !seenIds.current.has(e.id),
    );
    if (!hasUnseen) return;
    // The replayed lines are in `seenIds` by the time the next render runs, so
    // only a *later* live event counts as new again. Resetting the freshness clock
    // is deliberate: without it an event that fired just before the drop would
    // throttle this refresh away.
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

  // One stream subscription for the whole tab. The session must be re-checked
  // from anywhere in the app (the user may never open the Dashboard), so the
  // provider — not a page — owns the socket; pages read it back through `useData`
  // instead of opening a second connection to the same events.
  // `snapshotTick` increments whenever the server replays its history on
  // (re)connect, which is how the refresh tells old lines from live ones.
  const [snapshotTick, setSnapshotTick] = useState(0);
  const onSeed = useCallback(() => setSnapshotTick((n) => n + 1), []);
  const { events, connected, clear } = useEventStream(500, onSeed);
  useSessionRefreshFromEvents(events, session, snapshotTick);
  const stream = useMemo<EventStreamValue>(
    () => ({ events, connected, clear }),
    [events, connected, clear],
  );

  // Each resource is referentially stable until its own data changes (see
  // useResource), so this memo only produces a new value when something changed.
  const value = useMemo<DataContextValue>(
    () => ({ targets, session, budget, settings, scheduler, stream }),
    [targets, session, budget, settings, scheduler, stream],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
}
