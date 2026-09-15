import { useEffect, useRef, useState } from 'react';
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

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
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
  // Tagged like `Courses.err`, and the tag decides *which* read disproves the
  // note: `refresh` ("the settings re-read failed") is retired by a landed
  // `settings` read, `budget` ("the snapshot is stale") only by a landed `budget`
  // read. Retiring on the wrong resource's revision would erase the note in the
  // very render that set it — a landed settings read does not make a stale budget
  // snapshot fresh. A rejected PUT (`save`) is not disproved by any read.
  const [err, setErr] = useState<{ kind: 'refresh' | 'budget' | 'save'; message: string }>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Revision captured *before* the failed read, per resource. The note is retired
  // once that resource's revision moves past it — i.e. a read really did land — no
  // matter which part of the tree (or which user gesture) triggered it. That is
  // what lets the shell's retry button clear a note this page owns, without the
  // page needing a callback from its own ancestor.
  const staleAtRevision = useRef<{ settings?: number; budget?: number }>({});

  // The revisions are read through a ref that is kept current *synchronously* (on
  // every render, not in an effect): `save` awaits the PUT first, and a read landing
  // during that await would leave both a render-closure snapshot and an
  // effect-mirrored ref behind — the ref effect runs after commit, so it can still
  // be one render stale at the moment the handler resumes.
  const revisionsRef = useRef({ settings: settings.revision, budget: budget.revision });
  revisionsRef.current = { settings: settings.revision, budget: budget.revision };

  // One save at a time. Declared up here with the other refs, above the `!form`
  // early return, so the hook order is identical on every render.
  const savingRef = useRef(false);

  useEffect(() => {
    const stale = staleAtRevision.current;
    if (stale.settings === undefined && stale.budget === undefined) return;
    let retired = false;
    if (stale.settings !== undefined && settings.revision !== stale.settings) {
      delete stale.settings;
      retired = true;
    }
    if (stale.budget !== undefined && budget.revision !== stale.budget) {
      delete stale.budget;
      retired = true;
    }
    if (!retired) return;
    setErr((e) => (e?.kind === 'refresh' || e?.kind === 'budget' ? undefined : e));
  }, [settings.revision, budget.revision]);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
    }
  }, [settings.data, form]);

  // `form` is seeded from `settings.data`, so a fetch that failed leaves it null
  // for the whole session (useResource never re-runs its mount effect). The old
  // `if (!form) return <div className="empty">Loading settings…` turned one
  // transient failure into a permanent "Loading settings…" screen with no
  // explanation and no way out short of a full page reload.
  //
  // No error bar here: the shell owns `settings` (it is what the ticker's poll
  // cadence shows, on every route — see App.tsx), so the failure is reported and
  // retryable there whether or not this route is on screen. Repeating it here
  // would put two bars and two buttons on one failure.
  if (!form) {
    return (
      <div>
        <div className="col-h">
          <h2 className="serif">{t('settings.title')}</h2>
        </div>
        {settings.error ? (
          <div className="empty">{t('settings.loadFailed')}</div>
        ) : (
          <div className="empty">{t('settings.loading')}</div>
        )}
      </div>
    );
  }

  const save = async () => {
    // One save at a time, like `onToggleScheduler` does with `schedBusyRef`: two
    // overlapping saves would each run their own PUT + refetch pair, and the older
    // continuation's `setSaved(false)` (its read is inevitably superseded by the
    // newer save's) would wipe the "Saved ✓" the newer one had just earned — a
    // persisted save showing neither confirmation nor error. The same guard also
    // keeps the two continuations from writing `staleAtRevision` (a single shared
    // ref) out of order, which would leave one save's note armed against the
    // other's baseline.
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setErr(undefined);
    staleAtRevision.current = {};
    try {
      // Baseline captured *before* the request: the revision a failed read leaves
      // behind is the one current right now, and reading it later could already be
      // past the bump a concurrent read caused.
      const before = { ...revisionsRef.current };
      await api.putSettings(form);
      // Refresh BOTH resources: the budget snapshot carries the daily limits, so
      // saving a new limit without re-reading the budget would leave the ticker
      // pairing the new limit with the old op-count. `refetch` reports (and does
      // not throw) a failure, so a refresh that doesn't land is surfaced instead
      // of silently reporting success.
      //
      // (The email half of the old save path is gone: notifications are sunset and
      // the server forces `notify.email = false` regardless of what is sent.)
      const [settingsRes, budgetRes] = await Promise.all([settings.refetch(), budget.refetch()]);
      // The PUT already resolved, so the settings *were* persisted — saying
      // "failed to save" here would be a lie.
      //
      // The `settings` half is reported here (this page owns the form the user
      // just wrote); the raw `budget` failure is reported by the shell, which owns
      // that resource — see the ownership notes in App.tsx. But the save still has
      // to say *something* about the budget half, otherwise a save that landed is
      // indistinguishable from a save that never happened: no "Saved ✓" and no
      // message on this page at all. That note is keyed to `budget.revision`, NOT
      // `settings.revision`: the settings read succeeded in that branch, so keying
      // it there would retire it in the same render that set it.
      // A *superseded* outcome is not a failure and must not be reported as one:
      // a newer read won the race, so the values on screen come from that one, and
      // arming a note against the pre-refetch revision can leave it permanently
      // armed (the effect may already have passed that revision). The winner
      // reports itself.
      const settingsFailure =
        !settingsRes.ok && 'error' in settingsRes ? settingsRes.error : undefined;
      const budgetFailure = !budgetRes.ok && 'error' in budgetRes ? budgetRes.error : undefined;
      const superseded = (!settingsRes.ok && !settingsFailure) || (!budgetRes.ok && !budgetFailure);
      if (settingsFailure ?? budgetFailure) {
        setSaved(false);
        if (settingsFailure) {
          staleAtRevision.current = { settings: before.settings };
          setErr({
            kind: 'refresh',
            message: `${t('settings.savedButRefreshFailed')} ${settingsFailure.message}`,
          });
        } else {
          staleAtRevision.current = { budget: before.budget };
          setErr({ kind: 'budget', message: t('settings.savedButBudgetStale') });
        }
        return;
      }
      // Nothing failed outright, but at least one read was superseded: that read's
      // result is not ours to judge, so do not claim the save is confirmed — and
      // drop any "Saved ✓" a previous, unrelated save left on screen, otherwise the
      // flag survives a save this attempt could not confirm.
      if (superseded) {
        setSaved(false);
        return;
      }
      setSaved(true);
    } catch (e) {
      setSaved(false);
      setErr({ kind: 'save', message: e instanceof Error ? e.message : t('settings.saveFailed') });
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">{t('settings.title')}</h2>
      </div>

      <div className="card glass">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <NumField
            label={t('settings.pollInterval')}
            value={form.pollIntervalMinutes}
            onChange={(n) => setForm({ ...form, pollIntervalMinutes: n })}
          />
          <NumField
            label={t('settings.jitter')}
            value={form.jitterMinutes}
            onChange={(n) => setForm({ ...form, jitterMinutes: n })}
          />
          <NumField
            label={t('settings.queryBudget')}
            value={form.queryBudget}
            onChange={(n) => setForm({ ...form, queryBudget: n })}
          />
          <NumField
            label={t('settings.registerBudget')}
            value={form.registerBudget}
            onChange={(n) => setForm({ ...form, registerBudget: n })}
          />
        </div>

        <div style={{ color: 'var(--tx-2)', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
          💡 {t('settings.pacingNote')}
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
          <label>
            <input
              type="checkbox"
              aria-label={t('settings.desktopAria')}
              checked={form.notify.desktop}
              onChange={(e) =>
                setForm({ ...form, notify: { ...form.notify, desktop: e.target.checked } })
              }
            />{' '}
            {t('settings.desktop')}
          </label>
          <label>
            <input
              type="checkbox"
              aria-label={t('settings.soundAria')}
              checked={form.notify.sound}
              onChange={(e) =>
                setForm({ ...form, notify: { ...form.notify, sound: e.target.checked } })
              }
            />{' '}
            {t('settings.sound')}
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

      {err && <div className="errbar">{err.message}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button type="button" className="btn btn-accent" onClick={save} disabled={busy}>
          {t('settings.saveSettings')}
        </button>
        {saved && (
          <span style={{ color: 'var(--color-green)', fontSize: 12 }}>{t('settings.saved')}</span>
        )}
      </div>
    </div>
  );
}
