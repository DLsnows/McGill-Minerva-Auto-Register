import { useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { CourseForm, type CourseFormValues } from '../components/CourseForm';
import { StatusBadge } from '../components/StatusBadge';

export default function Courses() {
  const { targets } = useData();
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const list = targets.data ?? [];

  // Run a mutation, surface any failure, and refresh the list.
  const run = async (op: () => Promise<unknown>) => {
    setErr(undefined);
    try {
      await op();
      await targets.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Operation failed.');
    }
  };

  const add = (v: CourseFormValues) =>
    run(() =>
      api.addTarget({
        term: v.term, subject: v.subject, courseNumber: v.courseNumber, targetCrn: v.targetCrn,
        faculty: v.faculty || undefined, label: v.label || undefined, mode: v.mode,
      }),
    );

  const saveEdit = (id: string, v: CourseFormValues) =>
    run(async () => {
      await api.updateTarget(id, {
        term: v.term, subject: v.subject, courseNumber: v.courseNumber, targetCrn: v.targetCrn,
        faculty: v.faculty || undefined, label: v.label || undefined, mode: v.mode,
      });
      setEditing(null);
    });

  const remove = (id: string) => run(() => api.removeTarget(id));

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Add a course</h2>
      </div>
      <CourseForm submitLabel="Add course" onSubmit={add} />
      {err && <div className="errbar">{err}</div>}

      <div className="col-h" style={{ marginTop: 22 }}>
        <h2 className="serif">Managed courses</h2>
      </div>
      {list.length === 0 ? (
        <div className="empty glass">No courses yet.</div>
      ) : (
        <div className="cards">
          {list.map((t) =>
            editing === t.id ? (
              <CourseForm
                key={t.id}
                submitLabel="Save"
                initial={{
                  term: t.term, subject: t.subject, courseNumber: t.courseNumber, targetCrn: t.targetCrn,
                  faculty: t.faculty ?? '', label: t.label ?? '', mode: t.mode,
                }}
                onSubmit={(v) => saveEdit(t.id, v)}
                onCancel={() => {
                  setEditing(null);
                  setErr(undefined);
                }}
              />
            ) : (
              <div key={t.id} className="card glass">
                <div className="row1">
                  <div>
                    <div className="title">{t.label ?? `${t.subject} ${t.courseNumber}`}</div>
                    <div className="crn">
                      CRN {t.targetCrn} · {t.term} · {t.mode}
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn" onClick={() => setEditing(t.id)}>
                    Edit
                  </button>
                  <button type="button" className="btn" onClick={() => remove(t.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
