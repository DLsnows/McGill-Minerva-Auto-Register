import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchStatus } from '@autoregister/shared';
import { api, MANUAL_RUN_COOLDOWN_MS } from '../lib/api';
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
  /** Verdicts of *dropped* manual runs, keyed by target id. The cooldown verdict
   * is deliberately not stored here — it is derived from `coolingUntil` /
   * `target.lastForcedRunAt` in CourseCard so it counts down and clears. */
  const [runNotice, setRunNotice] = useState<Record<string, string>>({});
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
      try {
        await api.updateTarget(id, { status: next });
        if (next === 'watching') await api.startScheduler();
      } catch (e) {
        setSchedErr(e instanceof Error ? e.message : tr('dashboard.schedToggleFailed'));
      } finally {
        // Always reconcile the UI with the server's real state.
        await Promise.all([targetsRef.current.refetch(), schedulerRef.current.refetch()]);
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
      const drop = (notice: string) => setRunNotice((s) => ({ ...s, [id]: notice }));
      // `coolingUntil` is an *end* timestamp. Prefer the server's start time, so
      // the window is rendered from the clock that enforces it (client skew can
      // neither stretch nor shrink it); a cooldown rejection that reports only
      // the remaining time falls back to the local clock. (Review finding: this
      // used to store the *start* time, which made the local fallback dead.)
      const markCooling = (lastForcedRunAt: number | undefined, retryAfterMs: number) =>
        setCoolingUntil((s) => ({
          ...s,
          [id]: lastForcedRunAt !== undefined ? lastForcedRunAt + MANUAL_RUN_COOLDOWN_MS : Date.now() + retryAfterMs,
        }));
      setRunning((s) => new Set(s).add(id));
      drop(tr('run.starting')); // in-flight hint; replaced by the verdict below
      try {
        const res = await api.runTarget(id);
        if (res.started) {
          // Accepted: the cycle announces itself in the console. Start the
          // cooldown from the timestamp the server just recorded, so the button
          // is disabled for the whole window instead of letting the next click
          // bounce off the server (review finding).
          markCooling(res.lastForcedRunAt, MANUAL_RUN_COOLDOWN_MS);
          clearNotice();
          return;
        }
        if (res.reason === 'in progress') {
          drop(tr('run.inProgress'));
        } else if (res.reason === 'cooldown') {
          // The notice itself is derived from the cooldown in CourseCard so it
          // counts down and disappears when the window ends.
          markCooling(res.lastForcedRunAt, res.retryAfterMs ?? 0);
          clearNotice();
        } else {
          drop(tr('run.notWatching', { reason: res.reason ?? 'unknown' }));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        drop(tr('run.failed', { reason }));
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
    if (!anyWatching && !loggedIn) return; // can't "Start all" while logged out
    schedBusyRef.current = true;
    setSchedBusy(true);
    setSchedErr(undefined);
    const sch = schedulerRef.current;
    try {
      if (anyWatching) await api.stopAll();
      else await api.startAll();
      await Promise.all([sch.refetch(), targetsRef.current.refetch()]);
    } catch (e) {
      setSchedErr(e instanceof Error ? e.message : tr('dashboard.schedToggleFailed'));
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

  return (
    <>
      {sessionDown && <div className="banner">{tr('dashboard.sessionBanner')}</div>}

      <div className="grid">
        <div>
          <div className="col-h">
            <h2 className="serif">{tr('dashboard.watchedCourses')}</h2>
            <SchedulerToggle
              running={anyWatching}
              onStart={onToggleScheduler}
              onStop={onToggleScheduler}
              busy={schedBusy}
              canStart={loggedIn}
            />
          </div>
          {schedErr && <div className="errbar">{schedErr}</div>}
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
