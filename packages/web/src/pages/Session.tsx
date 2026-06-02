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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // While logging in, poll the status until it resolves.
  useEffect(() => {
    if (status === 'logging-in' && !pollRef.current) {
      let n = 0;
      pollRef.current = setInterval(() => {
        n += 1;
        void session.refetch();
        if (n >= 12 && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 3000);
    }
    if (status !== 'logging-in' && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status, session]);

  const login = async () => {
    setBusy(true);
    try {
      await api.login();
      await session.refetch();
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
        <div style={{ color: 'var(--tx-3)', fontSize: 12, marginTop: 14 }}>
          McGill allows one active session — logging in elsewhere will evict the automation.
        </div>
      </div>
    </div>
  );
}
