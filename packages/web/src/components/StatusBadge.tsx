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
  return <span className={`badge ${CLASS[status]}`}>{status.toUpperCase()}</span>;
}
