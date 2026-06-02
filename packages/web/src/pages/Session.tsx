import { useEffect, useRef, useState } from 'react';
import { api, type SessionStatus } from '../lib/api';
import { useData } from '../lib/DataContext';

const LABEL: Record<SessionStatus, string> = {
  authenticated: 'Authenticated — automation can run.',
  'logging-in': 'Logging in… a browser window should be open.',
  'logged-out': 'Logged out — log in to let polling run.',
  unknown: 'Unknown — log in to establish a session.',
};

export default function Session() {
  const { session } = useData();
  const status = session.data?.status ?? 'unknown';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  // Keep the latest refetch in a ref so the polling effect can depend on
  // `status` alone — `session` is a fresh object on every refetch, so depending
  // on it would tear down and recreate the interval each tick (resetting the cap).
  const refetchRef = useRef(session.refetch);
  useEffect(() => {
    refetchRef.current = session.refetch;
  });

  // While logging in, poll the status until it resolves, with a ~36s safety cap.
  useEffect(() => {
    if (status !== 'logging-in') return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      void refetchRef.current();
      if (n >= 12) clearInterval(id);
    }, 3000);
    return () => clearInterval(id);
  }, [status]);

  const login = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.login();
      await session.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const dot = status === 'authenticated' ? 'dot-ok' : status === 'logging-in' ? 'dot-warn' : '';

  return (
    <div>
      <div className="col-h">
        <h2 className="serif">Session</h2>
      </div>
      <div className="card glass">
        <div style={{ fontSize: 16, marginBottom: 8 }}>
          <span className={`dot ${dot}`} />
          {status}
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, marginBottom: 14 }}>{LABEL[status]}</div>
        <button type="button" className="btn btn-accent" onClick={login} disabled={busy}>
          {busy ? 'Opening browser…' : 'Open browser & log in'}
        </button>
        {err && <div className="errbar">{err}</div>}
        <div style={{ color: 'var(--tx-3)', fontSize: 12, marginTop: 14 }}>
          McGill allows one active session — logging in elsewhere will evict the automation.
        </div>
      </div>
    </div>
  );
}
