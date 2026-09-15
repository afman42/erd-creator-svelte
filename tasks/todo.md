# Task List: ERD Creator (svelterm MVP)

Plan: `tasks/plan.md`. Package manager: pnpm. Dialect: MySQL. Positioning: arrow-key drag.

## Phase 0: Foundation

- [x] T1: Toolchain spike — build svelte fork + scaffold app (S)
  - `git clone -b svelte-custom-renderer https://github.com/tomyan/svelte.git ../svelte-fork && pnpm install && pnpm -C packages/svelte build`
  - `pnpm dlx @svelterm/core init erd-creator && pnpm install`
  - Acceptance: `pnpm run app` renders the counter demo in terminal; `pnpm run build` emits `dist/app.mjs`.
  - Depends: none. **Fail-fast gate: stop everything if this breaks.**

- [x] T2: Model store + immutable mutations (M)
  - `src/lib/model.js`: Entity, Field, Relationship shapes; `$state` store; `addEntity/updateEntity/moveEntity/removeEntity/addField/removeField/addRelationship/removeRelationship` — each returns new model snapshot.
  - Name regex `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, MySQL type whitelist (`INT BIGINT TINYINT DECIMAL(10,2) CHAR(n) VARCHAR(n) TEXT BLOB DATE DATETIME TIMESTAMP JSON ENUM(...)`).
  - Acceptance: unit script `node src/lib/model.test.mjs` — mutations immutable, invalid names rejected.
  - Depends: T1.

## Checkpoint: after T1–T2

- [x] App boots; model layer green standalone.

## Phase 1: Core vertical slice — "draw one table"

- [x] T3: Entity + field editor panels (M)
  - Sidebar: entity list (`<details>` per entity), add-entity form (name input), field rows (name/type/`[x]PK`/`[x]NULL`/unique), `Enter` commits, invalid → red inline error.
  - Acceptance: user adds `users` with `id INT PK`, `email VARCHAR(255)` via keyboard only.
  - Depends: T2.

- [x] T4: Canvas render + click-drag + arrow-key move (M)
  - `position:absolute` boxes in `cell` units, `border: single`; click/Tab selects.
  - Click-drag: mousedown on entity → start drag; mousemove → update position; mouseup → stop drag.
  - Arrow keys: move selected 1 cell. Click also selects.
  - `.` hint overlay. Status bar: entity count, selected name, position.
  - Acceptance: two entities visible, repositioned by both mouse drag and arrows.
  - Depends: T2, T3.

## Checkpoint: after T3–T4
- [x] Manual: create 2 positioned entities end-to-end.

- [x] T5: Relationship editor + orthogonal edge overlay (L→split if slips: 5a editor, 5b routing)
  - Panel: from/to `<select>`, kind `(•)1:1 (•)1:N (•)N:M`, add/remove.
  - `src/lib/edges.js` pure fn: orthogonal routing (`─│┌┐└┘┼` + `3` many-marker) via `edgeGrid(model, rects, cols, rows)`.
    L/Z bends via midpoint; endpoints at box edges; vertical-overlap skipped. Crossing → `┼`.
  - Acceptance: `users 1:N posts` renders orthogonal line with correct end glyphs.
  - Depends: T4.

- [x] T5b: SVG export (M)
  - `src/lib/export.js` pure fn: ERDModel → SVG string. Entity boxes → `<rect>` + `<text>`, edges → `<path d="M... Q...">`.
    TODO items → `<text>`. Status → `<text>`. File: save to `<name>.svg`.
  - Acceptance: SVG file valid XML, renders in browser viewer.
  - Depends: T5.

- [x] T5c: TODO list (M)
  - Entity todos: `{id, text, done: bool}[]` stored in Entity. Add/remove/complete via sidebar panel.
  - Displayed in entity detail view below fields. Input + checkbox + delete button.
  - Acceptance: can add 3 todos to an entity, check/uncheck, delete one.
  - Depends: T3.

- [x] T6: MySQL DDL generator (M)
  - `src/lib/sql.js` pure: `CREATE TABLE` with backtick-quoted names, `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`;
    `AUTO_INCREMENT` for PK INT; 1:1/1:N → FK column + `FOREIGN KEY`; N:M → junction table.
  - Preview in `<dialog>` / `<textarea readonly>`; `p` copies nothing — export path only.
  - Acceptance: `node src/lib/sql.test.mjs` asserts full DDL for users/posts/junction fixture.
  - Depends: T2.

## Phase 3: Persist + polish

- [x] T7: `.erd` save/load + `.sql` export (M)
  - `node:fs` via a thin `io.js` seam (injectable for tests). Save/load `<name>.erd` JSON `{version:1, model}`;
    load = parse-don't-validate (schema check → ↯ escape "invalid file" dialog, corrupt never crashes).
    Export `<name>.sql`.
  - Acceptance: save → quit → reload restores canvas incl. positions; export file valid MySQL (paste-check).
  - Depends: T2, T6.

- [x] T8: Undo/redo + help overlay + mouse drag (M)
  - Snapshot stack over T2 immutable models; `u`/`r` undo/redo (not `Ctrl+Z` — that suspends in svelterm).
  - Mouse drag: mousedown on entity → `dragging = name`; mousemove → `moveEntity(dx, dy)`; mouseup → `dragging = null`.
    Keyboard arrows also supported. `?` toggles `<dialog>` keymap.
  - Acceptance: 5 moves + 2 undos = 3rd state. Mouse drag moves entity smoothly.
  - Depends: T3–T7.
- [x] Full flow: new → 3 entities → fields → 2 relationships → save → load → export SQL. Tests green. `pnpm run build` ships single file.

## Verification commands

```
pnpm run build            # bundle clean
node src/lib/*.test.mjs   # model + edges + sql (no framework)
pnpm run app              # manual UI pass
```

## Parallelizable

T6 (sql.js) ∥ T5b (SVG export) ∥ T5c (TODO) ∥ T5 (edge routing) after T4. T7 shares io seam with nothing — after T6. T8 last (touches all).
