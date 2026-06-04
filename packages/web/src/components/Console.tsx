import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogEvent, LogLevel } from '@autoregister/shared';
import { fmtClock } from '../lib/format';

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'l-info',
  ok: 'l-ok',
  action: 'l-action',
  warn: 'l-warn',
  error: 'l-err',
};

interface Props {
  events: LogEvent[];
  connected: boolean;
  onClear?: () => void;
}

export function Console({ events, connected, onClear }: Props) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Newest is rendered at the top, so keep the view pinned to the top when the
    // user is already near it — without yanking them back if they scrolled down
    // to read older lines.
    if (el.scrollTop < 80) el.scrollTop = 0;
  }, [events]);

  // Newest first (the stream stores events oldest-last).
  const ordered = [...events].reverse();

  return (
    <div className="console glass">
      <div className="bar">
        <span className={`c cr${connected ? '' : ' on'}`} aria-hidden="true" />{' '}
        <span className="c cy" aria-hidden="true" />{' '}
        <span className={`c cg${connected ? ' on' : ''}`} aria-hidden="true" />
        <span className="t" role="status">
          autoregister · {connected ? t('console.liveStream') : t('console.reconnecting')}
        </span>
        {onClear && (
          <button type="button" className="console-clear" onClick={onClear}>
            {t('console.clear')}
          </button>
        )}
      </div>
      <div className="log" ref={logRef}>
        {ordered.map((e) => (
          <div className="ln" key={e.id}>
            <span className="ts">{fmtClock(e.ts)}</span>{' '}
            <span className={LEVEL_CLASS[e.level]}>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
