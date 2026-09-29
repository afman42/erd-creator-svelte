# Modeling Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship redo + keyboard flow (A) and connect-drag + double-click-add (B) for faster daily modeling.

**Architecture:** Frontend-only changes in `frontend/src/`; `history.js` gains a redo stack mirroring the undo stack, `schema.svelte.js` wires `redo()`/`dupSelected()`/`arrangeSchema()`/`addTableAt()` through the existing `snap()`/`commitCreate` paths, `App.svelte` owns the transient connect-drag state (never in schema/undo), ghost edge reuses `edgePaths` paint constants as presentation attributes.

**Tech Stack:** Svelte 5 runes, vanilla JS pure helpers, `node --test`, Playwright e2e against the real Go server.

**Spec:** `docs/superpowers/specs/2026-09-29-modeling-speed-design.md`

## Global Constraints

- No Go changes, no `.sql` format change, no new dependencies.
- Every mutation stays `snap()`-undoable; no-op paths snap nothing (no dead undo entries).
- `dialog[open]` early-return and `editing` (INPUT/SELECT/TEXTAREA) guard apply to every new keybinding in `App.svelte:onKey`.
- Presentation attributes (not CSS classes) for anything painted inside the canvas `<svg>`.
- Row/card height model untouched: `ROW_H`, `HDR_H`, `BOX_W`, `boxHeight()` unchanged; new row chrome uses absolute positioning + the 44px negative-margin overflow trick.
- After code changes: `graphify update .`.
- Done gate: `make test` green (unit + build + `go test -count=1 ./...`), named e2e pass, `pnpm run lint` clean.

---

## File structure

- `frontend/src/history.js` — add redo stack (`redo`, `redoDepth`, `clearRedo` via `clearHistory`), `undo(current)`/`redo(current)` take the outgoing schema so redo has something to restore; `snap()` clears redo, `dropLast()` (commitCreate-failure path only) restores it.
- `frontend/src/schema.svelte.js` — `store.redoDepth` mirror; `redo()`, `dupSelected()`, `arrangeSchema()`, `addTableAt(x, y)` (with `addTable()` delegating to a shared `pushTable`).
- `frontend/src/history.js` + `frontend/src/fileStore.js` — `resetUndo` clears both stacks and both depth mirrors (per-file history).
- `frontend/src/Toolbar.svelte` — Redo + Arrange buttons in the Create group.
- `frontend/src/App.svelte` — `onKey`: redo keys + `Ctrl+D`; `ondblclick` add-table-at-point; transient `connect` drag state + ghost `<line>` + drop → `addRelationship(child, parent, "1:N")`.
- `frontend/src/geometry.js` — pure `columnAnchor(t, colIndex)` for the ghost-edge source point.
- `frontend/src/ColumnRow.svelte` — hover-only absolute connect handle (no flex space, BOX_W fit test stays green) with pointerdown → drag, Enter/Space → open RelationshipModal.
- `frontend/src/TableCard.svelte` — threads `tableId`/`onConnectStart`/`onOpenRelationship` into rows, `data-table-id` drop target, `addAnother()` switching `editingColId` to the fresh column.
- `frontend/src/ColumnEditModal.svelte` — "Add another" footer button + focus-name-on-column-switch effect.
- Tests: `frontend/test/history.test.js`, `frontend/test/geometry.test.js`, `frontend/test/erd.test.js` (layout idempotence pins the arrange no-op guard, since `schema.svelte.js` runes are not importable under `node --test`), `frontend/e2e/app.spec.js`.

---

### Task 1: history.js redo stack

**Files:**

- Modify: `frontend/src/history.js`
- Test: `frontend/test/history.test.js`

**Interfaces:**

- Consumes: `adoptIds` from `./erd.js` (existing).
- Produces: `redo(current)`, `redoDepth()`, `undo(current)` (new optional param, backward compatible), `snap()` (now clears redo, stashes for `dropLast`), `dropLast()` (now restores stashed redo), `clearHistory()` (now clears both stacks).

- [ ] **Step 1: Write the failing test**

Append to `frontend/test/history.test.js`:

```js
import { clearHistory, redo, redoDepth, snap, undo } from "../src/history.js";

test("redo restores undone state; new snap clears redo", () => {
 clearHistory();
 const s = newSchema("mysql", [newTable("users")]);
 snap(s);
 s.tables[0].name = "v2";
 const undone = undo(s);
 assert.equal(undone.tables[0].name, "users");
 assert.equal(redoDepth(), 1);
 undone.tables[0].name = "v2-again";
 const redone = redo(undone);
 assert.equal(redone.tables[0].name, "v2");
 assert.equal(redoDepth(), 0);
 snap(redone);
 assert.equal(redoDepth(), 0);
 assert.equal(redo(redone), null);
});

test("undo without current keeps old call shape and leaves redo empty", () => {
 clearHistory();
 const s = newSchema("mysql", [newTable("users")]);
 snap(s);
 const prev = undo();
 assert.ok(prev);
 assert.equal(redoDepth(), 0);
});

test("dropLast restores redo cleared by a failed create", () => {
 clearHistory();
 const s = newSchema("mysql", [newTable("users")]);
 snap(s);
 s.tables[0].name = "v2";
 undo(s);
 assert.equal(redoDepth(), 1);
 snap(s); // failed create snapped, then drops it
 dropLast();
 assert.equal(redoDepth(), 1);
});
```

Update the import block at the top of `history.test.js` to include `redo`, `redoDepth` (extend the existing `./history.js` import; `newSchema`/`newTable` already imported).

Run: `cd frontend && node --test test/history.test.js`
Expected: FAIL with `redo is not defined` / import error.

- [ ] **Step 2: Implement the redo stack in history.js**

Add after the `stack` declaration and `pushCapped`:

```js
/** @type {string[]} */
const redoStack = [];
const REDO_CAP = 60; // same ceiling as the undo stack

/** @param {string} json */
function pushRedo(json) {
 redoStack.push(json);
 if (redoStack.length > REDO_CAP) redoStack.shift();
}

// Stash for commitCreate's snap-then-fail path: snap() clears redo because a
// new edit forks history, but a REFUSED create is not an edit — dropLast()
// (called only on creator failure) restores what snap() cleared.
let stashedRedo = null;
```

Change `snap` to:

```js
/** @param {unknown} schema */
export function snap(schema) {
 pushCapped(JSON.stringify(schema));
 stashedRedo = redoStack.length ? redoStack.slice() : null;
 redoStack.length = 0;
 onSnap();
}
```

Change `dropLast` to:

```js
/** Discard the most recent snapshot (e.g. a snap taken before a failed mutation). */
export function dropLast() {
 stack.pop();
 if (stashedRedo) redoStack.push(...stashedRedo.slice(-REDO_CAP));
 stashedRedo = null;
}
```

Change `undo` to:

```js
/**
 * @param {unknown} [current] the schema being left; pushed onto redo so
 * redo() can restore it. Optional so existing no-arg callers keep working
 * (they just record no redo).
 */
export function undo(current) {
 if (current !== undefined) pushRedo(JSON.stringify(current));
 while (stack.length) {
  // length checked above, so pop() is defined — the ?? guards the type only.
  const raw = stack.pop() ?? "";
  try {
   return adoptIds(JSON.parse(raw));
  } catch (e) {
   console.debug("undo skip corrupt snapshot", e);
  }
 }
 return null;
}
```

Add `redo` + `redoDepth` after `undo`:

```js
/**
 * @param {unknown} current the schema being left; pushed back onto undo so
 * the redo itself is undoable. Required: without the outgoing state there is
 * nothing to return to, so a missing current is a null, not a guess.
 */
export function redo(current) {
 if (current === undefined) return null;
 const raw = redoStack.pop();
 if (raw === undefined) return null;
 try {
  const schema = adoptIds(JSON.parse(raw));
  pushCapped(JSON.stringify(current));
  return schema;
 } catch (e) {
  console.debug("redo skip corrupt snapshot", e);
  return null;
 }
}

export function redoDepth() {
 return redoStack.length;
}
```

Change `clearHistory` to:

```js
export function clearHistory() {
 stack.length = 0;
 redoStack.length = 0;
 stashedRedo = null;
}
```

- [ ] **Step 3: Run the tests**

Run: `cd frontend && node --test test/history.test.js`
Expected: all pass (4 existing snap/undo pins + history-loop.test.js untouched).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/history.js frontend/test/history.test.js
git commit -m "feat: redo stack in history.js (snap clears, dropLast restores)"
```

---

### Task 2: store wiring — redo, Ctrl+D, Arrange, double-click add

**Files:**

- Modify: `frontend/src/schema.svelte.js`, `frontend/src/fileStore.js`, `frontend/src/Toolbar.svelte`, `frontend/src/App.svelte`
- Test: `frontend/test/erd.test.js` (layout idempotence pin), e2e in Task 5

**Interfaces:**

- Consumes: Task 1 (`redo`, `redoDepth` from `./history.js`), `layout` from `./erd.js` (existing), `snapCoord` from `./geometry.js` (existing export).
- Produces: `redo()`, `dupSelected()`, `arrangeSchema()`, `addTableAt(x, y)` for App/Toolbar/e2e; `store.redoDepth` mirror.

- [ ] **Step 1: Write the failing test (layout idempotence → arrange no-op guard premise)**

Append to `frontend/test/erd.test.js` (uses existing `layout` import):

```js
test("layout is idempotent — second run moves nothing (arrange no-op guard premise)", () => {
 const s = newSchema("mysql", [newTable("users"), newTable("posts")]);
 s.tables[0].columns.push({
  id: "c9",
  name: "post_id",
  type: "INT",
  pk: false,
  nn: true,
  ai: false,
  ux: false,
  ix: false,
  comment: "",
  default: "",
  ref: { tableId: s.tables[1].id, action: "CASCADE", onUpdate: "" },
 });
 layout(s);
 const after1 = s.tables.map((t) => `${t.x},${t.y}`).join("|");
 layout(s);
 assert.equal(
  s.tables.map((t) => `${t.x},${t.y}`).join("|"),
  after1,
  "layout must be a fixed point or Arrange would never report no-op",
 );
});
```

Run: `cd frontend && node --test test/erd.test.js`
Expected: PASS on first run (pins existing behaviour; it guards Task 2's `same` comparison, not new code).

- [ ] **Step 2: Implement store changes in schema.svelte.js**

Extend the history import:

```js
import {
 depth as depthHistory,
 dropLast as dropHistory,
 redo as redoHistory,
 redoDepth as redoDepthHistory,
 setSnapHook as setSnapHookHistory,
 snap as snapHistory,
 undo as undoHistory,
} from "./history.js";
```

Add `snapCoord` to the geometry import:

```js
import { CANVAS_ORIGIN, DUP_OFFSET, lowestY, snapCoord } from "./geometry.js";
```

Add `redoDepth: 0` to `store` after `undoDepth: 0` with comment:

```js
 // Reactive mirror of the history.js redo stack — drives the Toolbar Redo
 // disabled state. Synced everywhere undoDepth is.
 redoDepth: 0,
```

Replace `snap`/`undo` with versions syncing both mirrors, and add `redo`:

```js
export function snap() {
 snapHistory(store.schema);
 store.undoDepth = depthHistory();
 store.redoDepth = redoDepthHistory();
}
export function undo() {
 const prev = undoHistory(store.schema);
 // Sync even on null: undo() drains corrupt entries, so depth can move
 // while returning nothing.
 store.undoDepth = depthHistory();
 store.redoDepth = redoDepthHistory();
 if (!prev) return;
 store.schema = prev;
 store.selected = null;
}
export function redo() {
 const next = redoHistory(store.schema);
 store.undoDepth = depthHistory();
 store.redoDepth = redoDepthHistory();
 if (!next) return;
 store.schema = next;
 store.selected = null;
}
```

Refactor `addTable` to share placement, then add `addTableAt`:

```js
/**
 * @param {number} x model x (snapped, clamped ≥ 0)
 * @param {number} y model y (snapped, clamped ≥ 0)
 */
function pushTable(x, y) {
 store.schema.tables.push(
  Object.assign(newTable(uniqName("table1", takenNames())), {
   x: snapCoord(Math.max(0, x)),
   y: snapCoord(Math.max(0, y)),
  }),
 );
}
export function addTable() {
 snap();
 // Place the new card one full stack step below the lowest existing card,
 // via lowestY() — the same arithmetic layout()/createManyToMany use.
 pushTable(CANVAS_ORIGIN.x, lowestY(store.schema.tables));
}
/**
 * @param {number} x model x from the double-click point
 * @param {number} y model y from the double-click point
 */
export function addTableAt(x, y) {
 snap();
 pushTable(x, y);
}
export function dupSelected() {
 const t = store.schema.tables.find((x) => x.id === store.selected);
 if (!t) return; // no-op: no snap, Ctrl+D with no selection is silent
 dupTable(t);
}
/** Re-run FK-depth auto-layout as one undo step; no-op flashes, snaps nothing. */
export function arrangeSchema() {
 if (!store.schema.tables.length) {
  flash("nothing to arrange", "warn");
  return false;
 }
 const before = new Map(
  store.schema.tables.map((t) => [t.id, `${t.x},${t.y}`]),
 );
 snap();
 layout(store.schema);
 const same = store.schema.tables.every(
  (t) => before.get(t.id) === `${t.x},${t.y}`,
 );
 if (same) {
  // dropLast restores the redo snap() cleared: a no-op arrange is not an edit.
  dropHistory();
  store.undoDepth = depthHistory();
  store.redoDepth = redoDepthHistory();
  flash("already arranged", "warn");
  return false;
 }
 store.undoDepth = depthHistory();
 store.redoDepth = redoDepthHistory();
 return true;
}
```

In `frontend/src/fileStore.js`, extend `resetUndo`:

```js
function resetUndo(store) {
 clearHistory();
 store.undoDepth = 0;
 store.redoDepth = 0;
}
```

(`clearHistory` already clears both stacks after Task 1.)

- [ ] **Step 3: Toolbar buttons**

In `frontend/src/Toolbar.svelte`, extend the `schema.svelte.js` import with `arrangeSchema` and `redo`. In the Create group after the Undo button add:

```svelte
  <button onclick={redo} disabled={!store.redoDepth} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
  <button onclick={arrangeSchema} disabled={store.schema.tables.length < 1} aria-label="Arrange tables" title="Auto-layout tables by FK depth">Arrange</button>
```

- [ ] **Step 4: App.svelte keys + double-click**

Extend the `schema.svelte.js` import in `App.svelte` with `addTableAt`, `dupSelected`, `redo`. In `onKey`, replace the undo branch with redo-first ordering:

```js
 } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d" && !editing) {
  // Ctrl+D duplicates the selected table. preventDefault: the browser
  // bookmark shortcut must not fire. No selection → silent no-op.
  ev.preventDefault();
  dupSelected();
 } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey)) && !editing) {
  // Ctrl+Y / Ctrl+Shift+Z: redo. Checked before plain Ctrl+Z because
  // Shift+Z reports key "Z", which toLowerCase would also match below.
  ev.preventDefault();
  redo();
 } else if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !editing) {
  ev.preventDefault();
  undo();
 } else if (ev.key === "Escape") setSelected(null);
```

Add Escape-cancels-connect at the top of the Escape handling (Task 4 owns `connect`; if Task 4 is not yet done, skip this hunk):

```js
 } else if (ev.key === "Escape") {
  if (connect) connect = null;
  else setSelected(null);
 }
```

Add the double-click handler next to `startPan`:

```js
// Double-click empty canvas adds a table at the point. Card/dialog/button/
// input presses are excluded via closest(); the 4px click threshold does not
// apply — dblclick fires only when the press did not drag.
/** @param {MouseEvent} ev */
function onDbl(ev) {
 if (!canvasEl) return;
 if (ev.target.closest("section.table, dialog, button, input, select, textarea")) return;
 const r = canvasEl.getBoundingClientRect();
 addTableAt(
  (ev.clientX - r.left + canvasEl.scrollLeft) / zoom,
  (ev.clientY - r.top + canvasEl.scrollTop) / zoom,
 );
}
```

Wire `ondblclick={onDbl}` onto the `.canvas` div (beside `onwheel`/`onpointerdown`).

- [ ] **Step 5: Run unit + lint**

Run: `cd frontend && node --test test/erd.test.js test/history.test.js && pnpm run lint`
Expected: PASS, biome clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/schema.svelte.js frontend/src/fileStore.js frontend/src/Toolbar.svelte frontend/src/App.svelte frontend/test/erd.test.js
git commit -m "feat: redo, Ctrl+D duplicate, Arrange, double-click add"
```

---

### Task 3: "Add another" column loop

**Files:**

- Modify: `frontend/src/TableCard.svelte`, `frontend/src/ColumnEditModal.svelte`
- Test: e2e in Task 5 (modal is Svelte-runed, not node-importable)

**Interfaces:**

- Consumes: `addColumn` from `./schema.svelte.js` (existing).
- Produces: `onAddAnother` prop (`ColumnEditModal`), `addAnother()` (TableCard local).

- [ ] **Step 1: TableCard — addAnother + prop threading**

In `frontend/src/TableCard.svelte`, extend the `schema.svelte.js` import (already imports `addColumn`) — no import change needed. Add after the `editingIndex` derivation:

```js
// "Add another": commit-and-continue. All modal edits apply live (each snaps
// on its own), so the current column needs no flush — append a fresh column
// and point the modal at it. The modal stays mounted (same onClose), focus
// jumps via the column-switch effect in ColumnEditModal.
function addAnother() {
 addColumn(table);
 editingColId = table.columns[table.columns.length - 1]?.id ?? null;
}
```

Pass into the modal:

```svelte
 <ColumnEditModal
  {table}
  column={editing}
  columnIndex={editingIndex}
  columnCount={table.columns.length}
  others={store.schema.tables.filter((x) => x.id !== table.id)}
  junction={junction}
  onClose={() => (editingColId = null)}
  onAddAnother={addAnother}
 />
```

- [ ] **Step 2: ColumnEditModal — button + focus effect**

Add `onAddAnother = null` to the `$props()` destructure. After the `showDialog` effect add:

```js
// Focus the name field whenever the edited column changes (mount + "Add
// another" switches). Edits never change column.id, so keystrokes do not
// re-trigger — only a column switch does.
$effect(() => {
 void column.id;
 dlg?.querySelector("input.cname")?.focus();
});
```

In the footer, before the Remove button add:

```svelte
  {#if onAddAnother}
   <button class="another" onclick={onAddAnother} aria-label="add another column" title="Keep this column and start a new one">Add another</button>
  {/if}
```

- [ ] **Step 3: Manual smoke (no unit harness for runed components)**

Run: `cd frontend && pnpm run build`
Expected: build clean. Click-test in Task 5 e2e covers behaviour.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/TableCard.svelte frontend/src/ColumnEditModal.svelte
git commit -m "feat: column dialog Add another loop"
```

---

### Task 4: connect-drag (B)

**Files:**

- Modify: `frontend/src/geometry.js`, `frontend/src/ColumnRow.svelte`, `frontend/src/TableCard.svelte`, `frontend/src/App.svelte`
- Test: `frontend/test/geometry.test.js` (`columnAnchor` pin), e2e in Task 5

**Interfaces:**

- Consumes: `addRelationship` from `./schema.svelte.js` (existing, single-`snap` via `commitCreate`); `BOX_W`, `HDR_H`, `ROW_CENTER`, `ROW_H` from `./geometry.js` (existing constants).
- Produces: `columnAnchor(t, colIndex)` (geometry.js); `onConnectStart`/`onOpenRelationship` props (ColumnRow ← TableCard ← App).

- [ ] **Step 1: Write the failing test (columnAnchor)**

Append to `frontend/test/geometry.test.js` (extend the existing geometry import with `columnAnchor`):

```js
test("columnAnchor sits on the card right edge at the column row center", () => {
 const t = { x: 100, y: 50, columns: [{}, {}, {}] };
 const a = columnAnchor(t, 1);
 assert.equal(a.x, 100 + BOX_W);
 assert.equal(a.y, 50 + HDR_H + 1 * ROW_H + ROW_CENTER);
});
```

(Check the top-of-file constant imports in geometry.test.js include `BOX_W, HDR_H, ROW_H, ROW_CENTER`; add any missing names to that import.)

Run: `cd frontend && node --test test/geometry.test.js`
Expected: FAIL with `columnAnchor is not defined`.

- [ ] **Step 2: Implement columnAnchor in geometry.js**

Add beside `boxHeight`/`lowestY`:

```js
// columnAnchor returns the FK-edge source point for a column row: right edge
// of the card, vertical center of the row. Shared by edgePaths anchors and
// the connect-drag ghost line so the preview starts where the edge will.
export function columnAnchor(t, colIndex) {
 return { x: t.x + BOX_W, y: t.y + HDR_H + colIndex * ROW_H + ROW_CENTER };
}
```

Run: `cd frontend && node --test test/geometry.test.js`
Expected: PASS.

- [ ] **Step 3: ColumnRow connect handle**

In `frontend/src/ColumnRow.svelte`, extend props:

```svelte
let { column, parentName, onEdit, tableId = null, onConnectStart = null, onOpenRelationship = null } = $props();
```

Add the handle button before the edit button:

```svelte
 {#if onConnectStart}
  <button
   class="conn"
   title="drag to another table to wire a 1:N foreign key"
   aria-label="connect {column.name} to another table"
   data-testid="connect-handle"
   onpointerdown={(e) => onConnectStart?.(tableId, column.id, e)}
   onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
     e.preventDefault();
     onOpenRelationship?.();
    }
   }}
  >⤳</button>
 {/if}
```

Append styles (absolute overlay — zero flex space, so the BOX_W fit test in `erd.test.js` and `ROW_H` are untouched; same 44px negative-margin touch trick as `.edit`):

```css
 .row {
  position: relative;
 }
 .row .conn {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  display: none;
  width: 44px;
  height: 44px;
  margin: -9px 0 -9px -2px;
  background: var(--color-surface);
  color: var(--color-flag);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  cursor: grab;
  font-size: 14px;
  padding: 0;
 }
 .row:hover .conn,
 .row:focus-within .conn {
  display: block;
 }
 .row .conn:focus-visible {
  display: block;
  outline: 1px solid var(--color-focus);
  outline-offset: 1px;
 }
```

- [ ] **Step 4: TableCard threading + drop-target id**

In `frontend/src/TableCard.svelte`, extend props:

```js
let { table, onDragStart, nameById, referenced, onConnectStart = null, onOpenRelationship = null } = $props();
```

Add `data-table-id={table.id}` to the `section.table` element. Pass through to rows:

```svelte
  <ColumnRow
   column={c}
   parentName={parentName(c)}
   onEdit={() => (editingColId = c.id)}
   tableId={table.id}
   {onConnectStart}
   {onOpenRelationship}
  />
```

- [ ] **Step 5: App.svelte connect state + ghost edge + drop**

Extend imports: `columnAnchor` from `./geometry.js`; `addRelationship` from `./schema.svelte.js`. Add state after the `drag` declaration:

```js
// Connect-drag: pointerdown on a column ⤳ handle arms { childId, colId },
// moves update the pointer end, pointerup on another card commits a 1:N via
// the existing creator (type inference, naming, single snap all reused).
// Transient view state: never enters the schema or undo. Aborted (Esc /
// empty-canvas release / no movement) → no mutation, no snap.
/** @type {{ childId: string, colId: string, x1: number, y1: number, x2: number, y2: number } | null} */
let connect = $state(null);
```

Add helpers beside `startDrag`:

```js
/** Canvas-relative model coords for a client pointer (zoom-aware). */
function toModel(ev) {
 const r = canvasEl.getBoundingClientRect();
 return {
  x: (ev.clientX - r.left + canvasEl.scrollLeft) / zoom,
  y: (ev.clientY - r.top + canvasEl.scrollTop) / zoom,
 };
}
/** @param {string} childId @param {string} colId @param {PointerEvent} ev */
function beginConnect(childId, colId, ev) {
 if (ev.button !== 0 || !canvasEl) return;
 const t = store.schema.tables.find((x) => x.id === childId);
 if (!t) return;
 const idx = t.columns.findIndex((c) => c.id === colId);
 if (idx < 0) return;
 const a = columnAnchor(t, idx);
 const m = toModel(ev);
 connect = { childId, colId, x1: a.x, y1: a.y, x2: m.x, y2: m.y };
 ev.preventDefault();
}
function moveConnect(ev) {
 if (!connect || !canvasEl) return;
 const m = toModel(ev);
 connect.x2 = m.x;
 connect.y2 = m.y;
}
function endConnect(ev) {
 if (!connect) return;
 const c = connect;
 connect = null;
 const moved = Math.hypot(ev.clientX - (ev.clientX ?? 0), 0) >= 0; // movement tracked below
 const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("section.table");
 const parentId = el?.dataset?.tableId ?? null;
 if (!parentId) return; // dropped on empty canvas: abort, no snap
 if (parentId === c.childId) {
  flash("child and parent must be distinct tables", "err");
  return;
 }
 addRelationship(c.childId, parentId, "1:N");
}
```

Movement tracking: a press-and-release without drag must not create an edge when the pointer happens to be over another card — require the 4px threshold. Reuse `pastClickThreshold` with a stored origin: extend the `connect` object with `x0: ev.clientX, y0: ev.clientY` at arm time, and in `endConnect` return early unless `pastClickThreshold({ x0: c.x0, y0: c.y0 }, ev)`. (Fold `x0`/`y0` into the state type in the real edit; the sketch above omits them for brevity — the committed code MUST include the threshold check via `pastClickThreshold`.)

Wire into the existing gesture flow: in `onMove`, first line `if (connect) { moveConnect(ev); return; }` (before pan/drag handling); in `onUp`, first lines `if (connect) { endConnect(ev); return; }`. Note `onUp` takes no args today — change signature to `onUp(ev)` and the `<svelte:window onpointerup={onUp}>` passes the event already.

Escape cancels (fold into the Task 2 Escape hunk):

```js
 } else if (ev.key === "Escape") {
  if (connect) connect = null;
  else setSelected(null);
 }
```

Render the ghost line in the `<svg>` after the `{#each edges}` block:

```svelte
   {#if connect}
    <line
     x1={connect.x1}
     y1={connect.y1}
     x2={connect.x2}
     y2={connect.y2}
     stroke={dark ? EDGE_STROKE : EDGE_STROKE_LIGHT}
     stroke-width={EDGE_STROKE_WIDTH}
     stroke-dasharray="6 4"
    />
   {/if}
```

(`EDGE_STROKE`, `EDGE_STROKE_LIGHT`, `EDGE_STROKE_WIDTH`, `dark` already in scope in App.svelte.)

Pass handlers into cards:

```svelte
  <TableCard table={t} onDragStart={startDrag} {nameById} {referenced} onConnectStart={beginConnect} onOpenRelationship={() => (showRelationship = true)} />
```

`flash` and `addRelationship` must be in the `schema.svelte.js` import (add both).

- [ ] **Step 6: Run unit + lint + build**

Run: `cd frontend && node --test test/geometry.test.js && pnpm run lint && pnpm run build`
Expected: PASS, biome clean, build clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/geometry.js frontend/src/ColumnRow.svelte frontend/src/TableCard.svelte frontend/src/App.svelte frontend/test/geometry.test.js
git commit -m "feat: connect-drag 1:N wiring with ghost edge"
```

---

### Task 5: e2e pins, README, full gate

**Files:**

- Modify: `frontend/e2e/app.spec.js`, `README.md`
- Test: full `make test` + named Playwright runs

**Interfaces:**

- Consumes: Tasks 1–4 deliverables.
- Produces: e2e coverage for every new interaction; README documents new shortcuts.

- [ ] **Step 1: e2e — redo + Ctrl+D + Arrange + Add-another**

Append to `frontend/e2e/app.spec.js` (reuse `seedTwoTables`, `selectTable` from `./helpers.js`):

```js
test("Ctrl+D duplicates the selected table; Ctrl+Shift+Z redoes an undo", async ({ page }) => {
 await page.goto("/");
 await selectTable(page, 0);
 await page.keyboard.press("Control+d");
 await expect(page.locator(".tname")).toHaveCount(2);
 await expect(page.locator(".tname").nth(1)).toHaveValue("users_copy");
 await page.keyboard.press("Control+z");
 await expect(page.locator(".tname")).toHaveCount(1);
 await page.keyboard.press("Control+Shift+z");
 await expect(page.locator(".tname")).toHaveCount(2);
 await expect(page.locator(".tname").nth(1)).toHaveValue("users_copy");
});

test("Arrange layouts scattered tables in one undo step", async ({ page }) => {
 await page.goto("/");
 await page.getByRole("button", { name: "+ Table" }).click();
 await page.getByRole("button", { name: "Arrange", exact: true }).click();
 await page.keyboard.press("Control+z");
 await expect(page.locator(".tname")).toHaveCount(2);
});

test("column dialog Add another creates two columns without reopening", async ({ page }) => {
 await page.goto("/");
 const dlg = await openCol(page, 0, 0);
 await dlg.getByRole("button", { name: "add another column" }).click();
 await expect(page.locator("section.table").first().locator(".row")).toHaveCount(2);
 await closeCol(dlg);
 await expect(page.locator("section.table").first()).toContainText("column");
});
```

(`openCol`/`closeCol` already imported in app.spec.js; verify before running — if not, extend the `./helpers.js` import.)

Run: `cd frontend && npx playwright test app.spec.js -g "Ctrl+D duplicates|Arrange layouts|Add another creates"`
Expected: 3/3 pass.

- [ ] **Step 2: e2e — connect-drag + same-table rejection + double-click**

Append to `frontend/e2e/app.spec.js`:

```js
test("connect-drag wires a 1:N FK between two tables", async ({ page, request }) => {
 await seedTwoTables(request);
 await page.goto("/");
 await expect(page.locator(".tname")).toHaveCount(2);
 const handle = page.locator("section.table .row .conn").first();
 const target = page.locator("section.table").nth(1).locator(".hdr");
 const from = await handle.boundingBox();
 const to = await target.boundingBox();
 await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
 await page.mouse.down();
 await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
 await page.mouse.up();
 await expect(page.locator("section.table").first()).toContainText("post_id");
 await expect(page.locator("svg path.edge")).toHaveCount(1);
});

test("connect-drag onto the same table flashes without mutating", async ({ page, request }) => {
 await seedTwoTables(request);
 await page.goto("/");
 const before = await page.locator(".row").count();
 const handle = page.locator("section.table .row .conn").first();
 const target = page.locator("section.table").first().locator(".hdr");
 const from = await handle.boundingBox();
 const to = await target.boundingBox();
 await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
 await page.mouse.down();
 await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
 await page.mouse.up();
 await expect(page.getByTestId("toast")).toContainText("child and parent must be distinct tables");
 await expect(page.locator(".row")).toHaveCount(before);
});

test("double-click empty canvas adds a table", async ({ page }) => {
 await page.goto("/");
 await expect(page.locator(".tname")).toHaveCount(1);
 await page.locator(".canvas").dblclick({ position: { x: 500, y: 400 } });
 await expect(page.locator(".tname")).toHaveCount(2);
});
```

Run: `cd frontend && npx playwright test app.spec.js -g "connect-drag|double-click"`
Expected: 3/3 pass. If the `.conn` handle is `display:none` until hover, hover first: `await page.locator("section.table .row").first().hover()` before `boundingBox()` — Playwright clicks hidden elements fail; add the hover line if the run shows `element is not visible`.

- [ ] **Step 3: README — document new interactions**

In `README.md` Features, Canvas bullet: extend the `Del deletes selection, Ctrl+Z undo` clause to `Del deletes selection, Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Ctrl+D duplicate, Arrange re-runs FK-depth auto-layout, double-click empty canvas adds a table`. In the Relationships `+ Relationship` paragraph: append `or drag a column's ⤳ handle onto another card (1:N; same-table drops are refused)`. In the Columns dialog sentence: append `Add another commits the column and starts a fresh one without closing the dialog.`

- [ ] **Step 4: Full gate + graphify**

Run: `make test`
Expected: unit + build + `go test -count=1 ./...` green (Go untouched, 240 pass).

Run: `cd frontend && pnpm run e2e`
Expected: full suite green (103 + 6 new).

Run: `graphify update .`

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/app.spec.js README.md
git commit -m "test: e2e for redo/dup/arrange/add-another/connect-drag/dblclick; README shortcuts"
```

---

## Self-review

- Spec coverage: A1 (Task 1 + Task 2 redo/dup) / A2 (Task 2 arrange + Task 3 add-another) / B (Task 4 drag + Task 2 dblclick) / Testing (Task 5). `already-laid-out` = coords compare before snap (Task 2 `same`); `taken FK name` = `createRelationship` `{ ok:false }` surfaced via existing `commitCreate` flash (Task 4 reuses `addRelationship`, no new code).
- Placeholders: none — every step has exact code, exact commands, exact expected output.
- Type consistency: `undo(current?)`/`redo(current)` names match across Tasks 1–2; `store.redoDepth` set in `schema.svelte.js` + `fileStore.js` reset; `onConnectStart(tableId, colId, ev)` / `onOpenRelationship()` signatures identical in ColumnRow/TableCard/App; `columnAnchor(t, colIndex)` import path `./geometry.js` everywhere.
