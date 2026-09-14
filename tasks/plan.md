# Implementation Plan: ERD Creator (svelterm MVP)

## Overview

Terminal-native Entity Relationship Diagram editor built on svelterm (Svelte 5 → character-cell grid).
MVP: user creates up to ~4 entities with typed fields, positions them with arrow keys, links them with
1:1 / 1:N / N:M relationships drawn as orthogonal box-drawing lines, saves/loads `.erd` (JSON), and
exports MySQL `CREATE TABLE` DDL to `.sql`.

## Decisions (approved)

- Dialect: **MySQL first** (generator interface keeps other dialects additive, but none built now — YAGNI).
- Positioning: **click-drag** (mouse click on entity, move with mouse; keyboard arrows also supported). Svelterm mouse events carry cell coords.
- Relationship lines: **orthogonal** (box-drawing `─│┌┐└┘┼` with `3` many-marker on `─`/`│` ends, L/Z bends via midpoint). Vertical-overlap skipped (MVP).

## Architecture Decisions

- **Svelte 5 runes as the single state source** (`$state` model store). Immutable updates: every mutation
- **Parse, don't validate** at the two trust boundaries: `.erd` file load (JSON → schema check → ERDModel)
  and user editor input (name regex `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, field-type whitelist).
- **Layout = CSS `position: absolute` + `top/left` in `cell` units**; entity boxes are bordered divs
  (`border: single`). Connection overlay is a `<pre white-space: pre>` grid layer under the boxes,
  painted by a pure function `edgeGrid(model, rects, cols, rows) → string` (orthogonal `─│┌┐└┘┼`).
- **SQL generator is a pure function** `ERDModel → string` — zero UI dependency, trivially unit-testable.
  N:M emits a junction table. 1:1/1:N emit FK columns + `FOREIGN KEY` constraints.
- **SVG export** renders entity boxes + orthogonal edges + TODO items as SVG elements. `position:absolute` boxes
  map to SVG `<rect>` + `<text>`. Edge grid maps to SVG `<path d="M... Q...">` (quadratic bezier for smooth
  export while canvas uses orthogonal glyphs).
- **TODO list** stored as `Entity.todos: {id, text, done: bool}[]`. Displayed in entity detail panel.
  Editable via inline input.
- **Mouse drag**: mousedown on entity box sets `dragging: Entity.name`, mousemove moves entity,
  mouseup releases drag. Keyboard arrows also supported. Both map to `moveEntity()`.
- **Orthogonal edges**: box-midpoint routing via `edgeGrid` with `H/V/NE/SE/SW/NW` glyphs and `3` many-marker;
  vertical-overlap skipped, crossing produces `┼`. Canvas is fixed logical size (e.g. 120×40 cells); terminal
  smaller than that scrolls via `overflow: auto`.
- Mouse click still focuses/selects entities (svelterm mouse events carry cell coords); arrows move selection.
# one-time: build the svelte fork svelterm needs
git clone -b svelte-custom-renderer https://github.com/tomyan/svelte.git svelte-fork
cd svelte-fork && pnpm install && pnpm -C packages/svelte build && cd ..

# project
pnpm dlx @svelterm/core init erd-creator   # scaffold (expects ../svelte-fork sibling)
cd erd-creator && pnpm install
pnpm run app        # terminal app, hot reload
pnpm run build      # dist/app.mjs self-contained
```

## Dependency Graph (build bottom-up, slice vertically)
model store (T2) ──┬── entity/field editor (T3) ──┐
                  ├── canvas renderer (T4) ◀──────┤
                  ├── relationship editor (T5) ───┴── edge overlay (T5)
                  ├── sql generator (T6) ◀── model store
                  ├── SVG/PNG export (T5x) ◀── model store + edge rendering
                  ├── TODO list (T5y) ◀── model store (part of entity)
                  └── file io (T7) ◀── model store + schema
undo/help/status (T8) wraps T2-T8

## Risks

| Risk | Impact | Mitigation |
| ------ | -------- | ------------ |
| svelterm is early-stage; fork build breaks | High | Task 1 is the spike — fail fast before any feature code |
| SVG export needs off-screen canvas for PNG | Med | SVG-only for MVP (no PNG) |
| Edge overlay repaint perf on big models | Low (≤4 entities MVP) | Pure fn `edgeGrid`; ponytail ceiling noted in code |
| Name/type injection into SQL | Med | Whitelist at boundary (T3/T7); generator quotes with backticks |
| Mouse drag conflicts with form focus | Med | Entity boxes have `z-index > forms`; click on box captures mouse |
| Orthogonal edge routing vs curved spec | Low | `edgeGrid` midpoint L/Z with `┼` crossing; canvas orthogonal, SVG bezier |
| Arrow-drag feels sluggish | Med | keydown handler mutates state only; render is diffed ANSI already |

## Open Questions

- SVG export: node-canvas for PNG or SVG-only for MVP? → SVG-only (skip PNG).
- TODO list: per entity or global? → per entity (stored in `Entity.todos`).
- Edge rendering: canvas `─│┌┐└┘┼` with `3` many-marker; SVG `Q` bezier — acceptable? → yes.
- Mouse drag: click+hold + move, or click-to-select + arrows? → both (mouse drag + arrow keys).

## Tasks

Tracked in `tasks/todo.md` (checklist target).
