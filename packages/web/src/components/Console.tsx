import { useEffect, useRef } from 'react';
import type { LogEvent, LogLevel } from '@autoregister/shared';
import { fmtClock } from '../lib/format';

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'l-info',
  ok: 'l-ok',
  action: 'l-action',
  warn: 'l-warn',
  error: 'l-err',
};

export function Console({ events, connected }: { events: LogEvent[]; connected: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="console glass">
      <div className="bar">
        <span className="c cr" /> <span className="c cy" /> <span className="c cg" />
        <span className="t">autoregister · {connected ? 'live stream' : 'reconnecting…'}</span>
      </div>
      <div className="log" ref={logRef}>
        {events.map((e) => (
          <div className="ln" key={e.id}>
            <span className="ts">{fmtClock(e.ts)}</span>{' '}
            <span className={LEVEL_CLASS[e.level]}>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
