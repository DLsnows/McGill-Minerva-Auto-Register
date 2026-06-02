import { useState } from 'react';
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

const FIELDS: { key: keyof CourseFormValues; label: string }[] = [
  { key: 'term', label: 'Term' },
  { key: 'subject', label: 'Subject' },
  { key: 'courseNumber', label: 'Course #' },
  { key: 'targetCrn', label: 'Target CRN' },
  { key: 'faculty', label: 'Faculty' },
  { key: 'label', label: 'Label' },
];

const inputStyle = {
  padding: 8,
  borderRadius: 8,
  background: 'rgba(255,255,255,.04)',
  border: '1px solid var(--bd)',
  color: 'var(--tx)',
} as const;

export function CourseForm({ onSubmit, submitLabel, initial, onCancel }: Props) {
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
    if (!trimmed.term || !trimmed.subject || !trimmed.courseNumber || !trimmed.targetCrn) {
      setErr('Term, Subject, Course # and Target CRN are required.');
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
            {f.label}
            <input
              aria-label={f.label}
              style={inputStyle}
              value={v[f.key] as string}
              onChange={(e) => update({ [f.key]: e.target.value })}
            />
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          Mode
          <select
            aria-label="Mode"
            style={inputStyle}
            value={v.mode}
            onChange={(e) => update({ mode: e.target.value as WatchMode })}
          >
            <option value="auto">auto</option>
            <option value="notify">notify</option>
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
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
