import '@testing-library/jest-dom/vitest';

// jsdom (opaque origin) doesn't provide a functional localStorage here — polyfill
// a simple in-memory one so i18n persistence can be exercised in tests.
if (typeof localStorage === 'undefined' || typeof localStorage.clear !== 'function') {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mock, configurable: true });
}

// jsdom ships no WebSocket, but the app shell opens exactly one (DataProvider's
// event stream) and every test that renders `DataProvider` would otherwise crash
// on `new WebSocket(...)`. The stub keeps the app code on its real path — no
// module mocking — while letting a test drive the socket: call
// `installFakeWebSocket()` to (re)install it and reset the tracked connections,
// then `lastFakeSocket()` to emit frames.
let sockets: StubWebSocket[] = [];

/** Minimal stand-in for a browser WebSocket, plus test-only `emit`/`open`. */
export class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  close(): void {
    this.readyState = 3;
  }
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  /** Deliver a server frame to this socket (the app's `onmessage` handler). */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  /** Open the connection (so the app flips its `connected` flag). */
  open(): void {
    this.onopen?.();
  }
}

/** Install a fresh fake WebSocket and forget previously tracked connections. */
export function installFakeWebSocket(): void {
  sockets = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
}

/** The most recently created socket, or undefined when nothing connected yet. */
export function lastFakeSocket(): StubWebSocket | undefined {
  return sockets[sockets.length - 1];
}

/** Whether the app has opened an event-stream socket at all. */
export function fakeSocketCount(): number {
  return sockets.length;
}

installFakeWebSocket();

// Initialize i18n and default tests to English so existing literal-string assertions hold.
const { default: i18n } = await import('./i18n');
void i18n.changeLanguage('en');
