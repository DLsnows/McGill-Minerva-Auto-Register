# AutoRegister — Project TODO

Maintained by the coding agent. Check off items as phases complete.
See design spec: `docs/superpowers/specs/2026-06-01-autoregister-design.md`.

## Phases (each = one PR → dev)

- [x] **P0 — Scaffolding**: monorepo, tooling, CI port, TODO, design doc
- [x] **P1 — shared**: decision engine (pure, fully tested) — parser moved to P3
- [x] **P2 — minerva-client/session**: persistent profile, login detection, health check
- [x] **P3 — minerva-client/query**: advanced search navigation + parse, match by target CRN
- [x] **P4 — minerva-client/register**: submit + waitlist re-submit + term check + error capture
- [x] **P5 — store + scheduler + budget/pacing + notifier**
- [x] **P6 — api**: REST + WebSocket (email config moved into Settings/UI-editable)
- [x] **P7 — web**: web UI wired to API — P7a scaffold + theme + data layer + Dashboard, P7b Courses/Session/Settings + shared data provider, P7c i18n (中文/EN/FR), P7d Courses-form help + faculty required
- [x] **P8 — integration**: dry-run rehearsal mode (Settings toggle) + README/docs

🎉 All phases complete.

## Conventions

- Per-phase: feature branch → PR to `dev` → CI + AI review + human confirm → merge.
- Daily budget: queries 100/day, registrations 20/day (configurable).
- Default poll interval 30m ± 3m jitter; budget-aware scheduling.
