# AutoRegister

McGill Minerva course-seat watcher & auto-register tool. A local web app that
reuses your already-logged-in browser session to poll specified courses on a
jittered interval, decide register / waitlist / no-op per Minerva's seat rules,
and either act automatically or notify you.

> Personal automation for your own course registration. Use responsibly and in
> accordance with your school's terms of use.

## Status

Early development. See:

- Design spec: [`docs/superpowers/specs/2026-06-01-autoregister-design.md`](docs/superpowers/specs/2026-06-01-autoregister-design.md)
- Progress: [`TODO.md`](TODO.md)

## Tech

Node + TypeScript monorepo (npm workspaces): `packages/shared`, `packages/server`, `packages/web`.
Playwright (browser automation), Fastify + WebSocket (backend), React + Vite + Tailwind (Synapse-themed UI).

## Development

```bash
npm install      # install workspace deps
npm run lint     # ESLint
npm run typecheck
npm run test     # Vitest
```

Requires Node 22+.
