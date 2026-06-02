import type { SectionStats } from '@autoregister/shared';

const KEYS: { k: keyof SectionStats; label: string; cls?: string }[] = [
  { k: 'cap', label: 'cap' },
  { k: 'act', label: 'act' },
  { k: 'rem', label: 'rem' },
  { k: 'wlcap', label: 'wlcap', cls: 'stat-wl' },
  { k: 'wlact', label: 'wlact', cls: 'stat-wl' },
  { k: 'wlrem', label: 'wlrem', cls: 'stat-wl' },
];

export function StatGrid({ stats }: { stats?: SectionStats }) {
  return (
    <div className="stats">
      {KEYS.map(({ k, label, cls }) => (
        <div key={label} className={`stat ${cls ?? ''}`}>
          <div className="sk">{label}</div>
          <div className="sv">{stats ? String(stats[k]) : '—'}</div>
        </div>
      ))}
    </div>
  );
}
