## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Commands (narrowest wins)

| Change | Run |
| --- | --- |
| Go grammar/export/validate/security/files (`*.go`) | `go test ./...` |
| Frontend unit (`frontend/src/**`) | `cd frontend && pnpm test` |
| Canvas/export/e2e (`frontend/src/**`, `e2e/**`) | `cd frontend && pnpm run e2e` |
| Full gate before PR | `make test` |
| SQLite executable check | `go test -run TestSqliteEmitsExecutableDDL` (skips without sqlite3 CLI) |

## Generated output — do not hand-edit

- Editable: `frontend/src/**`, `*.go`, `schemas/*.sql`
- Generated: `frontend/dist/**`, `erd-creator` binary, `dist-bin/**`
- Rebuild: `make build` (dist + binary), `make dist` (cross-compile)
- `dist/` is committed; stale binary serves old UI. Rebuild after pull.

## Prohibitions

- NEVER echo rejected payload in errors/logs/reports.
- NEVER emit invalid SQL; return error via `Validate`/`GenSQL`.
- NEVER bind beyond loopback (`-host ""`/`0.0.0.0`) except trusted network; no auth exists.
- NEVER bypass `storePath` containment; NEVER hand-edit `frontend/dist`.

## Agent skills

### Go skills (always load)

For any Go task (grammar, validate, export, store, security, refactor, lint),
load `samber/cc-skills-golang@golang-how-to` first — it routes to the right
secondary skills per intent. Do not work on Go code without it.

### Required Go skills

Beyond routing, always apply these on Go changes in this repo:
- `.agents/skills/safe-sql-execution/SKILL.md` — grammar/Validate/GenSQL/export/import/store (first, not only at review)
- `samber/cc-skills-golang@golang-error-handling` — creation, wrapping, single-handling, slog
- `samber/cc-skills-golang@golang-safety` — nil traps, bounds, overflow on untrusted input
- `samber/cc-skills-golang@golang-lint` — `.golangci.yml` is source of truth; `make lint` gate
- `samber/cc-skills-golang@golang-security` — STRIDE/DREAD on trust-boundary crossings
- `samber/cc-skills-golang@golang-testing` — safety net before refactor; `-race` on concurrency

### Issue tracker

Issues live in GitHub Issues for afman42/erd-creator-svelte. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (root `GLOSSARY.md` + `docs/adr/`). See `docs/agents/domain.md`.

## Router

- Codebase question → `graphify query/path/explain` first; `graphify-out/wiki/index.md` for navigation; `GRAPH_REPORT.md` only for broad review.
- Perf regression/optimization ask → `svelte-performance-investigation` global skill.
- Frontend unit test ask → `.agents/skills/frontend-unit-testing/SKILL.md` (behaviour, frozen literals, VISUAL todos); `svelte-frontend-unit-testing` global skill if present.
- E2E / browser validation ask → `.agents/skills/playwright-cli/SKILL.md` (serial suite, probe, wipeStore); never point at real `schemas/`.
- Grammar/Validate/GenSQL/export/import/store ask → `.agents/skills/safe-sql-execution/SKILL.md` first, not only at review.
- After code change → `graphify update .`.
- Source of truth: README for architecture/threat model; Makefile for targets. Do not copy values here.
