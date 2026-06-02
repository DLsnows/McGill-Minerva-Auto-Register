import { useEffect, useState } from 'react';
import type { EmailConfig, Settings } from '@autoregister/shared';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';

const DOC_URL = 'https://github.com/DLsnows/McGill-Minerva-Auto-Register/blob/dev/docs/EMAIL_SETUP.md';
const EMPTY_EMAIL: EmailConfig = { host: '', port: 587, user: '', pass: '', to: '' };

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
      <input aria-label={label} type="number" style={inputStyle} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string | number;
  onChange: (s: string) => void;
  type?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      {label}
      <input aria-label={label} type={type} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function SettingsPage() {
  const { settings } = useData();
  const [form, setForm] = useState<Settings | null>(null);
  const [email, setEmail] = useState<EmailConfig>(EMPTY_EMAIL);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
      setEmail(settings.data.email ?? EMPTY_EMAIL);
    }
  }, [settings.data, form]);

  if (!form) return <div className="empty">Loading settings…</div>;

  const emailComplete = Boolean(email.host && email.user && email.pass && email.to && email.port);

  const save = async () => {
    if (form.notify.email && !emailComplete) {
      setErr('All email fields are required when email notifications are enabled.');
      setSaved(false);
      return;
    }
    setErr(undefined);
    try {
      // Persist the email config whenever it's complete (even if notifications
      // are off) so toggling email on later doesn't lose it. The server only
      // *sends* email when notify.email is true.
      await api.putSettings({ ...form, email: form.notify.email || emailComplete ? email : undefined });
      await settings.refetch();
      setSaved(true);
    } catch (e) {
      setSaved(false);
      setErr(e instanceof Error ? e.message : 'Failed to save settings.');
    }
  };

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Settings</h2>
      </div>

      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <NumField label="Poll interval (min)" value={form.pollIntervalMinutes} onChange={(n) => setForm({ ...form, pollIntervalMinutes: n })} />
          <NumField label="Jitter (min)" value={form.jitterMinutes} onChange={(n) => setForm({ ...form, jitterMinutes: n })} />
          <NumField label="Query budget / day" value={form.queryBudget} onChange={(n) => setForm({ ...form, queryBudget: n })} />
          <NumField label="Register budget / day" value={form.registerBudget} onChange={(n) => setForm({ ...form, registerBudget: n })} />
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
          <label>
            <input type="checkbox" aria-label="Desktop notifications" checked={form.notify.desktop} onChange={(e) => setForm({ ...form, notify: { ...form.notify, desktop: e.target.checked } })} /> Desktop
          </label>
          <label>
            <input type="checkbox" aria-label="Sound" checked={form.notify.sound} onChange={(e) => setForm({ ...form, notify: { ...form.notify, sound: e.target.checked } })} /> Sound
          </label>
          <label>
            <input type="checkbox" aria-label="Email notifications" checked={form.notify.email} onChange={(e) => setForm({ ...form, notify: { ...form.notify, email: e.target.checked } })} /> Email
          </label>
        </div>
      </div>

      <div className="col-h" style={{ marginTop: 22 }}>
        <h2 className="serif">Email (SMTP)</h2>
        <a className="btn" href={DOC_URL} target="_blank" rel="noreferrer">
          Setup guide ↗
        </a>
      </div>
      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <TextField label="SMTP host" value={email.host} onChange={(s) => setEmail({ ...email, host: s })} />
          <TextField label="SMTP port" type="number" value={email.port} onChange={(s) => setEmail({ ...email, port: Number(s) })} />
          <TextField label="SMTP user" value={email.user} onChange={(s) => setEmail({ ...email, user: s })} />
          <TextField label="SMTP pass" type="password" value={email.pass} onChange={(s) => setEmail({ ...email, pass: s })} />
          <TextField label="Email to" value={email.to} onChange={(s) => setEmail({ ...email, to: s })} />
        </div>
      </div>

      {err && <div className="errbar">{err}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button type="button" className="btn btn-accent" onClick={save}>
          Save settings
        </button>
        {saved && <span style={{ color: 'var(--color-green)', fontSize: 12 }}>Saved ✓</span>}
      </div>
    </div>
  );
}
