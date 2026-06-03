import { useTranslation } from 'react-i18next';
import type { WatchStatus } from '@autoregister/shared';

const CLASS: Record<WatchStatus, string> = {
  watching: 'b-watch',
  waitlisted: 'b-wait',
  registered: 'b-reg',
  paused: 'b-pause',
  stopped: 'b-stop',
  error: 'b-err',
};

export function StatusBadge({ status }: { status: WatchStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${CLASS[status]}`}>{t(`status.${status}`)}</span>;
}
