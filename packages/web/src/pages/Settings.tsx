import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';

// NOTE: email/SMTP notifications are temporarily sunset — the UI is hidden and
// the server forces `notify.email = false` (see packages/server/src/api/server.ts
// + scheduler/runtime.ts). The backend code, the `EmailConfig` type and
// docs/EMAIL_SETUP.md are intentionally kept so the feature can be restored with
// a small change. The `settings.email*` i18n keys are kept but no longer rendered.

const inputStyle = {
  padding: 8,
  borderRadius: 8,
  background: 'rgba(255,255,255,.04)',
  border: '1px solid var(--bd)',
  color: 'var(--tx)',
} as const;

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      {label}
      <input
        aria-label={label}
        type="number"
        style={inputStyle}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const { settings, budget } = useData();
  const [form, setForm] = useState<Settings | null>(null);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
    }
  }, [settings.data, form]);

  if (!form) return <div className="empty">{t('settings.loading')}</div>;

  const save = async () => {
    setErr(undefined);
    try {
      await api.putSettings(form);
      // Refresh BOTH resources: the budget snapshot carries the daily limits, so
      // saving a new limit without re-reading the budget would leave the ticker
      // pairing the new limit with the old op-count. `refetch` reports (and does
      // not throw) a failure, so a refresh that doesn't land is surfaced instead
      // of silently reporting success.
      //
      // (The email half of the old save path is gone: notifications are sunset and
      // the server forces `notify.email = false` regardless of what is sent.)
      const [settingsErr, budgetErr] = await Promise.all([settings.refetch(), budget.refetch()]);
      const failed = [settingsErr, budgetErr].find(Boolean);
      if (failed) {
        // The PUT already resolved, so the settings *were* persisted — saying
        // "failed to save" here would be a lie. Report the two halves separately.
        setSaved(false);
        setErr(`${t('settings.savedButRefreshFailed')} ${failed.message}`);
        return;
      }
      setSaved(true);
    } catch (e) {
      setSaved(false);
      setErr(e instanceof Error ? e.message : t('settings.saveFailed'));
    }
  };

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">{t('settings.title')}</h2>
      </div>

      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <NumField label={t('settings.pollInterval')} value={form.pollIntervalMinutes} onChange={(n) => setForm({ ...form, pollIntervalMinutes: n })} />
          <NumField label={t('settings.jitter')} value={form.jitterMinutes} onChange={(n) => setForm({ ...form, jitterMinutes: n })} />
          <NumField label={t('settings.queryBudget')} value={form.queryBudget} onChange={(n) => setForm({ ...form, queryBudget: n })} />
          <NumField label={t('settings.registerBudget')} value={form.registerBudget} onChange={(n) => setForm({ ...form, registerBudget: n })} />
        </div>

        <div style={{ color: 'var(--tx-2)', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
          💡 {t('settings.pacingNote')}
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
          <label>
            <input type="checkbox" aria-label={t('settings.desktopAria')} checked={form.notify.desktop} onChange={(e) => setForm({ ...form, notify: { ...form.notify, desktop: e.target.checked } })} /> {t('settings.desktop')}
          </label>
          <label>
            <input type="checkbox" aria-label={t('settings.soundAria')} checked={form.notify.sound} onChange={(e) => setForm({ ...form, notify: { ...form.notify, sound: e.target.checked } })} /> {t('settings.sound')}
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <label>
            <input
              type="checkbox"
              aria-label={t('settings.dryRunAria')}
              checked={form.dryRun ?? false}
              onChange={(e) => setForm({ ...form, dryRun: e.target.checked })}
            />{' '}
            {t('settings.dryRun')}
          </label>
        </div>
      </div>

      {err && <div className="errbar">{err}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button type="button" className="btn btn-accent" onClick={save}>
          {t('settings.saveSettings')}
        </button>
        {saved && <span style={{ color: 'var(--color-green)', fontSize: 12 }}>{t('settings.saved')}</span>}
      </div>
    </div>
  );
}
