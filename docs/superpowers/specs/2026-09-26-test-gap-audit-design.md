# Test-Gap Audit — Design (Slice 0 + Slices 1–6)

Date: 2026-09-26
Status: draft, pending user review
Path: architectural (announced, accepted)

## Goal

Recheck every documented behaviour of erd-creator-svelte and add or update
unit and e2e tests where gaps exist. Baseline at design time: 214 Go tests,
150 frontend `node --test` tests, 98 Playwright tests. `make test` is
`pnpm test + build + go test -count=1 ./...`; `make lint` is
`gofmt + go vet + biome`.

## Approach (approved)

A — behaviour-matrix audit first, then fill gaps in risk order. Coverage
numbers (`go cover`, per-file checklists) confirm each slice only; they do
not drive it, because executed-but-unasserted paths (barycenter ordering,
44px lanes, trash sweep) read as "covered".

Rejected: B coverage-guided (blind to semantic gaps), C risk-only without
matrix (leaves "all behaviours rechecked" unclaimable).

## Slice 0 — matrix audit (this spec's implementation)

Build `behaviour × layer` matrix. Rows come from README Features, not code;
unlisted behaviour found in code is drift and gets a row marked `undocumented`.

Rows (15):

1. Canvas CRUD/drag/undo/layout (add/rename/delete/duplicate, drag by
   header, Del, Ctrl+Z per-file, FK-depth auto-layout + barycenter pass,
   table1/table2/copy naming)
2. Column dialog (native dialog, name/type/flags/FK/DEFAULT/comment,
   reorder = DDL order, Remove, last-column block)
3. Relationships + cardinality (FK selects, ON DELETE/UPDATE, derived
   min-max labels, 1:1/1:N/N:N creators, junction badge derived via
   `isJunctionTable`, composite-PK subtlety, no 1..N, bowing, self-loops,
   reciprocal lanes, crow's-foot `arrowAtStart`)
4. PNG/SVG export (whole-diagram capture, filename rule, empty-schema
   error, `decodeSvgDataUrl`, presentation-attribute paint)
5. Indexes (per-column IX naming, composite dialog, per-dialect emission,
   arity routing)
6. Types/arrays (type list, ENUM values, DECIMAL args, postgres-only `[]`,
   multi-dim/ENUM[] refusal, array clears PK/AI, dialect enforcement)
7. Files/store (list/new/save/del/rename/duplicate, debounced autosave,
   switch/delete flush, best-effort foreign open + skip warnings,
   no-tables 400 keeps canvas, unsaved badge)
8. Trash (delete→`.trash/`, 7-day sweep on delete, ms-suffix collisions,
   symlink containment, missing-file 404)
9. Comments + defaults (table comments per dialect incl. SQLite drop,
   DEFAULT allowlist incl. quoted semicolons, AI+DEFAULT refusal)
10. Lint panel (type mismatch, no-PK parent, FK-less/missing, debounced,
    click-to-jump, no toasts, clean state)
11. Themes (dark default, toggle + persist + pre-mount, tokens, 8-way
    paint-constant equality test)
12. Dialects (dropdown drives save/SQL/Copy/Export/PNG, all four saveable,
    mariadb header-only + `TestMariaDBMatchesMysql` pin, sqlite
    native/portable + header record)
13. Import (strict own-DDL first, one lenient pass for mysqldump/pg_dump/
    SQLite, warnings, loss cap)
14. Security + validation (Validate on read/emit paths, GenSQL errors not
    emits, Host allowlist, Origin check, symlink containment, CSP +
    security headers, 10s timeouts, 1 MiB cap, terse errors)
15. Keyboard/selection (arrows/Shift, Esc, Backspace/Del guards, dialog
    focus trap)

Columns per row: Go unit | frontend `node --test` | Playwright e2e.
Cell values: `covered (pinning test)` | `stale (test + why)` |
`missing (bug it would catch)` | `n/a (why this layer owns nothing here)`.

Slice 0 output is the filled matrix plus the enumerated gap list grouped
into slices 1–6 below. Read-only: no test code, no source edits.

## Slices 1–6 (each: own spec → plan → implementation)

- Slice 1 — security & validation (Guards, headers, Validate, injection
  refusals; Go + api-validation.spec.js).
- Slice 2 — dialects & import (4 emitters/parsers, round-trip fidelity
  incl. documented-lossy spots, foreign-dump import + warnings).
- Slice 3 — file store (CRUD, trash/sweep, rename/duplicate, autosave /
  dirty / stale-save guard).
- Slice 4 — relationships & geometry (creators, cardinality derivation,
  lanes/arrows/bowing, layout incl. barycenter).
- Slice 5 — export & themes (PNG/SVG capture incl. whole-diagram and
  painted-edge proof, paint constants, light/dark).
- Slice 6 — remaining canvas UI (table/column dialogs, drag/keys, lint
  panel, comments/defaults, indexes).

Order is risk-first: escaping/saves before labels/polish. Slice 0 first,
then 1→6 in order unless the matrix shows a slice with zero gaps (then
it closes with the matrix as evidence, no spec).

## Standing rules (all slices)

1. No new harness: `go test`, `node --test`, existing Playwright spec
   files only. No new spec file unless an area has no home (then say so
   in the slice spec).
2. Proof-bearing tests only: each new test names the regression it pins
   (real past bug or plausible consumer-visible one). No wiring
   tautologies, no length-grew asserts, no bare not-throw.
3. Stale or incidental-pinning tests are rewritten or deleted, never
   re-pinned.
4. Source of truth for "behaviour" is README Features; code-only
   behaviour is either documented or removed.
5. `graphify update .` after code changes.

## Per-slice spec template

Behaviour list → per-cell claim (covered/stale/missing + pinning test) →
new tests enumerated with the bug each catches → files touched →
verification (`make test` + named `npx playwright test` slice + `go vet`
where Go changes). Done = every named gap closed or explicitly deferred
with trigger, TASKS.md trail entry where the repo convention calls for it.

## Verification for slice 0

Matrix file committed; every cell has a pinning test name or an explicit
gap id; gap ids reference slices 1–6; `make test` untouched and still
green (no code changes). No coverage threshold gates slice 0.

## Out of scope

New features, refactors beyond targeted test-driven fixes, auth/TLS/rate
limiting (TASKS.md deferred), dependency audit in CI (TASKS.md deferred),
CSS-custom-property migration (TASKS.md deferred).

## Self-review

- Placeholders: none; all rows, rules, verification concrete.
- Consistency: rows § match README Features list; slice grouping covers
  all 15 rows (1+2+6+10→slices 4/6, 3→4, 4+11→5, 5+6+9→2/6, 7+8→3,
  12+13→2, 14→1, 15→6).
- Scope: single implementation plan (fill one matrix, read-only).
- Ambiguity: "recheck" means matrix claim per cell with evidence, fixed
  above; "gap" means missing or stale cell, fixed above.
