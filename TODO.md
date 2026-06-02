# AutoRegister — Project TODO

Maintained by the coding agent. Check off items as phases complete.
See design spec: `docs/superpowers/specs/2026-06-01-autoregister-design.md`.

## Phases (each = one PR → dev)

- [x] **P0 — Scaffolding**: monorepo, tooling, CI port, TODO, design doc
- [x] **P1 — shared**: decision engine (pure, fully tested) — parser moved to P3
- [x] **P2 — minerva-client/session**: persistent profile, login detection, health check
- [x] **P3 — minerva-client/query**: advanced search navigation + parse, match by target CRN
- [x] **P4 — minerva-client/register**: submit + waitlist re-submit + term check + error capture
- [ ] **P5 — store + scheduler + budget/pacing + notifier**
- [ ] **P6 — api**: REST + WebSocket
- [ ] **P7 — web**: Synapse UI wired to API (incl. one-click execute)
- [ ] **P8 — integration**: dry-run rehearsal, docs, polish

## Conventions

- Per-phase: feature branch → PR to `dev` → CI + AI review + human confirm → merge.
- Daily budget: queries 100/day, registrations 20/day (configurable).
- Default poll interval 30m ± 3m jitter; budget-aware scheduling.
