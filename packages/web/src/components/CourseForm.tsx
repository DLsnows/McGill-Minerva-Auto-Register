import { useId, useState } from 'react';
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

/** Text fields that must be filled in before the form may be submitted. */
const REQUIRED_KEYS = FIELDS.filter((f) => f.required).map((f) => f.key);

/** `mode` has a default (`auto`), so it is never part of the required check — see `form.modeDefaultHint`. */
const isBlank = (v: CourseFormValues, key: keyof CourseFormValues) => !String(v[key]).trim();

const inputStyle = {
  padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)',
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--bd)', color: 'var(--tx)',
} as const;

const invalidInputStyle = { ...inputStyle, borderColor: 'var(--color-red)' } as const;

const hintStyle = { color: 'var(--tx-2)', fontSize: 11 } as const;
const fieldErrorStyle = { color: 'var(--color-red)', fontSize: 11 } as const;

/** Standard visually-hidden pattern: audible to screen readers, takes no visual space. */
const visuallyHidden = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', borderWidth: 0,
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
  // Several CourseForm instances can be mounted at once (the add form plus the row
  // being edited on Courses), so the per-field error ids need a per-instance prefix.
  const uid = useId();
  const [v, setV] = useState<CourseFormValues>(initial ?? EMPTY);
  const [err, setErr] = useState<string>();
  // Keys of the required fields that were empty on the last submit attempt, so
  // they can be highlighted individually.
  const [missing, setMissing] = useState<(keyof CourseFormValues)[]>([]);

  const update = (patch: Partial<CourseFormValues>) => {
    const next = { ...v, ...patch };
    setV(next);
    // drop the highlight from any field the user has just filled in
    if (missing.length) setMissing(missing.filter((k) => isBlank(next, k)));
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
    const empty = REQUIRED_KEYS.filter((key) => isBlank(trimmed, key));
    if (empty.length) {
      setMissing(empty);
      setErr(t('form.required'));
      return;
    }
    setMissing([]);
    setErr(undefined);
    onSubmit(trimmed);
  };

  return (
    <div className="card glass">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p style={{ ...hintStyle, margin: '0 0 10px' }}>{t('form.requiredLegend')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {FIELDS.map((f) => {
            const label = t(`form.${f.key}`);
            const isMissing = f.required && missing.includes(f.key);
            const errorId = `${uid}-${f.key}-required`;
            return (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
                  {label}
                  {/* The marks sit next to the label text; the input keeps its own `required` /
                      `aria-required`, so its accessible name stays just the field name. */}
                  {f.required ? (
                    <span style={fieldErrorStyle}>
                      <span aria-hidden="true">{t('form.requiredMark')}</span>
                      <span style={visuallyHidden}>{t('form.requiredMarkAria')}</span>
                    </span>
                  ) : (
                    <span aria-hidden="true" style={hintStyle}>
                      {t('form.optionalMark')}
                    </span>
                  )}
                  <HelpTip text={t(`form.help.${f.key}`)} />
                </span>
                <input
                  aria-label={label}
                  required={f.required || undefined}
                  aria-required={f.required || undefined}
                  aria-invalid={isMissing || undefined}
                  aria-describedby={isMissing ? errorId : undefined}
                  placeholder={t(`form.ph.${f.key}`)}
                  style={isMissing ? invalidInputStyle : inputStyle}
                  value={v[f.key] as string}
                  onChange={(e) => update({ [f.key]: e.target.value })}
                />
                {isMissing && (
                  <span id={errorId} style={fieldErrorStyle}>
                    {t('form.fieldRequired')}
                  </span>
                )}
              </label>
            );
          })}
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
            <span style={hintStyle}>{t('form.modeDefaultHint')}</span>
          </label>
        </div>
        {err && <div className="errbar">{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="btn btn-accent">
            {submitLabel}
          </button>
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              {t('form.cancel')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
