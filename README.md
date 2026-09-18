# erd-creator

Greenfield ERD designer: drag tables on a canvas, wire foreign keys, get MySQL
DDL that pastes straight into your database. `.sql` files live in a server-side
schema directory — the Go process owns the grammar (generate/parse/lint) and
the store; re-open a file and the diagram comes back exactly.

```
make run        # → http://127.0.0.1:8731  (Go + Node/pnpm; builds dist/ first)
```

## Features

- **Canvas** — add/rename/delete/duplicate tables (⧉), drag by header, `Del`
  deletes selection, `Ctrl+Z` undo, auto-layout by FK depth on file open.
  New tables auto-name `table1`, `table2`, … and duplicates `users_copy`,
  `users_copy2`, …; undo history is per-file, so `Ctrl+Z` never restores a
  schema across a file switch
- **Columns** — name, type (`INT…JSON`, `ENUM` with editable values), per-column
  `PK` (composite supported) `NN` `UQ` `AI` `IX` flags, per-column comment
- **Relationships** — per-column `FK→` select + `ON DELETE` action; bezier edge
  renders automatically; type-mismatch lint (server-side) in the header
- **Files** — schema store in `-dir` (default `./schemas`): Files dropdown +
  New/Save/Del; saves debounce-autosave the current file — switching or
  deleting a file flushes the pending save first. Server generates and
  parses the canonical MySQL DDL; `Copy INSERTs` emits seed-row templates
- **Dialect exports** (`POST /export`) — PostgreSQL, SQLite, MariaDB. Saved
  files stay MySQL-canonical; other dialects are export-only

## Architecture

```
frontend/src/geometry.js     (canvas box metrics + FK edge paths)   (pure, testable)
frontend/src/erd.js          (UI helpers + naming + auto-layout)    (pure, testable)
frontend/src/schema.svelte.js(store: model state, mutations, undo, fetch glue)
frontend/src/App.svelte      (canvas rendering, drag/keys, SQL panel toggle)
grammar.go              model + MySQL parse/lint + inserts  (canonical grammar)
files.go                working-dir .sql store (GET/PUT/DELETE)
export.go               dialect generators: mysql|mariadb|postgres|sqlite
main.go                 embed.FS server + API route wiring
```

- **One MySQL emitter**: `GenSQL` (the saved file) delegates to `buildMysql`
  (the `/export` path), so save and export cannot drift. `TestGenSQLGolden`
  pins the saved-file bytes — that format is a contract with existing `.sql`.
- **Parse boundary**: `ParseDDL` only reads DDL this tool itself emits — not
  arbitrary MySQL dumps. Unsupported clause → 400 error banner, canvas kept.
- **FK onto a PK-less parent** is omitted from every dialect (an FK target must
  be unique) and reported by `Lint()` rather than silently redirected to the
  first column.
- **Split rule**: browser owns interaction/pixels; Go owns grammar + storage.
  Model travels as JSON; ids are client-allocated (`adoptIds`).
- ENUM survives as case-sensitive `ENUM('a','b')`; dialect maps:
  Postgres → `TEXT + CHECK` / identity columns / `COMMENT ON`; SQLite →
  rowid-alias `INTEGER PRIMARY KEY` / inline `CHECK` / `--` comments.

## Development

```
make test       # node --test + go test (also rebuilds dist/)
make build      # rebuild dist/ + static binary
cd frontend && pnpm run e2e   # UI flows against the real server (chromium)
cd frontend && pnpm test      # node --test, zero test deps
go test ./...                       # grammar/dialect/export tests
```

Edit frontend sources under `frontend/src/`; `frontend/dist/` is built into
the server at compile time (`go:embed`) — `make build` regenerates it.

## Out of scope (deliberate)

Reverse-engineering live databases · Chen notation / M:N diamonds · stored box
positions (auto-layout instead) · ALTER/migration diffs · non-emitted SQL
dialects as input files · multi-user/auth (single local user, 127.0.0.1).
