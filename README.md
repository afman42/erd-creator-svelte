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
| --- | --- | --- |
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
| --- | --- |
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
  supported) `NN` `UQ` `AI` `IX` flags, the FK with its `ON DELETE` and
  `ON UPDATE` actions, the comment, and Remove. It is a native `<dialog>`, so
  Escape closes it and focus is trapped while it is open. (The ten controls used
  to sit inline in a 280px row, where they needed ~342px and clipped; the row's
  26px height and the comment line's 16px are unchanged, so FK edge anchors are
  unaffected.)
 - **Relationships** — per-column `FK→` select + `ON DELETE` / `ON UPDATE`
   actions; bezier edge renders automatically; type-mismatch lint (server-side)
   as a toast notice. Once an FK is set, the column dialog's **Relationship**
  block shows the derived state (`0..N / 0..1`, `0..N / 1..1`, `0..1 / 0..1`,
  `0..1 / 1..1`) with a `1:N` / `1:1` radio that flips the `UQ` flag for you —
  so you can set the relationship without knowing that `UQ` means `0..1`.
  It stores nothing new: the readout is a *view* of those flags, which is why
  it can never disagree with the emitted DDL, and why the `.sql` format is
  unchanged. The two states the radio cannot express (`0..N / 0..1`,
  `0..1 / 0..1`) stay reachable through the raw `UQ` / `NN` flag checkboxes.

  All four states stay reachable through the raw `UQ` / `NN` flag
  checkboxes on any column, including a primary key. A PK is always
  `0..1 / 1..1` — it is emitted `NOT NULL` **and** `UNIQUE` in every
  dialect regardless of the checkboxes — so flags on a PK column do not
  move the edge labels; turning the PK itself off is an explicit checkbox
  toggle. The model and the emitted DDL therefore never disagree, which is
  the property the whole design protects. A **composite**
  -PK member is a partial case: `PRIMARY KEY (a, b)` does not make `a` unique on
  its own, so its child end can be made `0..1` without touching the PK, while
  relaxing its parent end clears it. `1..N` is deliberately absent — SQL cannot
  express "every parent must have at least one child", so it would assert
  something no database enforces.

  Each edge is labelled with **min-max cardinality** at both
  ends (`0..1`, `1..1`, `0..N`), always on, with each symbol sitting **on the
  curve** near the card it describes. The labels are *derived* from flags the
  column already has, never authored: `UQ` — or a **sole** primary key — makes
  the child end `0..1`, otherwise `0..N`; `NOT NULL` makes the parent end
  `1..1`, otherwise `0..1`. Deriving means there is no stored cardinality that
  could contradict the DDL, so nothing is added to the model or the file format.

  Two subtleties are deliberate. A **composite**-PK member is *not* unique on
  its own — in a junction table `PK(a, b)` each column repeats freely, which is
  exactly why it is M:N — so `pk` alone does not mean `0..1`; treating it that
  way would label every junction table as one-to-one. And the child minimum is
  always `0`: SQL cannot express "every parent must have at least one child",
  so printing `1..N` would assert something no database can enforce.

  The toolbar's **`+ Relationship`** button offers the three canonical types as
  a single gesture instead of hand-setting flags: pick a child (referencing)
  table, a parent (referenced) table, and a type.
  **`1:1`** appends the FK column and writes `UQ` + `NOT NULL`, so the pair
  renders `0..1 / 1..1`; **`1:N`** writes `NOT NULL` only, rendering
  `0..N / 1..1`. **`N:N`** creates a junction table named `<A>_<B>` whose
  primary key *is* the two FK columns (`users_posts` with `PK (user_id,
  post_id)`, neither unique) — the shape SQL uses for many-to-many. Junction
  cards carry a small `N:N` badge, **derived** from that shape
  (`isJunctionTable`: PK of exactly two FK columns, referenced by nobody), so
  a hand-built or reopened junction gets the badge too and nothing new is
  stored or added to the `.sql` format. The junction's own edges read
  `0..N` on the junction side of each FK — the junction end is the many side.

  Edges whose two cards overlap in x (the default stacked layout, and any
  partial overlap) are **bowed** clear of the card border, and a
  self-referencing FK (`parent_id` → the same table, which is how a tree or
  adjacency list is written) loops out of and back into the card's right
  border rather than through its body. Without both, the curve degenerated to a
  vertical line lying on the border — invisible — or ran through the card, with
  its labels drawn inside the table.

  The **crow's foot sits at the child end**, and the routing is not always
  drawn child-first: it starts at the *parent's* border when the child is to the
  right. The arrowhead was placed by `marker-end`, so on those edges it landed
  on the parent and the relationship read backwards — and whenever a child sat
  left of its parent the arrow pointed the wrong way outright. Which end belongs
  to the child is now named explicitly (`arrowAtStart`), and the marker is
  applied as `marker-start` or `marker-end` accordingly; `orient="auto-start-reverse"`
  makes the start marker point away from the curve, so the geometry is unchanged.

  Two tables referencing **each other** (`users.id → posts.id` *and*
  `posts.id → users.id`) is a legal schema, and both edges used to compute
  *identical* path strings — painting one line on top of itself, so only one
  arrowhead was visible and two sets of cardinality labels stacked at each end.
  Edges that would collide are now spread into **lanes**. The offset is applied
  to the control points, so it reaches the labels *attenuated* by 0.5625 (a label
  sits at t=0.25/0.75, where the cubic's control-point contribution is
  3(1−t)²t + 3(1−t)t² = 0.5625). The lane is therefore sized as
  `LABEL_W / 0.5625`: a cardinality label measures 21.6px, so ≥38.4px is needed
  to stop the boxes touching, and the constant is 44px — a measured 3.1px of
  clear space between the two labels, which is the whole margin, since a
  four-character label is a fixed width in the monospace face. Edges that are
  already distinct — two FKs into one parent, on different rows — are left
  untouched.

  The crow's-foot arrowhead is sized and stroked to survive an export: a marker
  does not inherit the stroke-width of the path that references it, so the
  original 7×7 marker drew at 1px in the same grey as its line and was
  effectively invisible in a PNG (measured: 22 differing pixels, ~6×7). It is
  now 11×11 with an explicit 1.8px stroke.

  **The line and its labels are painted with SVG presentation attributes, not
  CSS classes.** `html-to-image` does not carry the stylesheet into an export —
  the exported document contains no `<style>` element and no `.edge` rule — so
  anything styled only by a class loses its paint and renders invisible. That
  made the PNG show an arrowhead with no line and no cardinality labels. The
  colours therefore appear twice: once as constants in `geometry.js` (applied as
  attributes) and once in `tokens.css` (for the on-screen view), with a test
  asserting the two stay equal, because a CSS custom property does not resolve
  in the exported document either.
- **Export PNG / SVG** — `Export PNG` rasterizes the canvas (tables + FK edges)
  to a `.png` via `html-to-image` (dynamic import, no extra weight on SQL path).
  The image covers the **whole diagram**, not just the visible area: the
  canvas scrolls, so its own size is the viewport, and the export measures the
  cards instead (`captureSize()` in `capture.js`). Scrolled or offscreen tables
  are included. Filename mirrors Export (`mydb.sql`→`mydb.png`). Empty schema
  shows error, no download.

  `Export SVG` is the vector twin: same sizing, same filename rule with a
  `.svg` extension (`mydb.sql`→`mydb.svg`), so a diagram pasted into docs or
  slides stays sharp when rescaled. It uses `toSvg` rather than `toPng`, and
  not only for the format: `toPng` builds a canvas from an `<img>` whose `src`
  is a data URL, which the CSP's `connect-src 'self'` blocks, while `toSvg`
  serializes the clone directly and never goes through an image. The library
  returns a *data URL*, so `decodeSvgDataUrl` unwraps it before the file is
  written — otherwise the `.svg` would begin `data:image/svg+xml…` and open in
  nothing.
- **Indexes** — a per-column `IX` flag emits a single-column index
  (`idx_<table>_<col>`). An index over **two or more** columns is a table-level
  thing, opened with `⌗` in the card header, because `IX` on three columns
  means three separate indexes, not one index over three. Composite indexes
  round-trip in every dialect: `KEY name (a, b)` inline for MySQL/MariaDB, and
  a separate `CREATE INDEX` statement for Postgres and SQLite, matching how
  each dialect already emits single-column indexes. The name is optional —
  unnamed derives `idx_<table>_<col1>_<col2>`, the same convention the
  single-column path uses — and a one-column index deliberately stays on the
  column flag, so a schema that only uses `IX` still saves the exact bytes it
  always did. Both the name and the column list are validated as identifiers,
  and the parsers route by column count, which is what lets both shapes reopen.
- **Types** — the dialog's type list covers `INT…JSON` plus `ENUM` with editable
  values, and a `DECIMAL(10,2)`-style argument list where the type takes one.
  When **PostgreSQL** is the selected dialect an `Array` checkbox appears,
  appending the `[]` suffix (`VARCHAR(255)` → `VARCHAR(255)[]`). The suffix is
  part of the stored type expression, so `JSON[]` emits as `JSONB[]` and reopens
  as `JSON[]` — the array dimension survives the dialect's own type mapping
  rather than being dropped. Arrays are PostgreSQL syntax, so the control is
  shown only for postgres and the server **refuses to emit one for any other
  dialect** rather than producing DDL MySQL or SQLite would reject; the error
  names the target dialect. `INT[][]` (multi-dimension) and `ENUM[]` are
  refused outright: no emitter here renders a multi-dimension array, and the
  ENUM rendering is a `CHECK (col IN (…))` constraint that describes one value,
  not an array of them. An array column also cannot be a `PK` or `AI`, so
  turning the toggle on clears both.
- **Files** — schema store in `-dir` (default `./schemas`): Files dropdown +
  New/Save/Del; saves debounce-autosave the current file — switching or
  deleting a file flushes the pending save first. Opening is best-effort: a
  foreign dump (`mysqldump`, `pg_dump`, SQLite) loads its tables, columns, FKs
  and indexes and flashes what it skipped (`imported with N skips: …`); a file
  with no tables still 400s and the canvas keeps prior state. **Delete moves
  the file to a `.trash/` sibling (7-day retention, swept on delete) instead
  of unlinking** — a mis-click is recoverable with `mv .trash/name.sql ./` —
  and the toolbar shows an `unsaved` badge while an edit is pending autosave.
  The server generates and parses the file's DDL in its own dialect; `Copy
  INSERTs` emits seed-row templates (MySQL syntax) and a red `unsaved` note
  appears while the file differs from disk.
- **Dialects** — one dropdown selects the DDL flavor, and it drives everything:
  what Save writes, the SQL panel, Copy SQL, Export (downloads a `.sql`
  file named after the current file, or `<dialect>-schema.sql` for unsaved
  schemas) and Export PNG (downloads the diagram as `.png`, same name with
  `.sql`→`.png`, or `<dialect>-schema.png`). All four dialects are saveable:
  each has a parser, so a saved file reopens and keeps its own dialect rather
  than silently becoming MySQL.

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
frontend/src/geometry.js     (box metrics + FK edge paths + cardinality) (pure, testable)
frontend/src/erd.js          (UI helpers + naming + dialects + layout)(pure, testable)
frontend/src/relationships.js  (pure creators createRelationship/createManyToMany + isJunctionTable)
frontend/src/capture.js      (PNG/SVG capture via html-to-image, bounds via geometry)
frontend/src/download.js     (download + clipboard helpers)         (pure)
frontend/src/history.js      (undo stack, JSON snapshots)           (pure)
frontend/src/autosave.js     (debounced lint/save/sql, dirty flag) (pure)
frontend/src/schema.svelte.js(store: model state, mutations, fetch glue)
frontend/src/Toast.svelte     (flash + lint notices, bottom-right toast)
frontend/src/TableCard.svelte(table card, column rows, dialog hosts)
frontend/src/ColumnRow.svelte(column row: badges, FK target, edit button)
frontend/src/EmptyState.svelte (empty-schema placeholder)
frontend/src/SqlPanel.svelte   (SQL preview panel)
frontend/src/RelationshipModal.svelte(1:1 / 1:N / N:N creation dialog)
frontend/src/ColumnEditModal.svelte(per-column controls dialog)
frontend/src/TableIndexModal.svelte(composite-index dialog)
frontend/src/App.svelte      (canvas rendering, drag/keys, SQL panel toggle)
grammar.go              model + mysql/mariadb parse/lint + inserts
import.go               best-effort import: strict ParseDDL first, then one lenient pass + warnings
grammar_postgres.go     postgres parse (reads buildPostgres output)
validate.go             trust boundary: schema + output validation (+ type helpers)
security.go             HTTP hardening: headers, Host/Origin guards, timeouts
files.go                working-dir .sql store (GET/PUT/DELETE) (+ path helpers)
export.go               dialect emitters: mysql|mariadb|postgres|sqlite (+ col helpers, registry)
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
- **Parse boundary**: `ParseDDL` only reads DDL this tool itself emits; `ParseImport`
  (open path) falls back to one lenient pass for foreign dumps — tables, columns,
  inline/bare/ALTER FKs, unique/index routing, `SERIAL`/identity/AUTOINCREMENT cues
  — and reports the rest as open-response warnings. Zero tables → 400 error
  banner, canvas kept.
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

For UI work with hot reload: run the Go server (`go run . -dir schemas`),
then `cd frontend && pnpm dev` — `vite.config.js` proxies `/api` and
`/export` to `127.0.0.1:8731`, so the dev server's relative fetch paths
hit the real backend.

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
