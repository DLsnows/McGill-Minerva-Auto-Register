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

// Initialize i18n and default tests to English so existing literal-string assertions hold.
const { default: i18n } = await import('./i18n');
void i18n.changeLanguage('en');
