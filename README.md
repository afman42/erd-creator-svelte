# erd-creator

Greenfield ERD designer: drag tables on a canvas, wire foreign keys, get MySQL
DDL that pastes straight into your database. `.sql` files live in a server-side
schema directory — the Go process owns the grammar (generate/parse/lint) and
the store; re-open a file and the diagram comes back exactly.

```
make run        # → http://127.0.0.1:8731  (Go + Node/pnpm; builds dist/ first)
```

## Configuration

```
./erd-creator -dir schemas -host 127.0.0.1 -port 8731
```

| Flag | Default | Meaning |
|---|---|---|
| `-dir` | `schemas` | directory holding the `.sql` files (created if missing) |
| `-host` | `127.0.0.1` | interface to bind; `""` binds every interface |
| `-port` | `8731` | TCP port; `0` asks the OS for a free one |

The default binds **loopback only**. `-host ""` (or `-host 0.0.0.0`) exposes the
server on every interface — there is no authentication, so anything that can
reach the port can read and write your schemas. Use it on a trusted network only.

`-port 0` is useful for running several instances at once; the chosen port is
printed on startup, since that is the only way to learn it.

The frontend is served from the same origin and uses relative paths, so changing
host or port needs no frontend rebuild — open the printed URL.

## Security

This is a single-user tool with **no authentication**. Everything below assumes
the caller reached the port, so the goal is to limit what reaching it gets you
and to keep the SQL this tool emits safe to paste into a database.

**Threat model.** The untrusted inputs are (1) HTTP request bodies, (2) `.sql`
files in the store — they may be hand-written or written by another tool — and
(3) the Host and Origin headers. The asset is the schema store and, more
importantly, the DDL this program generates: a value that escapes its position
becomes injection in whatever database the user pastes the output into.

| Control | What it stops |
|---|---|
| **Schema validation** on every path that reads or emits (`Validate`) | SQL injection through a type, name, or comment; control characters that break the line-oriented file format; oversized input |
| **`GenSQL` returns an error** instead of emitting invalid input | A caller that forgets to validate gets an error, not a footgun |
| **Host allowlist** | DNS rebinding — a page whose name resolves to 127.0.0.1 is refused, because its Host is not a name this server answers to |
| **Origin check on mutating methods** | Cross-site writes from any page the user visits |
| **Symlink containment** (`storePath`, `os.CreateTemp`) | A planted link in the store reading or overwriting a file outside it |
| **Security headers** (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`) | XSS, clickjacking, MIME confusion. The CSP is strict (`script-src 'self'`, no inline) and the built app has no inline script or style to allow |
| **Server timeouts** | Slowloris — a stalled connection is closed after 10s |
| **1 MiB body cap** | Memory exhaustion from an oversized request |

The `type` field is the subtle one. Types are emitted as raw text because the
grammar is open-ended (`DECIMAL(10,2)`, `ENUM('a','b')`), so unlike an
identifier they cannot simply be quoted — `VARCHAR(1;DROP TABLE users;--)` was
emitted verbatim before validation. Types are now matched against a strict
pattern, and the file parser applies the same check, so a malicious `.sql`
cannot persist an injection that re-emits on every save.

**Not in scope, deliberately:** authentication (single local user), TLS (plain
HTTP on loopback), and rate limiting (a local tool has no remote attacker to
throttle; the body cap and timeouts bound the damage). If you bind beyond
loopback with `-host`, you are putting an unauthenticated service on the
network — do that only on a network you trust.

Error messages are deliberately terse and never echo a rejected payload: a
response, a log, or a pasted bug report is not a place to reproduce an attack
string.

## Features

- **Canvas** — add/rename/delete/duplicate tables (⧉), drag by header, `Del`
  deletes selection, `Ctrl+Z` undo, auto-layout by FK depth on file open.
  New tables auto-name `table1`, `table2`, … and duplicates `users_copy`,
  `users_copy2`, …; undo history is per-file, so `Ctrl+Z` never restores a
  schema across a file switch
- **Columns** — each column is a read-only row: name, type, active flag badges,
  the FK target, and a ✎ button that opens the edit dialog. The dialog holds
  name, type (`INT…JSON`, `ENUM` with editable values), the `PK` (composite
  supported) `NN` `UQ` `AI` `IX` flags, the FK and its `ON DELETE` action, the
  comment, and Remove. It is a native `<dialog>`, so Escape closes it and focus
  is trapped while it is open. (The ten controls used to sit inline in a 280px
  row, where they needed ~342px and clipped; the row's 26px height and the
  comment line's 16px are unchanged, so FK edge anchors are unaffected.)
- **Relationships** — per-column `FK→` select + `ON DELETE` action; bezier edge
  renders automatically; type-mismatch lint (server-side) in the header
- **Files** — schema store in `-dir` (default `./schemas`): Files dropdown +
  New/Save/Del; saves debounce-autosave the current file — switching or
  deleting a file flushes the pending save first. The server generates and
  parses the file's DDL in its own dialect; `Copy INSERTs` emits seed-row
  templates (MySQL syntax)
- **Dialects** — one dropdown selects the DDL flavor, and it drives everything:
  what Save writes, the SQL panel, Copy SQL and Export (downloads a `.sql`
  file named after the current file, or `<dialect>-schema.sql` for unsaved
  schemas). All four dialects are saveable: each has a parser, so a saved file
  reopens and keeps its own dialect rather than silently becoming MySQL.

  `mariadb` shares the MySQL grammar: every construct we emit is valid in both,
  so the two files differ only in the header comment. It is nonetheless its own
  dialect, because a schema saved as MariaDB should reopen as MariaDB rather
  than silently becoming MySQL. The emitters are separate functions
  (`buildMysql`, `buildMariaDB`) so MariaDB-specific syntax has somewhere to go;
  `TestMariaDBMatchesMysql` pins them to identical output so the moment they
  diverge — deliberately or by accident — the test fails and forces a decision.

  `postgres` and `sqlite` each have their own emitter *and* parser, because
  their grammars differ structurally rather than in quoting — see the dialect
  map below. `sqlite` additionally exposes a **types** control, shown only while
  sqlite is selected, choosing how the types SQLite has no storage class for are
  written (`sqliteTypes`, default `native`):

  - `native` — keep the model's type name (`BOOLEAN`, `DATETIME`). SQLite
    accepts these and stores them verbatim, so reopening returns the same type
    and a later export to MySQL/Postgres is not silently downgraded. **Lossless.**
  - `portable` — rewrite to the storage class SQLite would pick anyway
    (`BOOLEAN` → `INTEGER`, `DATETIME`/`TIMESTAMP` → `TEXT`). For readers that
    key off the declared type name. **Lossy**: the model type is gone on reopen.

  The mode changes the saved bytes, so it is recorded in the file's header
  (`(SQLite, types: portable)`) and travels with the schema — otherwise a
  portable file would reopen as native and the next added `BOOLEAN` column would
  contradict the file's own contents. `ENUM` is unaffected either way.

## Architecture

```
frontend/src/geometry.js     (canvas box metrics + FK edge paths)   (pure, testable)
frontend/src/erd.js          (UI helpers + naming + dialects + layout)(pure, testable)
frontend/src/schema.svelte.js(store: model state, mutations, undo, fetch glue)
frontend/src/App.svelte      (canvas rendering, drag/keys, SQL panel toggle)
grammar.go              model + mysql/mariadb parse/lint + inserts
grammar_postgres.go     postgres parse (reads buildPostgres output)
grammar_sqlite.go       sqlite parse (reads buildSqlite output)
validate.go             trust boundary: schema + output validation
security.go             HTTP hardening: headers, Host/Origin guards, timeouts
files.go                working-dir .sql store (GET/PUT/DELETE)
export.go               dialect emitters: mysql|mariadb|postgres|sqlite
main.go                 embed.FS server + API route wiring
```

- **One emitter per dialect**: `GenSQL` (the saved file) delegates to the same
  `buildMysql` / `buildPostgres` the `/export` path uses, so save and export
  cannot drift. `TestGenSQLGolden` and `TestPostgresGolden` pin the saved-file
  bytes — that format is a contract with existing `.sql`.
- **Dialect detection on open**: the header comment decides the parser
  (`-- Generated by erd-creator (PostgreSQL)`). Anything unmarked parses as
  mysql, so files written before dialects existed keep loading unchanged, and
  the mysql header is deliberately unchanged to avoid churning them.
- **Parse boundary**: `ParseDDL` only reads DDL this tool itself emits — not
  arbitrary dumps. Unsupported clause → 400 error banner, canvas kept.
- **FK onto a PK-less parent** is omitted from every dialect (an FK target must
  be unique) and reported by `Lint()` rather than silently redirected to the
  first column.
- **Split rule**: browser owns interaction/pixels; Go owns grammar + storage.
  Model travels as JSON; ids are client-allocated (`adoptIds`).
- ENUM survives as case-sensitive `ENUM('a','b')`; dialect maps:
  Postgres → `TEXT + CHECK` / identity columns / `COMMENT ON`; SQLite →
  rowid-alias `INTEGER PRIMARY KEY` / inline `CHECK` / `--` comments.
- **Round-trip fidelity differs by dialect.** A mysql file round-trips exactly.
  Postgres is idempotent and lossy in exactly two places: it has no
  `TINYINT`/`DATETIME`, so those become `SMALLINT`/`TIMESTAMP` and the original
  name is not recovered. Both replacements are valid in every dialect, so the
  loss is cosmetic rather than breaking. Everything else — including `JSON`,
  which the emitter writes as Postgres-native `JSONB` and the parser maps back
  — round-trips unchanged, and `ENUM` is recovered from the `TEXT + CHECK`
  shape. A reopened postgres file is therefore safe to re-export to any
  dialect; `TestPostgresReopenIsPortable` pins that.

  SQLite is lossless in the default `native` mode: `BOOLEAN`, `DATETIME` and
  `TIMESTAMP` are written under their own names and read straight back, because
  SQLite accepts them and stores them verbatim (verified against sqlite3
  3.53.4). Only `ENUM` is transformed — SQLite has no enum type — into
  `TEXT + CHECK`, and the values are recovered from the constraint. `portable`
  mode is the lossy alternative described above; either way reopen → save is a
  byte-identical fixed point.

## Development

```
make test       # node --test + go test (also rebuilds dist/)
make build      # rebuild dist/ + static binary
make dist       # cross-compile all platforms into dist-bin/
cd frontend && pnpm run e2e   # UI flows against the real server (chromium)
cd frontend && pnpm test      # node --test, zero test deps
go test ./...                       # grammar/dialect/export tests
```

Edit frontend sources under `frontend/src/`; `frontend/dist/` is built into
the server at compile time (`go:embed`) — `make build` regenerates it.

`make build` produces one self-contained `erd-creator` binary: the Svelte app
is embedded via `go:embed`, so there is no asset directory to ship. The build
sets `CGO_ENABLED=0`, so the binary is statically linked and does not depend on
the host's glibc — the same setting lets one host cross-compile every target.

`make dist` cross-compiles `linux/{amd64,arm64}`, `darwin/{amd64,arm64}` and
`windows/amd64` into `dist-bin/` (gitignored), one file per platform. The
platform list lives in `Makefile`'s `PLATFORMS`; `make platforms-json` emits it
as a matrix payload, which is what CI builds from — so adding a platform needs
no workflow edit.

On every push to `main`, CI runs that same list as a build matrix and uploads
each binary as its own artifact (`erd-creator-<os>-<arch>`), downloadable from
the run summary. PRs run the full test suite but produce no artifacts.

Because `dist/` is committed, a stale local binary is easy to miss: `git
status` stays clean while `./erd-creator` serves an older embedded UI. Re-run
`make build` after pulling. The binary depends on the whole `dist/` tree, not
just `index.html`, so a changed asset does trigger a rebuild.

## Out of scope (deliberate)

Reverse-engineering live databases · Chen notation / M:N diamonds · stored box
positions (auto-layout instead) · ALTER/migration diffs · non-emitted SQL
dialects as input files · authentication (single local user; `-host` can bind
beyond loopback, but there is no auth, so that is a trusted-network choice).
