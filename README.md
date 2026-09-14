# erd-creator

Terminal-native Entity Relationship Diagram editor. Create tables with typed fields,
draw relationships, save/load schemas, and export MySQL DDL or SVG — all in your
terminal.

Built on [svelterm](https://svelterm.dev) (Svelte 5 → character-cell grid).

![demo](https://i.imgur.com/placeholder.png)

## Prerequisites

svelterm needs the Svelte custom-renderer branch (unmerged upstream).
Clone and build it as a sibling of this project:

```bash
git clone -b svelte-custom-renderer https://github.com/tomyan/svelte.git ../svelte-fork
cd ../svelte-fork && pnpm install && pnpm -C packages/svelte build
```

## Install

```bash
pnpm install
```

## Run

```bash
pnpm run build  # → dist/app.mjs
node dist/app.mjs
```

### Compiled binary (recommended)

```bash
pnpm run dist:all  # build + bun compile → erd-creator-linux
./erd-creator-linux  # self-contained ~78 MB, no node needed
```

Produces per-platform binaries: `erd-creator-linux`, `erd-creator-darwin`, `erd-creator-win.exe`.
## Features

| Feature | Details |
| ------- | ------- |
| Entity editor | Add/remove tables, add/remove fields with name, type, PK, NULL, UNIQUE |
| Positioning | Arrow keys (1 cell), click to select, click-drag to move |
| Relationships | 1:1 / 1:N / N:M with orthogonal box-drawing lines on the canvas |
| SQL export | MySQL `CREATE TABLE` with `PRIMARY KEY`, `FOREIGN KEY`, N:M junction tables |
| Save/Load | `.erd` JSON files, schema-versioned, parse-don't-validate |
| SVG export | Entity boxes, edges, and TODO items as SVG |
| TODO list | Per-entity tasks, add/check/delete |
| Undo/Redo | `u` / `r` keys, up to 100 snapshots |

## Keyboard shortcuts

| Key | Action |
| --- | ------ |
| Arrows | Move selected table 1 cell |
| Delete | Remove selected table |
| Enter | Confirm entity / field input |
| u / r | Undo / Redo |
| ? | Help overlay |

## Project structure

```
src/
├── App.svelte        # Main component (panels + canvas + dialogs)
├── lib/
│   ├── model.js      # ERD model store (pure functions, immutable)
│   ├── layout.js     # Box geometry
│   ├── edges.js      # Edge cell-grid rendering
│   ├── sql.js        # MySQL DDL generator (pure function)
│   ├── export.js     # SVG export (pure function)
│   ├── io.js         # File I/O seam (injectable for tests)
│   ├── app.smoke.mjs # Headless UI smoke (renderHeadless + tick)
│   └── *.test.mjs    # Unit tests (model, sql, edges, export, layout, io)
└── main.css          # Global styles
```

## Testing

```bash
pnpm run test:unit    # Unit tests: model + sql + edges + export + layout + io (node:assert/strict)
pnpm run test:smoke   # Headless UI smoke via Vite terminal env (renderHeadless)
pnpm run test:ui      # UI + UX + snapshot tests via @microsoft/tui-test (dist/app.mjs)
pnpm run test         # All of the above (unit + smoke + ui)
pnpm run build        # Bundle to dist/app.mjs (svelterm build + patch)
```

### CI

GitHub Actions runs on every push/PR: `.github/workflows/test.yml`.
Steps: setup svelte-fork → `pnpm install` → `pnpm run build` → unit tests → smoke → tui-test.
Artifacts: `tui-traces/` on failure.

## License

MIT
