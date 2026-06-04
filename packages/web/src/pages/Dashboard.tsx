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
  const { events, connected } = useEventStream();
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [schedErr, setSchedErr] = useState<string>();
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

  // Per-course pause/resume. Resuming a single course also makes sure the engine
  // is running, otherwise flipping it to 'watching' alone wouldn't poll anything.
  const onTogglePolling = useCallback(async (id: string, next: WatchStatus) => {
    // No resuming/starting a task while logged out (the button is disabled too).
    if (next === 'watching' && sessionRef.current.data?.status !== 'authenticated') return;
    await api.updateTarget(id, { status: next });
    if (next === 'watching') await api.startScheduler();
    await Promise.all([targetsRef.current.refetch(), schedulerRef.current.refetch()]);
  }, []);

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
          <Console events={events} connected={connected} />
        </div>
      </div>
    </>
  );
}
