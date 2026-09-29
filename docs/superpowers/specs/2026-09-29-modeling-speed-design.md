# Modeling Speed — Design (redo/keys + connect-drag)

Date: 2026-09-29
Status: draft, pending user review
Path: architectural (announced, accepted; scope A+B per user pick)

## Goal

Cut the highest-frequency friction in daily modeling: keyboard flow
gaps (no redo, no duplicate key, per-column dialog churn) and the
hand-setting of FK flags to wire a relationship. Baseline at design
time: unit 185 · e2e 103 · Go 240 · lint/vet clean.

## Approach (approved)

A — keyboard flow + redo (frontend-only). B — connect-drag +
double-click-add (frontend-only, `RelationshipModal` kept as fallback).
Rejected: C multi-select/marquee (single-id `selected` is load-bearing
in `TableCard`, `canvasView`, lint jump — invasive for a case most
schemas don't hit).

Standing constraints: no Go changes, no `.sql` format change, no new
dependencies, every mutation stays `snap()`-undoable, `graphify update .`
after code changes.

## A1 — redo + Ctrl+D duplicate

`history.js` gains a redo stack mirroring `stack`: `snap()` clears it,
`redo()` pops back with the same corrupt-skip loop as `undo()`, cap 60
(shared constant). `schema.svelte.js` exports `redo()` (same shape as
`undo()`, `adoptIds` re-entry). `App.svelte:onKey` adds
`Ctrl+Shift+Z`/`Ctrl+Y` → redo and `Ctrl+D` → `dupTable(selected)` +
`preventDefault` (browser bookmark hijack), all behind the existing
`dialog[open]` early-return and `editing` (INPUT/SELECT/TEXTAREA) guard.
No-op when redo stack empty / nothing selected (no snap, no flash).

Files: `frontend/src/history.js`, `frontend/src/schema.svelte.js`,
`frontend/src/App.svelte`, `frontend/test/history.test.js` (or nearest
home), `frontend/e2e/app.spec.js`.

Verification: unit redo round-trip (undo→redo restores, new snap clears
redo); e2e `Ctrl+D` duplicates selected, `Ctrl+Shift+Z` redoes undone
edit. `make test` green.

## A2 — "Add another" column loop + layout button

`ColumnEditModal` gains an "Add another" submit alongside Save: commits
the current column through the existing thunk, then resets the form
(default type, flags cleared) and keeps the dialog open with focus on
the name input; Esc/X/overlay closes as today. No model change (dialog
is view state, `editingColId` stays local to the card).

Toolbar gains an auto-layout button calling
`commitCreate(() => layout(store.schema))` reusing `erd.js:layout()`
(the file-open fn: FK-depth layers + barycenter pass). One undo step;
guard: empty schema or already-laid-out result → no snap, `flash`
("nothing to arrange"). Manual layout never writes coords to the file
— same as file-open layout, positions stay session state.

Files: `frontend/src/ColumnEditModal.svelte`,
`frontend/src/TableCard.svelte` (host wiring only),
`frontend/src/Toolbar.svelte`, `frontend/src/schema.svelte.js`
(layout export), `frontend/e2e/app.spec.js`.

Verification: e2e add-another creates two columns without reopening;
layout button reorders a scattered schema into FK-depth layers and
undoes in one step. `make test` green.

## B — connect-drag + double-click-add

Double-click on empty canvas calls `addTable()` at the click point
(existing `takenNames`/`lowestY` placement; click-vs-pan reuses the 4px
threshold in `App.svelte`). Single click/double-click on cards unchanged.

Column rows gain a drag handle (`+`, pointer-events, keyboard-focusable
with Enter-to-arm as the keyboard equivalent). Dragging shows a ghost
edge following the pointer (preview only, reusing `edgePaths` geometry,
no schema write). Dropping on another card header calls
`addRelationship(childId, parentId, "1:N")` — existing flag/type
inference, single `snap()` via `commitCreate`. Same-table drop or taken
FK name → `flash(err)`, no mutation. The `+ Relationship` modal stays
as the touch/keyboard fallback; nothing in `relationships.js` changes.

Edge cases: drag aborted (Esc / release on empty canvas) → no mutation,
no snap; drag during open dialog impossible (dialog owns pointer);
ghost edge hidden while zooming (existing `onWheel` path untouched).

Files: `frontend/src/ColumnRow.svelte` (handle),
`frontend/src/TableCard.svelte` (drop target), `frontend/src/App.svelte`
(ghost edge + dblclick), `frontend/src/relationships.js` (unchanged —
callers only), `frontend/e2e/app.spec.js`.

Verification: e2e drag-connect creates 1:N with `0..N`/`1..1` labels;
same-table drop flashes without mutation; dblclick adds `tableN` at
point. `make test` green.

## Testing (all sections)

Unit (`node --test`, existing homes): redo round-trip + clear-on-snap,
layout commit no-op guard. E2E (existing `app.spec.js`): Ctrl+D dup,
Ctrl+Shift+Z redo, add-another loop, layout+undo, dblclick add,
drag-connect + rejection. Go suite untouched (no Go changes) but `make
test` full gate stays the done criterion.

## Out of scope

Multi-select/marquee (rejected C), command palette, bulk wizards,
live-DB import, auth/TLS/rate limiting (TASKS.md deferred), stored box
positions (README deliberate), new dialects.

## Self-review

- Placeholders: none; all behaviours, guards, files concrete.
- Consistency: A1/A2/B all frontend-only, all mutations via
  `snap()`/`commitCreate`, no format/Go/dep changes — matches standing
  constraints.
- Scope: single implementation plan (3 frontend slices, one e2e file).
- Ambiguity: "already-laid-out" means `layout()` output equals current
  coords (compare before snap); "taken FK name" means `createRelationship`
  returns `{ ok: false }` (surfaced via flash, same as modal path).
