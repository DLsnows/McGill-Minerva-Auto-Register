import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WatchMode } from '@autoregister/shared';

export interface CourseFormValues {
  term: string;
  subject: string;
  courseNumber: string;
  targetCrn: string;
  faculty: string;
  label: string;
  mode: WatchMode;
}

const EMPTY: CourseFormValues = {
  term: '', subject: '', courseNumber: '', targetCrn: '', faculty: '', label: '', mode: 'auto',
};

interface Props {
  onSubmit: (v: CourseFormValues) => void;
  submitLabel: string;
  initial?: CourseFormValues;
  onCancel?: () => void;
}

const FIELDS: { key: keyof CourseFormValues; required: boolean }[] = [
  { key: 'term', required: true },
  { key: 'subject', required: true },
  { key: 'faculty', required: true },
  { key: 'courseNumber', required: true },
  { key: 'targetCrn', required: true },
  { key: 'label', required: false },
];

const inputStyle = {
  padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--bd)', color: 'var(--tx)',
} as const;

/** A small "?" badge that reveals a help tooltip on hover/focus. */
function HelpTip({ text }: { text: string }) {
  return (
    <span className="help">
      <span className="help-badge" tabIndex={0} role="img" aria-label={text}>
        ?
      </span>
      <span className="tip" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

export function CourseForm({ onSubmit, submitLabel, initial, onCancel }: Props) {
  const { t } = useTranslation();
  const [v, setV] = useState<CourseFormValues>(initial ?? EMPTY);
  const [err, setErr] = useState<string>();

  const update = (patch: Partial<CourseFormValues>) => {
    setV((prev) => ({ ...prev, ...patch }));
    if (err) setErr(undefined); // clear the validation message once the user edits
  };

  const submit = () => {
    const trimmed: CourseFormValues = {
      ...v,
      term: v.term.trim(),
      subject: v.subject.trim(),
      courseNumber: v.courseNumber.trim(),
      targetCrn: v.targetCrn.trim(),
      faculty: v.faculty.trim(),
      label: v.label.trim(),
    };
    if (!trimmed.term || !trimmed.subject || !trimmed.faculty || !trimmed.courseNumber || !trimmed.targetCrn) {
      setErr(t('form.required'));
      return;
    }
    setErr(undefined);
    onSubmit(trimmed);
  };

  return (
    <div className="card glass">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span>
              {t(`form.${f.key}`)}
              <HelpTip text={t(`form.help.${f.key}`)} />
            </span>
            <input
              aria-label={t(`form.${f.key}`)}
              placeholder={t(`form.ph.${f.key}`)}
              style={inputStyle}
              value={v[f.key] as string}
              onChange={(e) => update({ [f.key]: e.target.value })}
            />
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span>
            {t('form.mode')}
            <HelpTip text={t('form.help.mode')} />
          </span>
          <select
            aria-label={t('form.mode')}
            className="form-select"
            style={inputStyle}
            value={v.mode}
            onChange={(e) => update({ mode: e.target.value as WatchMode })}
          >
            <option value="auto">{t('form.modeAuto')}</option>
            <option value="notify">{t('form.modeNotify')}</option>
          </select>
        </label>
      </div>
      {err && <div className="errbar">{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-accent" onClick={submit}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            {t('form.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
