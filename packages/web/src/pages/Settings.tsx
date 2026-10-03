import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_OP_PAUSE_MS, MIN_OP_PAUSE_MS } from '@autoregister/shared';
import type { Settings } from '@autoregister/shared';
import { api, type PowerStatus } from '../lib/api';
import { useData } from '../lib/DataContext';

// NOTE: email/SMTP notifications are temporarily sunset — the UI is hidden and
// the server forces `notify.email = false` (see packages/server/src/api/server.ts
// + scheduler/runtime.ts). The backend code, the `EmailConfig` type and
// docs/EMAIL_SETUP.md are intentionally kept so the feature can be restored with
// a small change. The `settings.email*` i18n keys are kept but no longer rendered.

/** Maps the server's keep-awake `reason` to a translation key. */
const KEEP_AWAKE_REASON_KEY: Record<PowerStatus['reason'], string> = {
  active: 'settings.keepAwakeStatusActive',
  battery: 'settings.keepAwakeStatusBattery',
  disabled: 'settings.keepAwakeStatusDisabled',
  unavailable: 'settings.keepAwakeStatusUnavailable',
  keeperFailed: 'settings.keepAwakeStatusKeeperFailed',
  unsupported: 'settings.keepAwakeStatusUnsupported',
  pending: 'settings.keepAwakeStatusPending',
  starting: 'settings.keepAwakeStatusStarting',
};

const noteStyle = { color: 'var(--tx-2)', fontSize: 12, lineHeight: 1.6 } as const;

/** How often the settings page re-reads the live keep-awake status. The server
 * re-checks the power source every 60 s, so this stays comfortably ahead of it
 * while the page is open (a laptop unplugged mid-session flips to "on battery"). */
const POWER_POLL_MS = 30_000;

/** Operation-speed bounds, shared with the server schema (single source of truth). */
const OP_PAUSE_MIN = MIN_OP_PAUSE_MS;
const OP_PAUSE_MAX = MAX_OP_PAUSE_MS;

/** The operation-speed fields are only accepted in range — never save garbage. */
function isPacingValid(form: Pick<Settings, 'opPauseMs' | 'opJitterMs'>): boolean {
  return (
    Number.isFinite(form.opPauseMs) &&
    form.opPauseMs >= OP_PAUSE_MIN &&
    form.opPauseMs <= OP_PAUSE_MAX &&
    Number.isFinite(form.opJitterMs) &&
    form.opJitterMs >= 0 &&
    form.opJitterMs <= OP_PAUSE_MAX
  );
}

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
  min,
  max,
  step,
  rejectEmpty = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Treat a cleared field as an unsettled value (`NaN`) instead of `0`.
   *
   * Opt-in, and deliberately not the default: `Number('')` is `0`, and for a field whose
   * server bound is `min(0)` clearing it is a perfectly good way to store `0`. Applying
   * the coercion to every numeric input silently turned that into `NaN` -> `null` -> a
   * raw 400 for `jitterMinutes` and `registerBudget`. Only the two operation-speed fields
   * want it, because they have their own friendly range guard (`isPacingValid`). */
  rejectEmpty?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      {label}
      <input
        aria-label={label}
        type="number"
        style={inputStyle}
        // Show an unsettled value as empty rather than "NaN" / "Infinity".
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) =>
          onChange(rejectEmpty && e.target.value.trim() === '' ? NaN : Number(e.target.value))
        }
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

  // Windows-only keep-awake status. `null` = not loaded / unreachable (the whole
  // block stays unrendered, so non-Windows users never see a dead switch).
  const [power, setPower] = useState<PowerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getPower()
        .then((p) => {
          if (!cancelled) setPower(p);
        })
        .catch(() => {
          // A failed probe is not "unsupported" — keep the last known status
          // (or stay hidden on the very first load).
        });
    void load();
    // Keep the status line honest while the page is open: a laptop switching to
    // battery makes the server release the hold within 60 s. `unref`-style
    // cleanup is not available in the browser, so the interval is always cleared
    // on unmount.
    const timer = setInterval(() => void load(), POWER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * Whether the settings we were *served* carried the operation-speed fields.
   *
   * Captured once, from the server's payload — deliberately **not** derived from
   * `form`. `Settings` declares both fields as required, so the type system
   * cannot see this case, but a server older than the feature (or an intermediary
   * serving a cached body) returns them as `undefined` at runtime. Deriving it
   * from `form` instead would flip the flag to `false` the moment a user clears
   * one of the inputs (`Number('')` in `NumField` with `rejectEmpty` gives `NaN`),
   * silently skipping the range check and letting a blank pause reach the server.
   *
   * This is not hypothetical: it is the shape of the real defect this branch
   * fixes, where the e2e fake backend omitted both fields, the page rendered them
   * as blanks coerced to `0`, and *every* save was then refused behind a
   * misleading "operation speed must be a number" — including unrelated ones.
   */
  const [pacingSupported, setPacingSupported] = useState(false);

  useEffect(() => {
    if (settings.data && !form) {
      setForm(settings.data);
      setPacingSupported(
        Number.isFinite(settings.data.opPauseMs) && Number.isFinite(settings.data.opJitterMs),
      );
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

  const pacingKnown = pacingSupported;

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
    if (pacingKnown && !isPacingValid(form)) {
      // `err` is the tagged object shape in this page (the audit's change), so the
      // message must go in `.message`. Passing a bare string here rendered
      // `undefined` into the error bar — an empty red bar and no explanation.
      setErr({
        kind: 'save',
        message: t('settings.pacingRange', { min: OP_PAUSE_MIN, max: OP_PAUSE_MAX }),
      });
      setSaved(false);
      savingRef.current = false;
      setBusy(false);
      return;
    }
    setErr(undefined);
    staleAtRevision.current = {};
    try {
      // Baseline captured *before* the request: the revision a failed read leaves
      // behind is the one current right now, and reading it later could already be
      // past the bump a concurrent read caused.
      const before = { ...revisionsRef.current };
      // `{ ...form }` with the two pacing fields removed, rather than a whitelist of
      // every field the server accepts: this page must keep working across branches
      // whose `Settings` types differ (keep-awake adds `keepAwake`), and a
      // whitelist written here would silently drop whichever field it did not know
      // about. A rest-destructure cannot be used to omit them — it needs two unused
      // bindings and this repo's `@typescript-eslint/no-unused-vars` has no
      // `_`-prefix exception — so the omission is explicit instead.
      const patch: Partial<Settings> = { ...form };
      if (!pacingSupported) {
        delete patch.opPauseMs;
        delete patch.opJitterMs;
      }
      await api.putSettings(patch);
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
      // The server applies keep-awake on save — pull the resulting state so the
      // status line reflects reality (keeper running / waiting for AC / off).
      if (power?.supported) {
        try {
          setPower(await api.getPower());
        } catch {
          // Keep the previous status rather than blanking the block.
        }
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

      {power?.supported && (
        <>
          <div className="col-h" style={{ marginTop: 22 }}>
            <h2 className="serif">{t('settings.keepAwakeSection')}</h2>
          </div>
          <div className="card glass">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                aria-label={t('settings.keepAwakeAria')}
                checked={form.keepAwake ?? false}
                onChange={(e) => setForm({ ...form, keepAwake: e.target.checked })}
              />
              {t('settings.keepAwake')}
            </label>

            <div style={{ ...noteStyle, marginTop: 8 }}>
              <div>💤 {t('settings.keepAwakeNoSleep')}</div>
              <div>🖥️ {t('settings.keepAwakeDisplayNote')}</div>
              <div>🔌 {t('settings.keepAwakeLaptopNote')}</div>
              <div>🖲️ {t('settings.keepAwakeDesktopNote')}</div>
              <div>↩️ {t('settings.keepAwakeExitNote')}</div>
            </div>

            <div data-testid="keep-awake-status" style={{ ...noteStyle, marginTop: 10 }}>
              {t('settings.keepAwakeStatus')}: {t(KEEP_AWAKE_REASON_KEY[power.reason])}
            </div>
          </div>
        </>
      )}

      {pacingKnown && (
        <>
          <div className="col-h" style={{ marginTop: 22 }}>
            <h2 className="serif">{t('settings.pacingSection')}</h2>
          </div>
          <div className="card glass">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              <NumField
                label={t('settings.opPause')}
                value={form.opPauseMs}
                min={OP_PAUSE_MIN}
                max={OP_PAUSE_MAX}
                step={50}
                rejectEmpty
                onChange={(n) => setForm({ ...form, opPauseMs: n })}
              />
              <NumField
                label={t('settings.opJitter')}
                value={form.opJitterMs}
                min={0}
                max={OP_PAUSE_MAX}
                step={50}
                rejectEmpty
                onChange={(n) => setForm({ ...form, opJitterMs: n })}
              />
            </div>
            <div style={{ color: 'var(--tx-2)', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
              ⏱ {t('settings.pacingHint', { min: OP_PAUSE_MIN, max: OP_PAUSE_MAX })}
            </div>
          </div>
        </>
      )}

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
