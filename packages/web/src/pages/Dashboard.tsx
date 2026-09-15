import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchStatus } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { useEventStream } from '../lib/useEventStream';
import { CourseCard } from '../components/CourseCard';
import { Console } from '../components/Console';
import { SchedulerToggle } from '../components/SchedulerToggle';

export default function Dashboard() {
  const { t: tr } = useTranslation();
  const { targets, session, scheduler, budget } = useData();
  const { events, connected, clear } = useEventStream();
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [schedErr, setSchedErr] = useState<string>();
  const [schedNote, setSchedNote] = useState<string>();
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
  //
  // A per-target guard, because the resume route is deliberately NOT idempotent: it
  // returns 409 for a target that is not `paused`/`error`, so a double-click would
  // surface "cannot resume a target in status watching" as a user-facing error for what
  // is really just the first click succeeding. (The old PATCH-based path was idempotent,
  // so this is a regression the 409 guard introduced.)
  const busyTargetsRef = useRef(new Set<string>());
  const onTogglePolling = useCallback(
    async (id: string, next: WatchStatus) => {
      // No resuming/starting a task while logged out (the button is disabled too).
      if (next === 'watching' && sessionRef.current.data?.status !== 'authenticated') return;
      if (busyTargetsRef.current.has(id)) return; // a click for this target is already in flight
      busyTargetsRef.current.add(id);
      setSchedErr(undefined);
      setSchedNote(undefined);
      try {
        // POST /api/targets/:id/resume flips the status AND starts the engine, so
        // a revived course polls immediately instead of needing a second click.
        if (next === 'watching') await api.resumeTarget(id);
        else await api.updateTarget(id, { status: next });
      } catch (e) {
        setSchedErr(e instanceof Error ? e.message : tr('dashboard.schedToggleFailed'));
      } finally {
        busyTargetsRef.current.delete(id);
        // Always reconcile the UI with the server's real state.
        await Promise.all([targetsRef.current.refetch(), schedulerRef.current.refetch()]);
      }
    },
    [tr],
  );

  // Revive one target out of the 'error' terminal state (the three-strikes
  // breaker parked it). Without this the only way out of 'error' was deleting
  // and re-creating the course.
  const onResume = useCallback(
    async (id: string) => {
      if (sessionRef.current.data?.status !== 'authenticated') return;
      // Same per-target guard as `onTogglePolling`: the route 409s on a target that is
      // already watching, so a double-click must not surface that as an error.
      if (busyTargetsRef.current.has(id)) return;
      busyTargetsRef.current.add(id);
      setSchedErr(undefined);
      setSchedNote(undefined);
      try {
        await api.resumeTarget(id);
      } catch (e) {
        setSchedErr(e instanceof Error ? e.message : tr('dashboard.schedToggleFailed'));
      } finally {
        busyTargetsRef.current.delete(id);
        await Promise.all([targetsRef.current.refetch(), schedulerRef.current.refetch()]);
      }
    },
    [tr],
  );

  const onRun = useCallback(async (id: string) => {
    setRunning((s) => new Set(s).add(id));
    try {
      await api.runTarget(id);
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const schedBusyRef = useRef(false);
  const onToggleScheduler = useCallback(async () => {
    if (schedBusyRef.current) return; // ignore a click while a toggle is already in flight
    // The master switch follows the ENGINE's real state (`GET /api/scheduler`),
    // never "is any course in the list watching". Those are different things:
    // freshly added courses (and courses restored from disk) default to
    // 'watching' while the engine is stopped, so keying the action off the
    // course list made the very first click a STOP-all — the opposite of what
    // the button promised, and the reason a first "Start" appeared to do nothing
    // until the whole app was restarted.
    const isRunning = schedulerRef.current.data?.running === true;
    const loggedIn = sessionRef.current.data?.status === 'authenticated';
    if (!isRunning && !loggedIn) return; // can't "Start all" while logged out
    schedBusyRef.current = true;
    setSchedBusy(true);
    setSchedErr(undefined);
    setSchedNote(undefined);
    const sch = schedulerRef.current;
    try {
      if (isRunning) {
        await api.stopAll();
      } else {
        const res = await api.startAll();
        // Give the user something visible: the engine is now running, and this
        // is what happened to their courses (revived / resumed / left alone).
        const counts = { resumed: res.resumed, recovered: res.recovered, skipped: res.skipped };
        setSchedNote(tr('dashboard.startedAll', counts));
      }
      await Promise.all([sch.refetch(), targetsRef.current.refetch()]);
    } catch (e) {
      setSchedErr(e instanceof Error ? e.message : tr('dashboard.schedToggleFailed'));
    } finally {
      schedBusyRef.current = false;
      setSchedBusy(false);
    }
  }, [tr]);

  const list = targets.data ?? [];
  const watchingCount = list.filter((t) => t.status === 'watching').length;
  const sessionStatus = session.data?.status ?? 'unknown';
  const loggedIn = sessionStatus === 'authenticated';
  const sessionDown = sessionStatus === 'logged-out' || sessionStatus === 'unknown';
  // Engine actually ticking? Distinct from "courses are listed as watching".
  const engineRunning = scheduler.data?.running === true;
  // `running: false` while the first `GET /api/scheduler` is still in flight means
  // "unknown", not "stopped" — acting on it would offer "Start all" against an engine
  // that may already be up, which also revives any `error` targets the user deliberately
  // left parked. The toggle refuses to act until the real state is known.
  const engineStateUnknown = scheduler.loading && scheduler.data === undefined;
  // Courses claim to be watched but nothing is polling them — exactly the state
  // the master switch used to mislabel as "running".
  const idleButWatching = watchingCount > 0 && !engineRunning;

  return (
    <>
      {sessionDown && <div className="banner">{tr('dashboard.sessionBanner')}</div>}

      <div className="grid">
        <div>
          <div className="col-h">
            <h2 className="serif">{tr('dashboard.watchedCourses')}</h2>
            <SchedulerToggle
              running={engineRunning}
              onStart={onToggleScheduler}
              onStop={onToggleScheduler}
              busy={schedBusy}
              canStart={loggedIn}
              loading={engineStateUnknown}
            />
          </div>
          {schedErr && <div className="errbar">{schedErr}</div>}
          {schedNote && <div className="notice">{schedNote}</div>}
          {idleButWatching && <div className="banner">{tr('dashboard.engineOffHint')}</div>}
          {list.length === 0 ? (
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
                  onResume={onResume}
                  running={running.has(t.id)}
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
