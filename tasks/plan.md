# Implementation Plan: First-class Relationship Cardinality (1:1, 1:N, N:N)

## Overview

Make the three canonical relationship types first-class in the editor. Today the
tool already renders min-max cardinality (`0..1`, `1..1`, `0..N`) on FK edges,
derived from column flags (`UQ`/sole-PK/`NOT NULL`) — no stored cardinality. The
three canonical types are all expressible, but only by hand:

- **1:1** = FK column with `UQ` + `NOT NULL` → child `0..1` / parent `1..1`
- **1:N** = FK column with `NOT NULL` → child `0..N` / parent `1..1`
- **N:N** = junction table, composite `PRIMARY KEY (a_id, b_id)`, two FKs, neither unique

This plan adds creation gestures that build those shapes from a type picker, and
a **derived** N:N first-class rendering (badge + docs). Nothing new is stored.

## Architecture Decisions

- **N:N is derived, never stored.** A table is a junction iff its PK is exactly
  two columns and both are FKs (`isJunctionTable(t)`). This survives `.sql`
  round-trip — both `PRIMARY KEY (a, b)` and `FOREIGN KEY … REFERENCES` parse
  back in every grammar — so the diagram stays faithful after save/load with no
  format change and no second source of truth that could contradict the DDL.
  This is the same invariant the existing derived cardinality protects; a
  stored `relationships: []` array would need a `.sql` format extension and is
  rejected.
- **The creators are pure functions that write the flags `cardinality()`
  already reads.** `createRelationship` maps 1:1 → `nn + ux`, 1:N → `nn`
  on the new FK column — the flag vocabulary stays single-sourced in
  `geometry.js`. `createManyToMany` builds the junction shape directly. Every
  flag it writes is one `cardinality()` already reads.
- **REMOVED (full merge): the per-column cardinality dropdown is gone.** The
  4-state dropdown used to express states the type picker cannot — `0..N / 0..1`
  (optional FK) and `0..1 / 0..1` — as the fine-grained edit view. Both states
  stay reachable via raw UQ/NN flags (pinned by unit test), the RelationshipModal
  live preview (`previewLabels`) owns the creation vocabulary, and the writer
  pair (`setCardinality`/`applyCardinality`, `pkConflictsWith`/`reachableStates`)
  was deleted. The old "keep vs remove" scope call below is reversed with reason.
- **N:N renders as a derived badge, not a merged curve.** The two junction FKs
  already draw correct crow's-foot edges (junction's ends are the many side).
  Collapsing A→junction→B into one curve would fight the lane/edge routing.
  The badge + card tint + docs is honest, cheap, and survives export (it is DOM
  like every other card element).
- **`1..N` stays out.** SQL cannot enforce "every parent has at least one
  child"; the honest rendering of "1:N" remains child `0..N` / parent `1..1`.
  Docs say so; no stored state pretends otherwise.

## Task List

### Phase 1: Foundation — relationship creators (pure)

- [x] Task 1: `createRelationship` (1:1 / 1:N) pure helper + tests
- [x] Task 2: "New relationship…" dialog wiring + e2e

### Checkpoint: Foundation

- [x] Picking type 1:1 / 1:N creates a correct FK column (right flags, name, ref)
- [x] Round-trip: created relationship survives save → reload → re-parse
- [x] No regression: `node --test`, `pnpm build`, `go test`

### Phase 2: Core — first-class N:N

- [x] Task 3: `createManyToMany` + `isJunctionTable` + juncton-table naming + round-trip test
- [x] Task 4: N:N editor entry, junction badge render, e2e

### Checkpoint: Core Features

- [x] N:N gesture builds junction table; `isJunctionTable` true after round-trip
- [x] Junction card shows `N:N` badge / tooltip; FK edges unchanged
- [x] Unit + e2e green; `go vet` clean

### Phase 3: Polish — docs

- [x] Task 5: README relationship section (1:1 / 1:N / N:N recipes, 1..N note)

### Checkpoint: Complete

- [x] All acceptance criteria met
- [x] `make test` + `go vet` clean
- [x] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
| ------ | -------- | ------------ |
| Derived junction detector misfires (e.g. an unrelated 2-col composite-PK FK pair) | Med | `isJunctionTable` requires *exactly* 2 PK columns, both with `ref`, and table not referenced-as-child elsewhere — rule enforced by unit tests on the 4-state fixture set |
| Round-trip drift: junction flag lost on save/load | High | Property-style test: `parse(emit(schema))` keeps `isJunctionTable` true across all three grammars; add to `grammar_*_test.go` |
| N:N gesture on self-reference (A→A) | Low | Reject in the dialog: "pick two distinct tables" |
| Duplicate junction name (`users_posts` taken) | Low | Reuse `takenNames()` → flash error, no silent rename |
| Badge breaks PNG export if styled only by class | Med | Follow the existing rule: colors duplicated as constants in `geometry.js` + `tokens.css` (the crow-marker fix precedent), test asserts equality. **REVISED at build time:** the chip is a plain DOM element in `section.table`, and both exports (PNG and SVG) are DOM captures via html-to-image — CSS classes render. The crow-marker precedent applies only to paint INSIDE the `<svg>` (its fill/marker are attribute-inked from `geometry.js`); the chip is not in the SVG, so no constant duplication is needed. Track as a deviation, not an unresolved risk — if an export path ever stops applying stylesheets, this resurfability is the same tradeoff every card carries. |

## Open Questions

- **Scope call (RESOLVED: keep, REVISED: removed in full merge):** the picked option said the relationship editor
  *supersedes* the low-level state dropdown. Plan recommended keeping the
  dropdown (it owns `0..N / 0..1` and `0..1 / 0..1`, which 1:1/1:N/N:N cannot
  express). Human confirmed **keep it** — the relationship dialog is the
  creation gesture, the dropdown stays as the fine-grained edit view.
  **REVISED (full merge, human-approved):** dropdown removed; both orphan states
  stay reachable via raw UQ/NN flags, preview (`previewLabels`) owns creation,
  writers (`setCardinality`/`applyCardinality`, `pkConflictsWith`/`reachableStates`) deleted.
- N:N junction FK column type: copy referenced PK's type when available, else
  `INT`? Plan: yes, copy.
- Where the N:N badge lives: card header chip (`M:N` text + tooltip) vs edge
  label. Plan: header chip.

## Parallelization Opportunities

- Tasks 1 and 3 share the pure-function shape and are independent — parallel
  agents possible (contract: both write only `geometry.js`/`erd.js`-style pure
  fns; UI wiring is Tasks 2/4 and stays sequential).
- Task 5 (docs) is parallel with Tasks 3-4 once 1-2 land.

## References

- Flags & states: `frontend/src/geometry.js` `cardinality`, `CARDINALITY_STATES`, `cardinalityState`; `frontend/src/relationships.js` `previewLabels`, `createRelationship`, `createManyToMany`
- FK creation today: `frontend/src/schema.svelte.js` `addColumn`, `setRef`, `addRelationship`, `addManyToMany`
- Model: `frontend/src/erd.js:68 Table`, `:78 Column`, `:91 Ref`, `:130 newColumn`
- Round-trip proof: `grammar_sqlite.go:42` FK/`PRIMARY KEY` regexes; `TASKS.md` cardinality trail
- Tests: `frontend/test/erd.test.js:778 crowMarker`, `frontend/e2e/app.spec.js:238` FK fixture pattern
- Verification: `make test` (pnpm test + build + `go test -count=1 ./...`), `go vet ./...`, `npx playwright test -g "Relationship"`
