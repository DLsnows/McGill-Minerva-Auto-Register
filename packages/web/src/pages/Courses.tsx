import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useData } from '../lib/DataContext';
import { CourseForm, type CourseFormValues } from '../components/CourseForm';
import { ResourceError } from '../components/ResourceError';
import { StatusBadge } from '../components/StatusBadge';

export default function Courses() {
  const { t: tr } = useTranslation();
  const { targets } = useData();
  const [editing, setEditing] = useState<string | null>(null);
  // Tagged, because the two kinds retire differently: the resource error clears
  // itself when a read lands, so only the "the refresh failed" note may be cleared
  // with it — a later, unrelated mutation failure must survive that read. The
  // retirement is driven by the `targets.revision` effect below.
  const [err, setErr] = useState<{ kind: 'op' | 'refresh'; message: string }>();
  /** Non-fatal notice: the save itself succeeded but a follow-up step didn't (Q3).
   * Deliberately separate from `err`: it is not a failure of this page's operation,
   * so it renders in the quieter `banner` style and yields to any real error. */
  const [warn, setWarn] = useState<string>();
  const [addKey, setAddKey] = useState(0); // bumped to remount (reset) the add form
  const list = targets.data ?? [];
  // Set when a mutation's post-write re-read fails, so the note about it can be
  // retired once `targets.revision` moves past it — i.e. once a read really lands,
  // whichever gesture triggered it. A mutation that *threw* sits in the same `err`
  // slot but is not disproved by a readable list, hence the `kind` tag.
  const staleAtRevision = useRef<number | null>(null);
  // The revision as of the latest render, kept current *synchronously* (a render
  // assignment, not an effect — an effect runs after commit and can still be one
  // render behind when `run` resumes after `await op()`).
  const revisionRef = useRef(targets.revision);
  revisionRef.current = targets.revision;

  useEffect(() => {
    if (staleAtRevision.current === null) return;
    if (targets.revision === staleAtRevision.current) return; // still the failed read
    staleAtRevision.current = null;
    setErr((e) => (e?.kind === 'refresh' ? undefined : e));
  }, [targets.revision]);
  // Run a mutation, surface any failure, refresh the list. Reports the two
  // halves separately because they have different consequences for the caller:
  // `mutated` says the write landed (so the caller may clear its form), `ok`
  // says the list on screen is current again. A mutation that succeeded but
  // whose refresh failed *did* happen — collapsing both into one boolean would
  // leave the add form populated and invite a duplicate target, which
  // `addTarget` does not de-duplicate.
  const run = async (op: () => Promise<unknown>): Promise<{ mutated: boolean; ok: boolean }> => {
    setErr(undefined);
    setWarn(undefined);
    staleAtRevision.current = null;
    // Baseline captured *before* the request, not after: the revision a failed
    // re-read leaves behind is the one current now, and by the time `op()` resolves
    // a concurrent read may already have bumped it — arming the note against the
    // older value would make the retirement effect skip it (it already ran for the
    // new revision), so the note would linger for one extra read cycle and claim a
    // failure that fresh data has already disproved.
    const revisionBeforeRefresh = revisionRef.current;
    try {
      await op();
    } catch (e) {
      setErr({ kind: 'op', message: e instanceof Error ? e.message : tr('courses.opFailed') });
      return { mutated: false, ok: false };
    }
    // `refetch` records its own failure and returns the outcome instead of
    // throwing, so it has to be inspected explicitly: the list is now stale and
    // must not be reported as a clean success.
    const refresh = await targets.refetch();
    // A *superseded* result is not a failure and must not be reported as one: a
    // newer read won the race, so the list on screen is already the newer one —
    // and the revision may have moved before this continuation ran, which would
    // leave a "re-reading failed" note armed against a revision the effect has
    // already passed (so it lingers and misreports). The winner reports itself:
    // success ⇒ no note needed, failure ⇒ `targets.error` drives the bar.
    if (!refresh.ok && 'error' in refresh) {
      staleAtRevision.current = revisionBeforeRefresh;
      setErr({
        kind: 'refresh',
        message: `${tr('courses.savedButRefreshFailed')} ${refresh.error.message}`,
      });
      return { mutated: true, ok: false };
    }
    return { mutated: true, ok: refresh.ok };
  };

  const add = async (v: CourseFormValues) => {
    // Clear the form whenever the course was actually added — including when the
    // follow-up list refresh failed. Keying this off `ok` would keep the fields
    // filled after a successful add and let the user add the same CRN twice.
    const { mutated } = await run(() =>
      api.addTarget({
        term: v.term,
        subject: v.subject,
        courseNumber: v.courseNumber,
        targetCrn: v.targetCrn,
        faculty: v.faculty || undefined,
        label: v.label || undefined,
        mode: v.mode,
      }),
    );
    if (mutated) setAddKey((k) => k + 1); // remount (reset) the add form
  };

  const saveEdit = (id: string, v: CourseFormValues) =>
    run(async () => {
      await api.updateTarget(id, {
        term: v.term,
        subject: v.subject,
        courseNumber: v.courseNumber,
        targetCrn: v.targetCrn,
        faculty: v.faculty || undefined,
        label: v.label || undefined,
        mode: v.mode,
      });
      // A course the failure breaker stopped is revived by the server on a query-field
      // edit (Q3) — the error message tells the user to fix exactly these fields, so
      // saving them has to actually restart the watch. Make sure the engine is up,
      // otherwise the target flips back to 'watching' with nothing polling it.
      const wasErrored = (targets.data ?? []).find((t) => t.id === id)?.status === 'error';
      if (wasErrored) {
        try {
          await api.startScheduler();
        } catch {
          // Non-fatal: the save landed and the target is watching again. Say so
          // instead of letting a broken engine look like a successful restart.
          setWarn(tr('courses.editRestartFailed'));
        }
      }
      setEditing(null);
    });

  const remove = (id: string) => run(() => api.removeTarget(id));

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">{tr('courses.addACourse')}</h2>
      </div>
      <CourseForm key={addKey} submitLabel={tr('courses.addCourse')} onSubmit={add} />
      {err && <div className="errbar">{err.message}</div>}
      {/* Yields to `err`: a real failure is the more important message, and the two
          would otherwise stack. */}
      {warn && !err && <div className="banner">{warn}</div>}

      <div className="col-h" style={{ marginTop: 22 }}>
        <h2 className="serif">{tr('courses.managed')}</h2>
      </div>
      {/* Branch order matters, and this is the defect: `list.length === 0` cannot
          tell "you have no courses" from "we could not read your courses".
          - no data AND an error: the bar alone, never the empty state (that is the
            screen that invites re-adding a course the user still has, and
            `addTarget` does not de-duplicate). Checked explicitly on `error` rather
            than inferring it from `!settled`: a failed read *is* settled.
          - no data, no error, not settled yet: the loading state.
          - read, and the list really is empty: the empty state.
          - read, and there is a list: the list, including the stale one a failed
            refetch left behind, under the bar.
          The add form stays mounted either way so a course can still be added. */}
      <ResourceError resource={targets} label={tr('courses.loadFailedLabel')} />
      {targets.data === undefined && targets.error ? null : !targets.settled ? (
        <div className="empty glass">{tr('courses.loading')}</div>
      ) : targets.data !== undefined && list.length === 0 ? (
        <div className="empty glass">{tr('courses.empty')}</div>
      ) : (
        <div className="cards">
          {list.map((t) =>
            editing === t.id ? (
              <CourseForm
                key={t.id}
                submitLabel={tr('courses.save')}
                initial={{
                  term: t.term,
                  subject: t.subject,
                  courseNumber: t.courseNumber,
                  targetCrn: t.targetCrn,
                  faculty: t.faculty ?? '',
                  label: t.label ?? '',
                  mode: t.mode,
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
                    {tr('courses.edit')}
                  </button>
                  <button type="button" className="btn" onClick={() => remove(t.id)}>
                    {tr('courses.delete')}
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
