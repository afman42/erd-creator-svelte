# erd-creator

Greenfield ERD designer: drag tables on a canvas, wire foreign keys, get MySQL
DDL that pastes straight into your database. The `.sql` file is the single
source of truth — re-open it and the diagram comes back exactly.

```
go run .        # → http://127.0.0.1:8731  (needs only Go; dist/ is committed)
```

![canvas: users → posts with FK edge, MySQL DDL panel](docs/screenshot.png)

## Features

- **Canvas** — add/rename/delete/duplicate tables (⧉), drag by header, `Del`
  deletes selection, `Ctrl+Z` undo, auto-layout by FK depth on file open
- **Columns** — name, type (`INT…JSON`, `ENUM` with editable values), per-column
  `PK` (composite supported) `NN` `UQ` `AI` `IX` flags, per-column comment
- **Relationships** — per-column `FK→` select + `ON DELETE` action; bezier edge
  renders automatically; type-mismatch lint in the header
- **Files** — the saved `.sql` *is* the model: Open re-parses, Save writes
  (`showSaveFilePicker` where supported, download fallback). `Copy INSERTs`
  emits seed-row templates. Draft auto-caches to localStorage
- **Dialect exports** (server-side, `POST /export`) — PostgreSQL, SQLite,
  MariaDB. Saved files stay MySQL-canonical; other dialects are export-only so
  the client parser remains one trivial grammar

## Architecture

```
frontend/src/geometry.js  canvas box metrics + FK edge paths         (pure, testable)
frontend/src/erd.js       model + MySQL generate/parse + lint + auto-layout   (pure, testable)
frontend/src/App.svelte   canvas, editing, file flows, undo, lint display
main.go                   embed.FS static server + route wiring        (~35 lines)
export.go                 dialect generators: mysql|postgres|sqlite    (Go, heavy grammar here)
```

- **Parse boundary**: the parser only reads DDL this tool itself emits — not
  arbitrary MySQL dumps. Unsupported clause → error banner, canvas state kept.
- **Split rule**: browser owns interaction; Go owns multi-dialect grammar.
  Pure logic (model, DDL, lint, layout, edge geometry) lives in DOM-free
  modules; `App.svelte` keeps only state + file/picker/export I/O.
- ENUM survives as case-sensitive `ENUM('a','b')`; dialect maps:
  Postgres → `TEXT + CHECK` / identity columns / `COMMENT ON`; SQLite →
  rowid-alias `INTEGER PRIMARY KEY` / inline `CHECK` / `--` comments.

## Development

```
cd frontend && pnpm install && pnpm run build   # regenerate dist/ (commit it)
cd frontend && pnpm test                      # node --test, zero test deps
go test ./...                                 # dialect generator tests
```

Edit frontend sources under `frontend/src/`; `frontend/dist/` is committed so
`go run .` stays a one-binary experience.

## Out of scope (deliberate)

Reverse-engineering live databases · Chen notation / M:N diamonds · stored box
positions (auto-layout instead) · ALTER/migration diffs · non-emitted SQL
dialects as input files · multi-user/server state.
