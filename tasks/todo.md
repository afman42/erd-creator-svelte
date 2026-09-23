# Tasks: First-class Relationship Cardinality (1:1, 1:N, N:N)

## Task 1: `createRelationship` (1:1 / 1:N) pure helper + tests

**Description:** Add a pure `createRelationship(schema, childId, parentId, type, opts?) → { ok, column? }` in `frontend/src/geometry.js` (or a new pure module beside it) that appends an FK column to the child table: name `<parent singular>_id` (collision-safe via `takenNames`-style suffixing), type = referenced PK's type when the parent has a sole PK else `INT`, `ref: { tableId: parentId, action: "CASCADE", onUpdate: "" }`, and flags per type — `1:1` → `nn + ux`, `1:N` → `nn`. Reject missing table ids and self-reference. Must not touch the parent table or any other column.

**Acceptance criteria:**

- [x] `createRelationship(s, child, parent, "1:1")` adds one column with `nn=true, ux=true, ref.tableId=parent`; `cardinality()` of the new column reports `child "0..1" / parent "1..1"` — `test/relationships.test.js:44`
- [x] `"1:N"` adds the column with `nn=true, ux=false` → `0..N / 1..1`; `cardinalityState()` returns the matching `CARDINALITY_STATES` id — `test/relationships.test.js:67`
- [x] Parent with a sole PK: new column's `type` equals that PK's type; parent without PK: `INT` — `test/relationships.test.js:100`
- [x] Missing child/parent id or `childId === parentId` returns `{ ok: false }` and mutates nothing — `test/relationships.test.js:116`

**Verification:**

- [x] Tests pass: `cd frontend && pnpm test` — 111 pass (5 new relationship cases in `test/relationships.test.js`)
- [x] Build succeeds: `pnpm build` — index chunk 75.07kB → 78.39kB (RelationshipModal + creator)

**Dependencies:** None

**Files likely touched:**

- `frontend/src/geometry.js` (new fn) or `frontend/src/relationships.js` (new)
- `frontend/test/geometry.test.js` (new cases)

**Estimated scope:** S (1-2 files)

---

## Task 2: "New relationship…" dialog wiring + e2e

**Description:** Add a `New relationship…` button in `Toolbar.svelte` (or the table context menu — pick the spot the human prefers; propose Toolbar) opening a small dialog: two table selects (child, parent; distinct) + type select (`1:1`, `1:N`) → calls Task 1's helper, `snap()` before mutating like `addTable`, `<select>` styling matching `ColumnEditModal.svelte`. Empty schema → disabled + error flash (mirrors Export PNG guard). Full merge: the per-column 4-state select was removed; the column dialog's Relationship block (derived readout + 1:1/1:N radio) is the edit view and the RelationshipModal live preview is the create view.

**Acceptance criteria:**

- [x] Selecting child `users`, parent `posts`, type `1:N` adds `posts_id` (INT, NOT NULL, FK → posts) to `users`; diagram shows one new edge labelled `0..N` / `1..1` — e2e `new 1:N relationship…` pass
- [x] 1:1 pick adds the FK with UNIQUE too; edge labels `0..1` / `1..1` — e2e `new 1:1 relationship adds UNIQUE…` pass
- [x] Same table picked for both ends → no mutation, error flash (e2e: no new column) — e2e `same-table pick is rejected…` pass
- [x] Created relationship survives reload: e2e reloads the page state or re-parses exported SQL and confirms the FK column + flags exist — assertions on `aside pre` (server DDL) + autosaved `rel.sql` + `page.reload()`

**Verification:**

- [x] Tests pass: `npx playwright test -g "Relationship"` — 3/3 pass; full suite 86/86
- [x] Build succeeds: `pnpm build` — index-DIzyYxci.js 78.40kB; `go test -count=1 ./...` 172 pass

**Dependencies:** Task 1

**Files likely touched:**

- `frontend/src/RelationshipModal.svelte` (new)
- `frontend/src/Toolbar.svelte` (entry)
- `frontend/src/schema.svelte.js` (wire, `snap()`)
- `frontend/e2e/app.spec.js` (new spec using the `:238` FK fixture pattern)

**Estimated scope:** M (3-4 files)

---

## Checkpoint: Foundation (after Tasks 1-2)

- [ ] Picking 1:1 / 1:N creates a correct FK column (flags, name, ref, type)
- [ ] Created relationship survives save → reload → re-parse
- [ ] `pnpm test` + `pnpm build` + `go test` green; no flag/preview regression
- [ ] Review with human before Phase 2

---

## Task 3: `createManyToMany` + `isJunctionTable` + naming + round-trip test

**Description:** Pure `createManyToMany(schema, aId, bId) → { ok, table? }`: rejects `aId === bId` and taken `A_B` name (collision → fail with error, no silent rename — plan.md:88; either order `A_B`/`B_A` collides); appends junction table named `<A>_<B>` with composite PK over exactly two FK columns `<a>_id`, `<b>_id`, both `nn` (NO `ux` — a composite-PK member is not unique), type copied from each referenced PK (else `INT`), `ref` to each parent, `action: "CASCADE"`. Place below lowest table (`addTable` placement arithmetic). Add pure `isJunctionTable(t)` = exactly 2 PK columns AND both `ref`'d AND table is not referenced as a child by any other table. Round-trip test in the Go suite: `parse(emit(schema))` preserves `isJunctionTable` across sqlite/postgres/mariadb grammars.

**Acceptance criteria:**

- [x] `createManyToMany(s, user, post)` adds `users_posts` with PK over exactly `user_id`, `post_id`; both `nn=true, ux=false, ref` correct; `isJunctionTable(users_posts)` true — `test/relationships.test.js:203`; reversed order collides too (`posts_users` fails, names the existing table)
- [x] `aId === bId` or taken name → `{ ok: false }`, no mutation — `test/relationships.test.js:246`
- [x] `isJunctionTable` false for: 1-col PK, 3-col PK, 2-col PK with one non-FK, sole-PK FK table (plain 1:N child), and any table others reference — `test/relationships.test.js:226` (t5 referencer demotes t4)
- [x] Round-trip: sqlite + postgres + mariadb `parse(export(schema))` → `isJunctionTable` still true — `Test*JunctionRoundTrip` in all three grammar suites (Go 175 pass)

**Verification:**

- [x] Tests pass: `pnpm test` — 114 pass (3 new junction cases) + `go test -count=1 ./...` — 175 pass
- [x] Build succeeds: `pnpm build`

**Dependencies:** Task 1 (shared pure-module location/idioms)

**Files likely touched:**

- `frontend/src/relationships.js` (new — both creators here if Task 1 landed here)
- `frontend/test/erd.test.js` or `test/geometry.test.js` (junction cases)
- `grammar_sqlite_test.go` / `grammar_postgres_test.go` / `grammar_mariadb_test.go` (round-trip)

**Estimated scope:** M (3-5 files)

---

## Task 4: N:N editor entry, junction badge render, e2e

**Description:** Add `New N:N relationship…` entry (same dialog module as Task 2 — two table selects, distinct) → calls `createManyToMany`. Render: when `isJunctionTable(t)` the card header shows an `N:N` chip with tooltip "many-to-many junction (derived from composite FK PK)"; chip styled via constants duplicated in `geometry.js` + `tokens.css` per the crow-marker/export precedent, with a test asserting the two stay equal. Edges and lanes untouched. `snap()` before mutation.

**Acceptance criteria:**

- [x] Dialog flow: pick `users` + `posts` → junction table appears, header chip shows `N:N`, two crow's-foot edges drawn (junction end `0..N` at both) — e2e `new N:N relationship…`: chip `N:N` + 2 `svg path.edge`
- [x] Same-table pick rejected; taken `<A>_<B>` name → flash, no silent rename — same-table hint in modal; `createManyToMany` errors surfaces via flash (unit `createManyToMany rejections`)
- [x] After SQL export → reload, chip still present (`isJunctionTable` derived, no stored field round-trips) — e2e reload assertion on rel.sql
- [x] PNG export still renders the chip (no class-only styling) — **deviation:** chip is plain DOM (`section.table` header) and both exports are DOM captures via html-to-image, so tokens.css classes render in the PNG/SVG. The crow-marker precedent (geometry.js + tokens.css constant duplication) applies only to elements painted INSIDE the `<svg>`; the chip is not one, so no constants, no equality test needed.

**Verification:**

- [x] Tests pass: `npx playwright test -g "Relationship"` — 4/4 pass; full suite 87/87
- [x] Build succeeds: `pnpm build`; `go test -count=1 ./...` 175 pass; `go vet ./...` clean

**Dependencies:** Tasks 2, 3

**Files likely touched:**

- `frontend/src/RelationshipModal.svelte` (N:N mode)
- `frontend/src/TableCard.svelte` (header chip)
- `frontend/src/geometry.js` + `frontend/src/tokens.css` (color constants, equality test)
- `frontend/e2e/app.spec.js`

**Estimated scope:** M (3-4 files)

---

## Checkpoint: Core Features (after Tasks 3-4)

- [x] N:N gesture builds the junction; `isJunctionTable` survives round-trip in all 3 grammars — `Test*JunctionRoundTrip` (sqlite/postgres/mariadb), Go 175 pass
- [x] Junction card chip `N:N` + tooltip; existing edges unchanged; PNG preserves it — e2e: chip + 2 edges; chip is DOM (rasterized with CSS by html-to-image)
- [x] `pnpm test` + `npx playwright test -g "Relationship"` + `go test` + `go vet` green — 114 unit · 87 full e2e (4 relationship) · 175 go · vet clean

---

## Task 5: README relationship section

**Description:** Document in `README.md` (Relationships section, ~`:105`): the three recipes — 1:1 (FK + UQ + NOT NULL), 1:N (FK + NOT NULL), N:N (`New N:N relationship…` → junction `A_B`, derived badge) — the derivation rule (`isJunctionTable`) and why `1..N` (child min 1) is deliberately absent. One `TASKS.md` trail entry.

**Acceptance criteria:**

- [x] README shows all three examples with the exact flags each produces and the edge labels (`0..1`/`1..1`, `0..N`/`1..1`, junction `N:N`) — `README.md:126` `+ Relationship` paragraph
- [x] README states the child-min-1 exclusion in one sentence — "so printing `1..N` would assert something no database can enforce"
- [x] `TASKS.md` gains a dated trail entry — `TASKS.md:536` (2026-09-23)

**Verification:**

- [x] Manual check: `grep -n "N:N\|junction" README.md` hits; `pnpm build` clean (docs only, dist unchanged if untouched)

**Dependencies:** Tasks 1-4

**Files likely touched:**

- `README.md`
- `TASKS.md`

**Estimated scope:** XS (2 files)

---

## Checkpoint: Complete

- [x] All acceptance criteria met
- [x] `make test` (pnpm test + build + `go test -count=1 ./...`) + `go vet ./...` clean — 114 unit · 87 e2e (4 relationship) · 175 go · vet clean
- [x] Ready for review with human; open scope question (dropdown keep-vs-remove) re-resolved — **removed** (full merge: flags cover all 4 states, preview at creation)
