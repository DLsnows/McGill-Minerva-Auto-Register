import { useCallback, useEffect, useRef, useState } from 'react';
import type { WatchMode } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { useEventStream } from '../lib/useEventStream';
import { CourseCard } from '../components/CourseCard';
import { Console } from '../components/Console';
import { SchedulerToggle } from '../components/SchedulerToggle';

export default function Dashboard() {
  const { targets, session, scheduler } = useData();
  const { events, connected } = useEventStream();
  const [running, setRunning] = useState<Set<string>>(new Set());

  // `targets`/`scheduler` are fresh objects each render; reach them through refs
  // so the callbacks below can be genuinely stable and always read fresh data.
  const targetsRef = useRef(targets);
  const schedulerRef = useRef(scheduler);
  useEffect(() => {
    targetsRef.current = targets;
    schedulerRef.current = scheduler;
  });

  const onToggleMode = useCallback(async (id: string, next: WatchMode) => {
    await api.updateTarget(id, { mode: next });
    await targetsRef.current.refetch();
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

  const onToggleScheduler = useCallback(async () => {
    const sch = schedulerRef.current;
    if (sch.data?.running) await api.stopScheduler();
    else await api.startScheduler();
    await sch.refetch();
  }, []);

  const list = targets.data ?? [];
  const sessionStatus = session.data?.status ?? 'unknown';
  const sessionDown = sessionStatus === 'logged-out' || sessionStatus === 'unknown';

  return (
    <>
      {sessionDown && (
        <div className="banner">
          Session is not active — open the <strong>Session</strong> tab to log in so polling can run.
        </div>
      )}

      <div className="grid">
        <div>
          <div className="col-h">
            <h2 className="serif">Watched Courses</h2>
            <SchedulerToggle
              running={scheduler.data?.running ?? false}
              onStart={onToggleScheduler}
              onStop={onToggleScheduler}
            />
          </div>
          {list.length === 0 ? (
            <div className="empty glass">No courses watched yet. Add one from the Courses tab.</div>
          ) : (
            <div className="cards">
              {list.map((t) => (
                <CourseCard
                  key={t.id}
                  target={t}
                  onToggleMode={onToggleMode}
                  onRun={onRun}
                  running={running.has(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="col-h">
            <h2 className="serif">Live Console</h2>
          </div>
          <Console events={events} connected={connected} />
        </div>
      </div>
    </>
  );
}
