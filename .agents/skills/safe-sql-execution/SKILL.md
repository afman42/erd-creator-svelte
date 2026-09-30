---
name: safe-sql-execution
description: "Use BEFORE writing or reviewing any Go code that builds, validates, parses, or emits DDL (grammar, Validate/GenSQL, export, import, file store). Load this first, not only at review."
---

# Safe SQL (this repo)

Threat shape adapted from supabase/supabase `safe-sql-execution` — pinned
[SKILL.md](https://github.com/supabase/supabase/blob/2cd9b42e803277edefaa02e8aa5e4cdc27c19bb2/.agents/skills/safe-sql-execution/SKILL.md)
(see upstream LICENSE). Rejected: `pg-meta` TS brands (`SafeSqlFragment`,
`ident`/`literal`/`acceptUntrustedSql`) — here the boundary is Go
`Validate`/`GenSQL` in `validate.go` / `grammar*.go`.

## Boundary

- `Validate` is the trust boundary; emitters return an error via `GenSQL`
  instead of emitting invalid input. A caller that forgets to validate gets an
  error, not a footgun. NEVER emit invalid SQL.
- The file parser applies the SAME checks, so a malicious `.sql` cannot persist
  an injection that re-emits on every save. Round-trip is the property to test.

## Rules (`validate.go`)

- Identifiers (table/column/index names): allowlist charset, no C0/C1/DEL
  (`hasControlChar` — a newline breaks the line-oriented format), `maxNameLen 128`.
- Errors name position and echo only a sanitized excerpt (`excerpt()` 32ch /
  `lineExcerpt()`, cut at the first control char — `main.go failValidation`
  echoes because the message is excerpt-safe by construction; filesystem
  faults use `internalFail` instead). NEVER raw payload.
- Types are raw text (grammar is open-ended: `DECIMAL(10,2)`, `ENUM('a','b')`),
  so they need the strict check, not quoting: `isValidTypeExpr` allows a bare
  name or `name(args)` plus ONE Postgres `[]` suffix. `INT[][]` and `ENUM[]`
  are refused; `--` and `/*` refused; strings opaque with `''` escape.
- `DEFAULT` expressions are allowlist-validated like types (semicolons only
  inside quotes, comments refused), `maxDefaultLen 2048`.
- Caps: `maxTypeLen` / `maxCommentLen` 4096, `maxTables` / `maxColumns` /
  `maxIndexes` 500, 1 MiB body cap.
- Errors are terse and NEVER echo the rejected payload — not in responses,
  logs, or pasted reports.

## Watch files / checks

- Security-sensitive: `validate.go`, `grammar*.go`, `security.go`, `files.go`
  (`storePath` containment), `export.go`, `import.go`.
- `go test ./...`, plus `go test -run TestSqliteEmitsExecutableDDL`.
- Prefer contract tests (round-trip, re-emit equality) over change-detectors
  that fail on every legitimate grammar addition.
