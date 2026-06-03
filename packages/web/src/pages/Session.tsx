import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type SessionStatus } from '../lib/api';
import { useData } from '../lib/DataContext';

const STATE_KEY: Record<SessionStatus, string> = {
  authenticated: 'session.stateAuthenticated',
  'logging-in': 'session.stateLoggingIn',
  'logged-out': 'session.stateLoggedOut',
  unknown: 'session.stateUnknown',
};
const DESC_KEY: Record<SessionStatus, string> = {
  authenticated: 'session.descAuthenticated',
  'logging-in': 'session.descLoggingIn',
  'logged-out': 'session.descLoggedOut',
  unknown: 'session.descUnknown',
};

export default function Session() {
  const { t } = useTranslation();
  const { session } = useData();
  const status = session.data?.status ?? 'unknown';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [capped, setCapped] = useState(false);

  // Keep the latest refetch in a ref so the polling effect can depend on
  // `status` alone — `session` is a fresh object on every refetch, so depending
  // on it would tear down and recreate the interval each tick (resetting the cap).
  const refetchRef = useRef(session.refetch);
  useEffect(() => {
    refetchRef.current = session.refetch;
  });

  // While logging in, poll the status until it resolves, with a ~36s safety cap.
  // After the cap we re-enable the button (via `capped`) so a stuck login can be retried.
  useEffect(() => {
    if (status !== 'logging-in') {
      setCapped(false);
      return;
    }
    setCapped(false);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      void refetchRef.current();
      if (n >= 12) {
        clearInterval(id);
        setCapped(true);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [status]);

  const login = async () => {
    setBusy(true);
    setErr(undefined);
    setCapped(false);
    try {
      await api.login();
      await session.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('session.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const loggingIn = status === 'logging-in' && !capped;
  const dot = status === 'authenticated' ? 'dot-ok' : status === 'logging-in' ? 'dot-warn' : '';

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">{t('session.title')}</h2>
      </div>
      <div className="card glass">
        <div style={{ fontSize: 16, marginBottom: 8 }}>
          <span className={`dot ${dot}`} />
          {t(STATE_KEY[status])}
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, marginBottom: 14 }}>{t(DESC_KEY[status])}</div>
        <button type="button" className="btn btn-accent" onClick={login} disabled={busy || loggingIn}>
          {busy || loggingIn ? t('session.loggingInBtn') : t('session.openAndLogin')}
        </button>
        {err && <div className="errbar">{err}</div>}
        <div style={{ color: 'var(--tx-3)', fontSize: 12, marginTop: 14 }}>{t('session.singleSessionNote')}</div>
      </div>
    </div>
  );
}
