import { useId, useReducer, useState } from 'react';
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

/**
 * `mode` has a default (`auto`), so it is never part of the required check — see `form.modeDefaultHint`.
 * The nullish guard keeps a field that somehow arrives as `null`/`undefined` (API rows are not
 * validated at runtime) blank instead of the non-empty string `"null"`.
 */
const isBlank = (v: CourseFormValues, key: keyof CourseFormValues) => !String(v[key] ?? '').trim();

const trimAll = (v: CourseFormValues): CourseFormValues => ({
  term: v.term.trim(),
  subject: v.subject.trim(),
  courseNumber: v.courseNumber.trim(),
  targetCrn: v.targetCrn.trim(),
  faculty: v.faculty.trim(),
  label: v.label.trim(),
  mode: v.mode,
});

/**
 * Form state. `values` and the derived `missing` list live in one object and are reduced
 * together, so a single dispatch always derives both from the *same* state.
 */
export interface CourseFormState {
  values: CourseFormValues;
  /** Required fields that were empty on the last submit attempt, so they can be highlighted. */
  missing: (keyof CourseFormValues)[];
}

export type CourseFormAction =
  | { type: 'update'; patch: Partial<CourseFormValues> }
  | { type: 'submit' }
  | { type: 'accepted' };

/**
 * Pure by contract. React runs the reducer once per queued action and commits the resulting
 * state as a whole, which is what lets several `update`s dispatched in the same tick (a
 * batched or programmatic fill) compose instead of overwriting each other — reading the
 * values from a render closure would silently drop all but the last patch.
 */
export function courseFormReducer(state: CourseFormState, action: CourseFormAction): CourseFormState {
  switch (action.type) {
    case 'update': {
      const values = { ...state.values, ...action.patch };
      // drop the highlight from any field the user has just filled in
      const missing = state.missing.length
        ? state.missing.filter((key) => isBlank(values, key))
        : state.missing;
      return valuesEqual(values, state.values) ? state : { values, missing };
    }
    case 'submit':
      return { ...state, missing: REQUIRED_KEYS.filter((key) => isBlank(state.values, key)) };
    case 'accepted':
      return { ...state, missing: [] };
  }
}

const valuesEqual = (a: CourseFormValues, b: CourseFormValues) =>
  (Object.keys(a) as (keyof CourseFormValues)[]).every((key) => a[key] === b[key]);

const inputStyle = {
  padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.04)',
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--bd)', color: 'var(--tx)',
} as const;

const invalidInputStyle = { ...inputStyle, borderColor: 'var(--color-red)' } as const;

const hintStyle = { color: 'var(--tx-2)', fontSize: 11 } as const;
const fieldErrorStyle = { color: 'var(--color-red)', fontSize: 11 } as const;

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
  const [state, dispatch] = useReducer(courseFormReducer, { values: initial ?? EMPTY, missing: [] });
  const [err, setErr] = useState<string>();

  const update = (patch: Partial<CourseFormValues>) => {
    dispatch({ type: 'update', patch });
    if (err) setErr(undefined); // clear the validation message once the user edits
  };

  const submit = () => {
    if (REQUIRED_KEYS.some((key) => isBlank(state.values, key))) {
      dispatch({ type: 'submit' });
      setErr(t('form.required'));
      return;
    }
    dispatch({ type: 'accepted' });
    setErr(undefined);
    onSubmit(trimAll(state.values));
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
            const isMissing = f.required && state.missing.includes(f.key);
            const errorId = `${uid}-${f.key}-required`;
            return (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
                  {label}
                  {/* The marks sit next to the label text and are decorative for assistive tech
                      on purpose: the input's own `aria-required` is the single semantic signal,
                      so "required" is never announced twice. */}
                  {f.required ? (
                    <span aria-hidden="true" style={fieldErrorStyle}>
                      {t('form.requiredMark')}
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
                  aria-required={f.required || undefined}
                  aria-invalid={isMissing || undefined}
                  aria-describedby={isMissing ? errorId : undefined}
                  placeholder={t(`form.ph.${f.key}`)}
                  style={isMissing ? invalidInputStyle : inputStyle}
                  value={state.values[f.key] as string}
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
              value={state.values.mode}
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
