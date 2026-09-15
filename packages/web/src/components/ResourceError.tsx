import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Resource } from '../lib/useResource';

/**
 * Inline error bar + retry button for a failed resource fetch (design doc §6:
 * "REST 失败：行内错误条 / toast，不使整页崩溃；按钮恢复可点击").
 *
 * A `useResource` failure is *sticky*: the mount effect never re-runs, so the
 * consumer must both say what failed and offer a way out. Rendering nothing here
 * (or letting the consumer fall through to its empty state) turns one transient
 * 5xx into a permanently wrong screen — "no courses watched yet" while the list
 * is merely unread, or a "loading…" line that never resolves.
 *
 * This bar is *additive*: it never replaces the data the consumer already holds.
 * `refetch()` keeps `data` on failure, so after a successful first read a later
 * blip yields stale-but-real data plus this bar — strictly better than hiding
 * the list.
 *
 * `label` is the already-translated name of the resource ("Courses", "Today's
 * budget", …); the shared `resource.loadFailed` key supplies the sentence around
 * it. The API error message is appended because it carries the HTTP status and the
 * URL, which is what makes a retry decision possible — but bounded, see `summarize`.
 */
const MAX_DETAIL = 160;

/** One line, at most `MAX_DETAIL` characters.
 *
 * `api.req` builds its message from the full response body, so a 502 from a proxy
 * arrives as an entire HTML error page. Printed verbatim that is a wall of markup
 * inside an inline alert; the actionable part is the first line — the status and
 * the URL — which fits comfortably in the budget. Only the display is clipped: the
 * full text is still what `resource.error` holds for logs and tests. */
function summarize(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_DETAIL ? oneLine : `${oneLine.slice(0, MAX_DETAIL - 1)}…`;
}
export function ResourceError({
  resource,
  label,
}: {
  resource: Pick<Resource<unknown>, 'error' | 'refetch'>;
  label: string;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  if (!resource.error) return null;
  return (
    <div className="errbar res-errbar" role="alert">
      <span>{`⚠️ ${t('resource.loadFailed', { name: label })} ${summarize(resource.error.message)}`}</span>
      <button
        type="button"
        className="btn"
        style={{ fontSize: 12, padding: '4px 10px' }}
        disabled={retrying}
        // No success callback: a consumer that owns a "the refresh failed" note
        // watches `resource.revision` instead, so its note is retired by *any* read
        // that lands — including one this button did not trigger — and never by a
        // read whose result was discarded as superseded.
        onClick={() => {
          setRetrying(true);
          void resource.refetch().finally(() => setRetrying(false));
        }}
      >
        {`⟳ ${t('resource.retry')}`}
      </button>
    </div>
  );
}
