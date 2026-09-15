/**
 * Regression tests for Q5 (local API has no Host/Origin/CSRF guard) and Q6
 * (the `/api/stream` upgrade accepts any Origin and has an unbounded payload).
 *
 * These deliberately drive a **real `app.listen()` on a real port over real TCP**
 * instead of `app.inject()`: the findings were reproduced that way (a cross-site
 * `<form method=POST enctype=text/plain>` and a hostile `Origin` websocket
 * handshake), and `inject()` cannot reproduce either faithfully. The `Host` header
 * in particular is only a real, attacker-controlled value — and the whole point of
 * a DNS-rebinding guard — once the request has travelled over a socket.
 *
 * Every "this is rejected" assertion is paired with a "the same request from the
 * application's own origin still works" assertion, so the guard cannot be
 * satisfied by simply breaking the app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { Store } from '../store/store';
import { Budget } from '../budget/budget';
import { buildServer, type ApiDeps } from './server';

/** The application's own origin, i.e. what the UI in a browser actually sends. */
const APP_ORIGIN = 'http://127.0.0.1';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Bind an ephemeral port and report the one the OS actually handed out.
 *
 * Do NOT replace this with a "find a free port, close it, then listen on it"
 * helper: that is a TOCTOU race (another process or a parallel vitest worker can
 * take the port between the probe and the real `listen`), and `EADDRINUSE` from it
 * is exactly the flake class that already bit the e2e suite once. Letting the
 * kernel choose the port and keeping the same listener means the port is never
 * unowned, and it also avoids hard-coding 4575 (a real dev server may hold it).
 */
async function listenOnEphemeralPort(instance: FastifyInstance): Promise<number> {
  await instance.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.server.address() as AddressInfo | null;
  if (!address) throw new Error('server.listen() resolved without a bound address');
  return address.port;
}

/** A real HTTP round trip with full control over `Host`, `Origin` and `Content-Type`. */
function send(
  port: number,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: init.method ?? 'GET',
        path: init.path ?? '/',
        headers: init.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** "Same-origin" headers for `opts.origin ?? APP_ORIGIN`, with the matching Host. */
function sameOriginHeaders(
  port: number,
  opts: { origin?: string; host?: string; contentType?: string } = {},
): Record<string, string> {
  const origin = opts.origin ?? APP_ORIGIN;
  const headers: Record<string, string> = {
    host: opts.host ?? `127.0.0.1:${port}`,
    origin: `${origin}${new URL(origin).port ? '' : `:${port}`}`,
  };
  if (opts.contentType) headers['content-type'] = opts.contentType;
  return headers;
}

/** Attempt a websocket handshake carrying `Origin`; resolve with the outcome. */
function tryUpgrade(port: number, origin?: string): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, {
      headers: origin === undefined ? {} : { origin },
    });
    const settle = (r: { opened: boolean; status?: number }) => {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    ws.on('open', () => settle({ opened: true }));
    ws.on('unexpected-response', (_req, res) => settle({ opened: false, status: res.statusCode }));
    ws.on('error', (err: Error & { code?: string }) =>
      settle({ opened: false, status: err.code === 'ECONNRESET' ? 0 : undefined }),
    );
  });
}

/** First message the server pushes on connect (the recent-events snapshot). */
function firstMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no websocket message received')), 3000);
    ws.on('message', (d) => {
      clearTimeout(timer);
      resolve(String(d));
    });
  });
}

let dir: string;
let port: number;
let app: FastifyInstance;
let store: Store;
let calls: { start: number; stop: number; run: number };

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-sec-'));
  store = new Store(dir);
  calls = { start: 0, stop: 0, run: 0 };
  const deps: ApiDeps = {
    store,
    budget: new Budget(store),
    session: {
      launch: async () => undefined,
      ensureLoggedIn: async () => undefined,
      isLoggedIn: async () => true,
    },
    scheduler: {
      start: () => {
        calls.start += 1;
      },
      stop: () => {
        calls.stop += 1;
      },
      runTarget: () => {
        calls.run += 1;
      },
      isRunning: () => false,
    },
  };
  app = buildServer(deps);
  port = await listenOnEphemeralPort(app);
}

beforeEach(boot);
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Q5 — Host / Origin / CSRF guard', () => {
  it('rejects the audited cross-site form post (text/plain, hostile Origin) without side effects', async () => {
    const t = store.addTarget({
      term: '202701',
      subject: 'COMP',
      faculty: 'Faculty of Science',
      courseNumber: '551',
      targetCrn: '1814',
      mode: 'auto',
    });
    expect(t.status).toBe('watching');

    // Exactly what the auditor observed: a browser cannot preflight this request,
    // so it reaches the server with no `Origin` of its own choosing and a
    // `text/plain` body that no route reads.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop-all',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://evil.example.com',
        'content-type': 'text/plain',
      },
      body: 'stop-all\r\n',
    });

    expect(r.status).toBe(403);
    // The audited 200 used to pause every course, stop the engine and rewrite
    // store.json. None of that may happen now.
    expect(store.getTarget(t.id)!.status).toBe('watching');
    expect(calls.stop).toBe(0);
  });

  it('rejects a bodyless cross-site post (no Content-Type at all) from a hostile Origin', async () => {
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/start-all',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://attacker.test' },
    });
    expect(r.status).toBe(403);
    expect(calls.start).toBe(0);
  });

  it('rejects a bodyless cross-site post that only declares a non-JSON Content-Type', async () => {
    // 0-byte text/plain form submissions exist; the origin check is not the only
    // line of defence, so the media type must be refused on its own too.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/start',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://evil.example.com',
        'content-type': 'text/plain;charset=UTF-8',
      },
    });
    expect(r.status).toBe(403);
    expect(calls.start).toBe(0);
  });

  it('rejects a cross-site post carrying the application/json content-type the UI uses', async () => {
    // Content-Type alone can never be the only gate: a same-origin-forged request
    // would sail past it, so the Origin check must refuse this too.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: sameOriginHeaders(port, {
        origin: 'http://evil.example.com',
        contentType: 'application/json',
      }),
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('rejects a forged Host header (DNS rebinding) even with a normal GET', async () => {
    const r = await send(port, {
      method: 'GET',
      path: '/api/settings',
      headers: { host: `evil.example.com:${port}` },
    });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('pollIntervalMinutes');
  });

  it('rejects a forged Host header on a bodyless write', async () => {
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: 'evil.example.com' },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('rejects a non-JSON body from an allowed origin with 415', async () => {
    const r = await send(port, {
      method: 'POST',
      path: '/api/targets',
      headers: sameOriginHeaders(port, { contentType: 'text/plain' }),
      body: 'term=202701\r\n',
    });
    expect(r.status).toBe(415);
  });

  // --- the other half of the contract: the application itself must keep working ---

  it('lets the real UI keep working: same-origin reads, bodyless writes and JSON writes', async () => {
    const list = await send(port, { path: '/api/targets', headers: sameOriginHeaders(port) });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual([]);

    // Bodyless POSTs (what `packages/web/src/lib/api.ts` sends: no body, hence no
    // Content-Type) must not be broken by the content-type rule.
    const start = await send(port, {
      method: 'POST',
      path: '/api/scheduler/start',
      headers: sameOriginHeaders(port),
    });
    expect(start.status).toBe(200);
    expect(JSON.parse(start.body)).toEqual({ running: true });
    expect(calls.start).toBe(1);

    const stopAll = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop-all',
      headers: sameOriginHeaders(port),
    });
    expect(stopAll.status).toBe(200);

    const created = await send(port, {
      method: 'POST',
      path: '/api/targets',
      headers: sameOriginHeaders(port, { contentType: 'application/json' }),
      body: JSON.stringify({
        term: '202701',
        subject: 'COMP',
        faculty: 'Faculty of Science',
        courseNumber: '551',
        targetCrn: '1814',
        mode: 'auto',
      }),
    });
    expect(created.status).toBe(200);
    expect(JSON.parse(created.body).targetCrn).toBe('1814');
  });

  it('allows localhost and IPv6 loopback origins, not just 127.0.0.1', async () => {
    const localhost = await send(port, {
      path: '/api/health',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    });
    expect(localhost.status).toBe(200);
    expect(JSON.parse(localhost.body)).toEqual({ ok: true });

    const v6 = await send(port, {
      path: '/api/health',
      headers: { host: `[::1]:${port}`, origin: `http://[::1]:${port}` },
    });
    expect(v6.status).toBe(200);
  });

  it('allows a plain HTTP request with no Origin header (Node fetch / curl / CLI send none)', async () => {
    // One half of an INTENTIONAL asymmetry between plain HTTP and the websocket
    // upgrade; the other half is the "no Origin at all" websocket case below. The
    // asymmetry is load-bearing in both directions:
    //   - `e2e/run.mjs` drives the API with Node's `fetch`, which sends no
    //     `Origin` (readiness probe + ledger probe). Requiring it here would take
    //     the whole e2e suite down.
    //   - every browser-originated cross-site attack DOES send `Origin`, and that
    //     case is refused (see the tests above).
    // If someone "unifies" the two sides, exactly one of these two tests must go
    // red — that is the point of pinning both.
    const read = await send(port, { path: '/api/health', headers: { host: `127.0.0.1:${port}` } });
    expect(read.status).toBe(200);

    const write = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(write.status).toBe(200);
    expect(calls.stop).toBe(1);
  });

  it('rejects an Origin whose host matches a loopback alias but not the request Host', async () => {
    // A request that reaches `localhost:PORT` but claims `127.0.0.1:PORT` is not
    // same-origin, even though both names are loopback.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('rejects a mismatched Origin port', async () => {
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port + 1}` },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('rejects an Origin whose scheme is not the one this API is served over', async () => {
    // Rule 2 pins `http:`. Without that, `origin.name`/`origin.port` alone would
    // accept `Origin: https://127.0.0.1:<port>` as "same-origin" — a scheme this
    // server never speaks (it listens without TLS).
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: `127.0.0.1:${port}`, origin: `https://127.0.0.1:${port}` },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('pins rule 2 to the port the request arrived on, so a forged Host port cannot widen it', async () => {
    // Rule 1 checks the Host *name* only (the bound port is not known when the
    // server is built). Rule 2 is what pins the port: it compares against the Host
    // the request actually carried, so name-only rule 1 cannot be paired with a
    // free-floating Origin.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { host: '127.0.0.1:9999', origin: `http://127.0.0.1:${port}` },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('sends X-Frame-Options and a frame-ancestors CSP on responses (clickjacking)', async () => {
    const api = await send(port, { path: '/api/health', headers: sameOriginHeaders(port) });
    expect(api.headers['x-frame-options']).toBe('DENY');
    expect(String(api.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  // --- rule 4: `Sec-Fetch-Site`, the signal a page cannot forge ---------------

  it('rejects a write whose Sec-Fetch-Site says cross-site', async () => {
    // A cross-site form post reports `cross-site`. The value is a forbidden header
    // name, so page script cannot set it to `same-origin` — this is the one signal
    // that survives a fully forged Origin.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop-all',
      headers: { ...sameOriginHeaders(port), 'sec-fetch-site': 'cross-site' },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('rejects a write whose Sec-Fetch-Site says same-site (no such site for a loopback literal)', async () => {
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/stop',
      headers: { ...sameOriginHeaders(port), 'sec-fetch-site': 'same-site' },
    });
    expect(r.status).toBe(403);
    expect(calls.stop).toBe(0);
  });

  it('allows a write whose Sec-Fetch-Site is same-origin or none', async () => {
    for (const site of ['same-origin', 'none']) {
      const r = await send(port, {
        method: 'POST',
        path: '/api/scheduler/start',
        headers: { ...sameOriginHeaders(port), 'sec-fetch-site': site },
      });
      expect(r.status).toBe(200);
    }
    expect(calls.start).toBe(2);
  });

  it('allows a write with no Sec-Fetch-Site at all (Node, curl and CLI send none)', async () => {
    // "Present → validate, absent → allow": non-browser clients never send the
    // header, and they can forge every header anyway, so this stays permissive.
    const r = await send(port, {
      method: 'POST',
      path: '/api/scheduler/start',
      headers: { ...sameOriginHeaders(port) },
    });
    expect(r.status).toBe(200);
  });

  it('does not apply Sec-Fetch-Site to reads (a cross-site GET is already blinded by CORS)', async () => {
    const r = await send(port, {
      path: '/api/health',
      headers: { ...sameOriginHeaders(port), 'sec-fetch-site': 'cross-site' },
    });
    expect(r.status).toBe(200);
  });
});

describe('Q6 / Q18 — websocket upgrade origin + payload limit', () => {
  it('refuses a hostile Origin handshake', async () => {
    const r = await tryUpgrade(port, 'http://evil.example.com');
    expect(r.opened).toBe(false);
    expect(r.status).toBe(403);
  });

  it('refuses a hostile-Origin handshake even when it forges a matching Host', async () => {
    // `Origin` and `Host` disagreeing is the cross-site case; this is what a
    // DNS-rebound page sees, where both names are the attacker's domain.
    const r = await tryUpgrade(port, `http://attacker.test:${port}`);
    expect(r.opened).toBe(false);
  });

  it('refuses a handshake with no Origin at all (the strict half of the HTTP/WS asymmetry)', async () => {
    // Unlike plain HTTP — where a missing Origin only means "not a browser" and
    // must stay allowed (see the Node-fetch test above) — a browser ALWAYS sends
    // Origin on a websocket handshake, so its absence proves the peer is not this
    // application's page. Nothing here opens a raw websocket, so nothing
    // legitimate is lost.
    const r = await tryUpgrade(port, undefined);
    expect(r.opened).toBe(false);
    expect(r.status).toBe(403);
  });

  it('accepts the application origin and still delivers the recent-events snapshot', async () => {
    store.appendEvent({ level: 'info', message: 'stream hello' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    try {
      const msg = JSON.parse(await firstMessage(ws)) as {
        type: string;
        events: { message: string }[];
      };
      expect(msg.type).toBe('recent');
      expect(msg.events.some((e) => e.message === 'stream hello')).toBe(true);
    } finally {
      ws.terminate();
    }
  });

  it('caps the inbound message size at 1 MiB (ws default was 100 MiB)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    try {
      await firstMessage(ws); // snapshot => the connection is live
      // 2 MiB is well past any legitimate client message (the UI never sends one)
      // and still below the pre-fix limit: `ws@8`'s WebSocketServer default is
      // `maxPayload: 100 * 1024 * 1024` (verified: `wss.options.maxPayload` is
      // 104857600), NOT unlimited — so this asserts the ~100x tightening, not the
      // difference between a limit and no limit at all.
      const result = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('accepted'), 4000);
        ws.on('close', (code) => {
          clearTimeout(timer);
          resolve(`closed:${code}`);
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve('error');
        });
        try {
          ws.send(Buffer.alloc(2 * 1024 * 1024));
        } catch {
          resolve('error');
        }
      });
      expect(result).not.toBe('accepted');
    } finally {
      ws.terminate();
    }
  });

  it('still delivers messages that stay under the 1 MiB cap', async () => {
    // The other half of the cap's contract: it must not break the protocol. A
    // client ping must survive, and the server's own broadcast path is unaffected.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    try {
      await firstMessage(ws);
      const stillOpen = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
        ws.on('close', () => {
          clearTimeout(timer);
          resolve(false);
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        ws.send('ping');
        ws.ping();
      });
      expect(stillOpen).toBe(true);
    } finally {
      ws.terminate();
    }
  });
});

describe('Q5 — guard is not satisfied by rejecting everything', () => {
  it('keeps serving the SPA entry point and unknown non-API routes from the app origin', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'autoreg-sec-dist-'));
    const prev = process.env.AUTOREG_WEB_DIST;
    process.env.AUTOREG_WEB_DIST = distDir;
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Synapse</title>');
    const local = buildServer({
      store: new Store(dir),
      budget: new Budget(new Store(dir)),
      session: {
        launch: async () => undefined,
        ensureLoggedIn: async () => undefined,
        isLoggedIn: async () => true,
      },
      scheduler: {
        start: () => undefined,
        stop: () => undefined,
        runTarget: () => undefined,
        isRunning: () => false,
      },
    });
    const localPort = await listenOnEphemeralPort(local);
    try {
      for (const path of ['/', '/courses', '/settings']) {
        const r = await send(localPort, { path, headers: { host: `127.0.0.1:${localPort}` } });
        expect(r.status).toBe(200);
        expect(r.body).toContain('Synapse');
      }
    } finally {
      await local.close();
      if (prev === undefined) delete process.env.AUTOREG_WEB_DIST;
      else process.env.AUTOREG_WEB_DIST = prev;
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});
