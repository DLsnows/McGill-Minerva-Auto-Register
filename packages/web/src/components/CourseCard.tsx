import { useTranslation } from 'react-i18next';
import type { WatchMode, WatchTarget } from '@autoregister/shared';
import { StatGrid } from './StatGrid';
import { StatusBadge } from './StatusBadge';
import { ModeToggle } from './ModeToggle';
import { fmtRelative } from '../lib/format';

interface Props {
  target: WatchTarget;
  onToggleMode: (id: string, next: WatchMode) => void;
  onRun: (id: string) => void;
  running?: boolean;
}

export function CourseCard({ target, onToggleMode, onRun, running }: Props) {
  const { t } = useTranslation();
  const title = target.label ?? `${target.subject} ${target.courseNumber}`;
  const canRun = target.status === 'watching';
  return (
    <div className="card glass">
      <div className="row1">
        <div>
          <div className="title">{title}</div>
          <div className="crn">
            CRN {target.targetCrn} · {target.term}
          </div>
        </div>
        <StatusBadge status={target.status} />
      </div>

      <StatGrid stats={target.lastStats} />

      <div className="row3">
        <ModeToggle mode={target.mode} onToggle={(next) => onToggleMode(target.id, next)} />
        <button
          type="button"
          className="btn btn-accent"
          disabled={!canRun || running}
          onClick={() => onRun(target.id)}
        >
          {running ? t('card.running') : t('card.registerNow')}
        </button>
      </div>

      <div className="meta">
        {target.lastPolledAt ? t('card.lastPoll', { rel: fmtRelative(target.lastPolledAt) }) : t('card.notPolled')}
      </div>
    </div>
  );
}
