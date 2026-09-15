import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchStatus } from '@autoregister/shared';
import { api, errorMessage, isSessionNotReady, MANUAL_RUN_COOLDOWN_MS } from '../lib/api';
import { useData } from '../lib/DataContext';
import { CourseCard } from '../components/CourseCard';
import { Console } from '../components/Console';
import { ResourceError } from '../components/ResourceError';
import { SchedulerToggle } from '../components/SchedulerToggle';

/** How long a dropped-run verdict stays on the card. Long enough to read, short
 * enough that a stale claim cannot sit next to a "last poll just now" or a
 * REGISTERED badge — the client cannot reliably observe the end of the running
 * cycle it describes (see the retirement effect below). */
const NOTICE_TTL_MS = 30_000;

export default function Dashboard() {
  const { t: tr } = useTranslation();
  const { targets, session, scheduler, budget, stream } = useData();
  const { events, connected, clear } = stream;
  const [running, setRunning] = useState<Set<string>>(new Set());
  /** Verdicts of *dropped* manual runs, keyed by target id, each carrying the
   * moment it stops being shown. The cooldown verdict is deliberately not stored
   * here — it is derived from `coolingUntil` / `target.lastForcedRunAt` in
   * CourseCard, so it counts down and clears itself. */
  const [runNotice, setRunNotice] = useState<Record<string, { text: string; until: number }>>({});
  const [coolingUntil, setCoolingUntil] = useState<Record<string, number>>({});
  const [schedErr, setSchedErr] = useState<string>();
  const [clearErr, setClearErr] = useState<string>();
  const [schedBusy, setSchedBusy] = useState(false);

  // `targets`/`scheduler` are fresh objects each render; reach them through refs
  // so the callbacks below can be genuinely stable and always read fresh data.
  const targetsRef = useRef(targets);
  const schedulerRef = useRef(scheduler);
  const budgetRef = useRef(budget);
  const sessionRef = useRef(session);
  useEffect(() => {
    targetsRef.current = targets;
    schedulerRef.current = scheduler;
    budgetRef.current = budget;
    sessionRef.current = session;
  });

  // Live-refresh the daily budget + target states whenever a new log event
  // streams in (a query / register / status change always emits one), so the
  // budget counters in the top ticker and the course cards update on their own
  // instead of needing a manual page refresh. budget is shared via DataContext,
  // so refetching it here also updates the always-visible ticker in the shell.
  const lastEventId = events.length ? events[events.length - 1].id : undefined;
  useEffect(() => {
    if (!lastEventId) return;
    void budgetRef.current.refetch();
    void targetsRef.current.refetch();
  }, [lastEventId]);

  // A dropped "in progress" notice describes a cycle that was running *at that
  // moment*, so it must not outlive it — otherwise it ends up pinned next to a
  // REGISTERED / WAITLISTED / ERROR badge, which is the contradiction the notice
  // exists to remove.
  //
  // Rather than inferring "the cycle finished" from target state, the notice is
  // given a short lifetime (see NOTICE_TTL_MS) and retracted early on the two
  // unambiguous signals: the target's status changed (a terminal outcome), or the
  // target is gone (course deleted).
  //
  // Target-state inference was tried twice and failed in both directions:
  //   - `lastPolledAt` is written mid-cycle (after the query, before the cycle
  //     acts), so a click landing in the post-query phase captured an
  //     already-advanced value and the notice could never be retired;
  //   - `nextPollAt` is only rewritten by the exit paths that schedule another
  //     cycle, so the terminal outcomes (`registered`, `waitlisted`, a lost
  //     session → `paused`, `FAILURE_LIMIT` → `error`) left the notice pinned —
  //     while `PUT /api/settings` → `rescheduleWatching()` rewrote it without any
  //     cycle finishing and retired the notice early.
  // A bounded lifetime is honest about what the client can actually know here.
  useEffect(() => {
    const list = targets.data;
    if (!list) return;
    setRunNotice((s) => {
      const next: Record<string, { text: string; until: number }> = {};
      let changed = false;
      for (const [id, notice] of Object.entries(s)) {
        const target = list.find((t) => t.id === id);
        const retired = target === undefined || target.status !== 'watching';
        if (retired) changed = true;
        else next[id] = notice;
      }
      return changed ? next : s;
    });
  }, [targets.data]);

  // Retire a *local* cooldown estimate once it has elapsed.
  //
  // `cooldownRemainingMs` prefers the local estimate whenever it exists — that is
  // what keeps the countdown off the server's clock (see the precedence rule in
  // lib/api.ts) — but an estimate that never goes away would mean the server's
  // `lastForcedRunAt` fallback can never take over again for this target, so a run
  // started elsewhere (another tab, a reload of that page) would not render as a
  // cooldown here. Dropping the elapsed estimate restores the fallback without
  // reintroducing the skew: an expired local window must never be extended by a
  // server epoch, and an unexpired one still wins.
  //
  // Doubles as the display's cleanup pass, so it runs on each refetch (a newer
  // server window always arrives through one) rather than on a timer.
  useEffect(() => {
    if (!targets.data) return;
    const now = Date.now();
    setCoolingUntil((s) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const [id, until] of Object.entries(s)) {
        if (until <= now) changed = true;
        else next[id] = until;
      }
      return changed ? next : s;
    });
  }, [targets.data]);

  const onToggleMode = useCallback(async (id: string, next: WatchMode) => {
    await api.updateTarget(id, { mode: next });
    await targetsRef.current.refetch();
  }, []);

  // Clear the console: wipe the server-side log (so a reconnect won't re-seed the
  // old lines), then the locally-held events. Only clear locally once the server
  // call succeeds — otherwise surface the error and leave the log intact to retry.
  const onClearConsole = useCallback(
    async () => {
      // Own error state — must not touch (or be clobbered by) scheduler errors.
      setClearErr(undefined);
      try {
        await api.clearEvents();
        clear();
      } catch (e) {
        setClearErr(e instanceof Error ? e.message : tr('console.clearFailed'));
      }
    },
    [clear, tr],
  );

  // Per-course pause/resume. Resuming a single course also makes sure the engine
  // is running, otherwise flipping it to 'watching' alone wouldn't poll anything.
  const onTogglePolling = useCallback(
    async (id: string, next: WatchStatus) => {
      // No resuming/starting a task while logged out (the button is disabled too).
      if (next === 'watching' && sessionRef.current.data?.status !== 'authenticated') return;
      setSchedErr(undefined);
      let sessionRefused = false;
      try {
        await api.updateTarget(id, { status: next });
        if (next === 'watching') await api.startScheduler();
      } catch (e) {
        // The server refuses to start the engine without a usable session; show
        // that reason (localized) rather than a generic toggle failure.
        sessionRefused = isSessionNotReady(e);
        setSchedErr(sessionRefused ? tr('dashboard.loginToStart') : errorMessage(e));
      } finally {
        // Always reconcile the UI with the server's real state. A refusal means
        // the session resource is the thing that is wrong, so re-read it too —
        // otherwise this path keeps a green "Active" up after the server has
        // explicitly said it cannot poll.
        await Promise.all([
          targetsRef.current.refetch(),
          schedulerRef.current.refetch(),
          sessionRefused ? sessionRef.current.refetch() : Promise.resolve(),
        ]);
      }
    },
    [tr],
  );

  const onRun = useCallback(
    async (id: string) => {
      // The POST only reports whether *this request* was accepted; the cycle
      // itself keeps running server-side and reports through the event stream.
      // So `running` covers the request round-trip, the cooldown is derived by
      // the card, and `runNotice` carries the verdict of a *dropped* request —
      // without that, a drop was indistinguishable from an accepted run and the
      // button just flashed (audit Q16/Q23/Q60).
      const clearNotice = () =>
        setRunNotice((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        });
      const drop = (notice: string) =>
        setRunNotice((s) => ({ ...s, [id]: { text: notice, until: Date.now() + NOTICE_TTL_MS } }));
      // `coolingUntil` is an end instant on *this* clock, so it is built from a
      // duration (`retryAfterMs`, anchored to the moment the answer arrived)
      // rather than from the server's `lastForcedRunAt` epoch: mixing a server
      // epoch with `Date.now()` would make the countdown sensitive to clock skew
      // (review finding). The server's timestamp stays informational, and
      // `target.lastForcedRunAt` only covers a page that never saw a response.
      const markCooling = (retryAfterMs: number) =>
        setCoolingUntil((s) => ({ ...s, [id]: Date.now() + retryAfterMs }));
      // Seed a definitely-expired local estimate before awaiting, so the card stops
      // consulting the stored `lastForcedRunAt` (which may be stale or skewed) for
      // the duration of the request. `-Infinity` rather than a value relative to
      // `Date.now()`: the card compares against its own `now`, which can be seconds
      // behind, and a near-past seed would read as an *active* cooldown there —
      // freezing a bogus countdown over the real verdict and disabling the button.
      markCooling(-Infinity);
      setRunning((s) => new Set(s).add(id));
      drop(tr('run.starting')); // in-flight hint; replaced by the verdict below
      try {
        const res = await api.runTarget(id);
        if (res.started) {
          // Accepted: the cycle announces itself in the console. Start the
          // cooldown from the duration the server just reported, so the button is
          // disabled for the whole window instead of letting the next click
          // bounce off the server (review finding).
          markCooling(res.retryAfterMs ?? MANUAL_RUN_COOLDOWN_MS);
          clearNotice();
          return;
        }
        if (res.reason === 'in progress') {
          drop(tr('run.inProgress'));
        } else if (res.reason === 'cooldown') {
          // The notice itself is derived from the cooldown in CourseCard so it
          // counts down and disappears when the window ends.
          //
          // The fallback is `-Infinity`, not `0`: a server that reported a cooldown
          // without a duration tells us nothing, and `Date.now()` there would render
          // as a spurious "1s left" against a stale `now` (the same
          // stale-tick-versus-fresh-`Date.now()` trap as the in-flight seed). An
          // expired estimate keeps the local estimate authoritative — so the server
          // fallback stays suppressed — while showing no countdown.
          markCooling(res.retryAfterMs ?? -Infinity);
          clearNotice();
        } else {
          // Unknown reason (a status change, or a future value such as 'queued'):
          // say so neutrally instead of implying the course stopped being watched.
          drop(tr('run.dropped', { reason: res.reason ?? 'unknown' }));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        drop(tr('run.failed', { reason }));
        // The in-flight `-Infinity` seed is deliberately left in place: it is
        // already expired, so the retirement effect above drops it on the next
        // targets refetch and `target.lastForcedRunAt` is consulted again. Clearing
        // it here as well would be dead code (verified: the "gives the server
        // fallback back after a failed run request" test passes without it).
      } finally {
        setRunning((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [tr],
  );

  const schedBusyRef = useRef(false);
  const onToggleScheduler = useCallback(async () => {
    if (schedBusyRef.current) return; // ignore a click while a toggle is already in flight
    // Drive the action off whether anything is actually being watched (so it
    // matches the button label), not the raw engine flag: when every course is
    // paused/error/done, the master button is "Start all".
    const anyWatching = (targetsRef.current.data ?? []).some((t) => t.status === 'watching');
    const loggedIn = sessionRef.current.data?.status === 'authenticated';
    // There is nothing to stop and no session to poll with. Say so instead of
    // returning silently: a click that does nothing and explains nothing is the
    // same dead end the server-side refusal exists to remove.
    if (!anyWatching && !loggedIn) {
      setSchedErr(tr('dashboard.loginToStart'));
      return;
    }
    schedBusyRef.current = true;
    setSchedBusy(true);
    setSchedErr(undefined);
    const sch = schedulerRef.current;
    try {
      if (anyWatching) await api.stopAll();
      else await api.startAll();
      await Promise.all([sch.refetch(), targetsRef.current.refetch()]);
    } catch (e) {
      setSchedErr(isSessionNotReady(e) ? tr('dashboard.loginToStart') : errorMessage(e));
      if (isSessionNotReady(e)) {
        // The server just told us the session is unusable — stop showing it as
        // active. Re-read the session as well as the engine state.
        await Promise.all([sch.refetch(), targetsRef.current.refetch(), sessionRef.current.refetch()]);
      }
    } finally {
      schedBusyRef.current = false;
      setSchedBusy(false);
    }
  }, [tr]);

  const list = targets.data ?? [];
  const anyWatching = list.some((t) => t.status === 'watching');
  const sessionStatus = session.data?.status ?? 'unknown';
  const loggedIn = sessionStatus === 'authenticated';
  const sessionDown = sessionStatus === 'logged-out' || sessionStatus === 'unknown';
  const engineRunning = scheduler.data?.running ?? false;

  return (
    <>
      {sessionDown && <div className="banner">{tr('dashboard.sessionBanner')}</div>}

      <div className="grid">
        <div>
          <div className="col-h">
            <h2 className="serif">{tr('dashboard.watchedCourses')}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* The first column's dot is about stored course states, which is
                  what the master button acts on. It says nothing about the
                  engine (`POST /api/scheduler/start` can have been refused, or
                  `stop()` called), and `GET /api/scheduler` was already being
                  fetched without ever being rendered — so show it, otherwise
                  "started" has no visible confirmation at all. */}
              <span className="toggle" data-engine={engineRunning ? 'running' : 'stopped'}>
                <span className={`dot ${engineRunning ? 'dot-ok' : ''}`} />
                {engineRunning ? tr('dashboard.engineRunning') : tr('dashboard.engineStopped')}
              </span>
              <SchedulerToggle
                running={anyWatching}
                onStart={onToggleScheduler}
                onStop={onToggleScheduler}
                busy={schedBusy}
                canStart={loggedIn}
              />
            </div>
          </div>
          {schedErr && <div className="errbar">{schedErr}</div>}
          {/* Branch order matters, and this is the defect: `list.length === 0`
              cannot tell "you watch nothing" from "we could not read your list".
              - no data AND an error: the bar alone. Showing the empty state here
                is the screen that invites a duplicate re-add. Checked on `error`
                explicitly rather than inferred from `!settled`, because a failed
                read *is* settled.
              - no data, no error, still loading: the loading state.
              - read, and the list really is empty: the empty state.
              - read, and there is a list: the list. A failed *refetch* lands
                here with its (stale) data intact, under the bar — `refetch`
                does not roll `data` back, and hiding the list would throw away
                what the client still holds. */}
          <ResourceError resource={targets} label={tr('dashboard.loadFailedLabel')} />
          {targets.data === undefined && targets.error ? null : !targets.settled ? (
            <div className="empty glass">{tr('dashboard.loading')}</div>
          ) : targets.data !== undefined && list.length === 0 ? (
            <div className="empty glass">{tr('dashboard.empty')}</div>
          ) : (
            <div className="cards">
              {list.map((t) => (
                <CourseCard
                  key={t.id}
                  target={t}
                  onToggleMode={onToggleMode}
                  onRun={onRun}
                  onTogglePolling={onTogglePolling}
                  running={running.has(t.id)}
                  runNotice={runNotice[t.id]}
                  coolingUntil={coolingUntil[t.id]}
                  loggedIn={loggedIn}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="col-h">
            <h2 className="serif">{tr('dashboard.liveConsole')}</h2>
          </div>
          {clearErr && <div className="errbar">{clearErr}</div>}
          <Console events={events} connected={connected} onClear={onClearConsole} />
        </div>
      </div>
    </>
  );
}
