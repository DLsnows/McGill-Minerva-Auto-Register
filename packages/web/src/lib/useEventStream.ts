import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '@autoregister/shared';

interface StreamState {
  events: LogEvent[];
  connected: boolean;
}

/** Subscribe to /api/stream: seed from the `recent` snapshot, append `event`
 * messages (capped at `max`), and auto-reconnect with backoff on close. */
export function useEventStream(max = 500): StreamState {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let ws: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const cap = (arr: LogEvent[]) => (arr.length > max ? arr.slice(-max) : arr);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/stream`);
      ws.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as
          | { type: 'recent'; events: LogEvent[] }
          | { type: 'event'; event: LogEvent };
        if (msg.type === 'recent') setEvents(cap(msg.events));
        else setEvents((prev) => cap([...prev, msg.event]));
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current++);
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.close();
    };
  }, [max]);

  return { events, connected };
}
