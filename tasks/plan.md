# Implementation Plan: Export ERD Diagram to PNG

## Overview

Add PNG export for the ERD canvas (tables + FK bezier edges) alongside existing DDL export. Currently `Export` downloads `.sql` via `schema.svelte.js:exportDdl()` → Blob → `<a download>`; no image export exists. Users asking "export sql to png" mean rasterizing the diagram (not SQL text) so it can be pasted into docs/slides. Build one vertical slice at a time: utility → button → tests/docs.

## Architecture Decisions

- **Client-side rasterization, not server:** Go has no canvas state (positions live in `store.schema` + `geometry.js:BOX_W/ROW_H`). Client already renders SVG edges + absolute `section.table` cards. Capturing DOM to PNG keeps single source of truth, avoids duplicating layout in Go, and works offline.
- **Library: `html-to-image` (or `modern-screenshot`) over `html2canvas`:** Smaller, handles `foreignObject` + CSS better, no CSP `unsafe-inline` needed, exports SVG already in DOM. Fallback is manual `canvas` draw using `geometry.js:boxHeight/stackStep/edgePaths` if library proves heavy.
- **Coexist with SQL Export:** Keep `Export` as `.sql` download; add new `Export PNG` button. Renaming existing Export would break muscle memory and tests (`e2e/app.spec.js:549`). Two buttons share filename logic `exportFilename()` → `name.replace(/\.sql$/i,'.png')`.
- **CSP `default-src 'self'` safe:** Blob URL + `<a download>` already verified for SQL export (`schema.svelte.js:446 downloadText`). Same path for PNG, no `Content-Disposition` needed, no `style-src` inline.

## Task List

> **Status (2026-09-20): all five tasks executed and shipped.** Task-by-task
> checkboxes below are left as written (this was the plan, not the record); the
> record is `tasks/todo.md` and git history. One risk in the table below
> **fired and shipped broken** — see the annotation on it.

### Phase 1: Foundation — PNG capture utility

- [x] Task 1: Add PNG capture helper (pure + DOM)
- [x] Task 2: Add Export PNG button wiring

### Checkpoint: Foundation

- [x] Utility captures `.canvas` to Blob without empty/transparent output
- [x] Button appears, downloads `*.png`, respects `currentFile` naming
- [x] No regression: `Export` still downloads `.sql`, `Copy SQL` still copies

### Phase 2: Core Features — Polish & fidelity

- [x] Task 3: Handle edge cases (empty schema, offscreen, dark bg)
- [x] Task 4: Unit + e2e coverage for PNG

### Checkpoint: Core Features

- [x] PNG contains tables + edges, dark background preserved, not clipped
- [x] Tests green: `node --test` + `go test` + `playwright -g Export`

### Phase 3: Polish — Docs & release

- [x] Task 5: Update README + help text, rebuild dist

### Checkpoint: Complete

- [x] README documents Export SQL vs Export PNG
- [x] `pnpm build` + `go test ./...` clean

## Risks and Mitigations

| Risk | Impact | Mitigation |
| ------ | -------- | ------------ |
| html-to-image fails on Svelte scoped CSS / SVG marker | High | Spike 1h: capture `.canvas` in dev, verify edges/marker `crow` render; fallback to manual canvas draw via `geometry.js` |
| **PNG clipped (canvas 200% SVG, scrollable)** | Med | Compute bounds from `store.schema.tables` + `boxHeight()` + `edgePaths`, not viewport; add 40px padding. **⚠️ THIS RISK FIRED AND SHIPPED BROKEN.** The mitigation was written but only half-applied: `captureBounds()` was created and unit-tested, then never passed to `toBlob`, so `html-to-image` fell back to its own `clientWidth/clientHeight` sizing — i.e. exactly the viewport it was meant to avoid. A 9-table diagram on a 1280x800 window exported 1280×759 with the last two tables cropped. The risk was correctly identified, the mitigation was correctly described, and the code still shipped the bug because nothing asserted the *size* of the output. Fixed 2026-09-20: `captureSize()` now feeds explicit `width`/`height`, plus `style:{overflow:"hidden"}`; guarded by an e2e test that fails if the sizing is removed. **Lesson: a mitigation is not done when the helper exists — it is done when the caller uses it and a test asserts the outcome.** |
| CSP blocks Blob download | Low | Already retired for SQL export — same `downloadText` path, verified `default-src` does not govern downloads |
| Large diagram → memory/OOM | Low | Cap canvas size, use `pixelRatio:1`, warn if >4000px; debounced not needed (one-shot click). **Not implemented** — no size cap exists. Largest measured case (11 tables) produced a 114 kB PNG, so the trigger has not fired; `pixelRatio:1` is in place. |
| Library adds bundle weight | Med | Use dynamic `import()` for PNG lib so SQL path pays 0 bytes; measure `dist/assets` delta. **Done** — `html-to-image` is a separate 12.5 kB chunk, absent from the main bundle. |

## Open Questions

- Filename: `mydb.png` vs `mydb-erd.png`? Propose `currentFile.replace(/\.sql$/i,'.png')` else `erd-erd.png`? Need human pick. **Resolved:** `mydb.sql`→`mydb.png`; unsaved scratch → `<dialect>-schema.png` (not `erd-erd.png`).
- Button label/placement: `Export PNG` next to `Export` or dropdown? Propose adjacent button to keep vertical slice small. **Resolved:** adjacent button.
- Quality: need transparent vs `#101418` background? Current canvas is `radial-gradient` + dark cards — capture should preserve dark bg. **Resolved:** `#101418` opaque.

## Parallelization Opportunities

- Task 3 edge-case handling and Task 4 test writing can parallelize after Task 2 lands (contract: `exportPng()` returns `Promise<Blob>`).
- Docs (Task 5) parallel with tests once capture verified.

## References

- Current export: `frontend/src/schema.svelte.js:437 downloadText`, `exportDdl:464`, `exportFilename:461`
- Canvas: `frontend/src/App.svelte:91 .canvas` + `geometry.js:32 boxHeight/42 edgePaths`
- Cards: `frontend/src/TableCard.svelte:88 section.table` 280px, `geometry.js:24 BOX_W`
- Toolbar: `frontend/src/Toolbar.svelte:71 Export` button, tests `frontend/e2e/app.spec.js:549`
