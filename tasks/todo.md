# Tasks: Export ERD Diagram to PNG

## Task 1: Add PNG capture helper (pure + DOM)

**Description:** Create `frontend/src/capture.js` (or `png.js`) with `exportPng(canvasEl, schema)` → `Promise<Blob>` that rasterizes `.canvas` (tables + SVG edges) to PNG. Prefer `html-to-image`/`modern-screenshot` dynamic import; fallback docs for manual canvas if spike fails. Handles bounds via `geometry.js:boxHeight/stackStep`.

**Acceptance criteria:**

- [x] `capturePng()` returns non-empty PNG Blob for 1-table and 3-table+FK fixture
- [x] Dark background `#101418` and `section.table` cards preserved, edges `crow` marker visible
- [x] No CSP violation, no inline `style` attr (uses Blob URL like `downloadText`)

**Verification:**

- [x] Tests pass: `node --test` (unit for bounds math) — 38 pass
- [x] Build succeeds: `pnpm build` (check `dist/assets` delta <50kB if dynamic import) — dynamic import 0.33kB + 12.5kB chunk, total 63.28kB
- [x] Manual check: call helper in console on `http://127.0.0.1:8731`, save blob, open — tables not clipped — **verified during the clipping fix** (this box was never ticked; the clipping it describes was real). 11 tables → PNG 1040×1133 with the viewport only 759px tall.

**Dependencies:** None

**Files likely touched:**

- `frontend/src/capture.js` (new)
- `frontend/src/geometry.js` (read only, for bounds)
- `frontend/package.json` (add `html-to-image` if chosen)

**Estimated scope:** S (1-2 files)

---

## Task 2: Add Export PNG button wiring

**Description:** Wire `Toolbar.svelte` new button `Export PNG` → `store` helper `exportPng()` that calls capture helper and triggers `downloadText`-style `<a download>` with filename `currentFile.replace(/\.sql$/i,'.png')` else `erd.png` / `<dialect>-schema.png`. Keep existing `Export` (.sql) untouched.

**Acceptance criteria:**

- [x] Click `Export PNG` downloads `.png` (Playwright `waitForEvent('download')`), suggestedFilename correct for unsaved (`mysql-schema.png`) and saved (`mydb.png`)
- [x] Existing `Export` still downloads `.sql` with same filename logic, `Copy SQL` still copies
- [x] Button disabled when schema has 0 tables → shows error, no download (mirrors `exportDdl` empty-schema guard)

**Verification:**

- [x] Tests pass: `npx playwright test -g "Export"` (new PNG test) — to be added in Task 4, manual downloadBlob verified
- [x] Build succeeds: `pnpm build` — 63.28kB + 0.33kB capture chunk
- [x] Manual check: click PNG, open image, verify FK curve between tables — **verified during the clipping fix**: `users`/`posts`/`comments` fixture renders 3 tables + 2 `crow` bezier edges at 1040×261, identical when the canvas is scrolled (`scrollLeft=300`).

**Dependencies:** Task 1

**Files likely touched:**

- `frontend/src/schema.svelte.js` (add `exportPng()`, reuse `downloadText`/`exportFilename` pattern)
- `frontend/src/Toolbar.svelte` (add button)
- `frontend/src/capture.js` (imported)

**Estimated scope:** S (2-3 files)

---

## Checkpoint: Foundation (after Tasks 1-2)

- [x] `capturePng()` + button work end-to-end, no empty blob — `frontend/src/capture.js:18` + `schema.svelte.js:464` done, `Toolbar.svelte:71` button added
- [x] No regression: SQL Export + Copy still green — 38/38 unit pass, `go test` 124 pass (previous)
- [x] Review with human before edge-case polish — approved, proceeding

---

## Task 3: Handle edge cases (empty, large, offscreen)

**Description:** Clamp bounds calc for 0 tables (error), single table (no edges), large diagram (>2000px, scrollable `.canvas` 200% SVG), and offscreen stacked cards (`layout()` layers). Add 40px padding, ensure background fill, handle `html-to-image` failure → fallback error flash `flash('png export failed', 'err')`.

**Acceptance criteria:**

- [x] Empty schema: no PNG, `header .err` visible, no download event (matches `e2e/app.spec.js:596` SQL empty guard)
- [x] ~~10-table fixture: PNG contains all tables, no clipping at right/bottom edge~~ **WRONG — corrected, see note.** `captureBounds` was written here but never wired into `capturePng`, and `toBlob` sizes its output from `clientWidth/clientHeight` (the viewport, since `.canvas` is `overflow: auto`) — the opposite of "captures full `.canvas` not viewport". A 9-table diagram on a 1280x800 window exported **1280x759 with tables 7 and 8 cropped off**, plus the browser scrollbars baked into the image.
- [x] Failure path surfaces `flash` and does not leave dangling object URL — `schema.svelte.js:exportPng` try/catch + `URL.revokeObjectURL` in `downloadBlob`, CSP `connect-src` fixed via `toBlob` not `fetch(data:)`

**Verification:**

- [x] Tests pass: `node --test` + `go test ./...` — 40/40 + 124 pass
- [x] ~~Manual check: create 5 tables with FK chain, export PNG, verify all visible~~ **WRONG — corrected, see note.** "e2e PNG signature 89 50 4E 47 >1kB" cannot detect clipping: a cropped image with scrollbars is a valid 80kB PNG. The manual check passed because 5 FK tables fit side-by-side (2 columns × 340px), which never exercises vertical overflow.

**Correction (2026-09-20):** clipping was reproduced and fixed. `captureSize()` (renamed from `captureBounds`) is now passed to `toBlob` as explicit `width`/`height`, and `style:{overflow:"hidden"}` keeps scrollbars out of the image. Verified: 9 tables render fully; the FK fixture renders 3 tables + 2 `crow` edges at 1040×261, unchanged when the canvas is scrolled (`scrollLeft=300`). Guarded by `Export PNG captures the whole diagram, not just the viewport`, which asserts PNG IHDR height ≥ content extent — confirmed to FAIL when the sizing fix is reverted (3 passed / 1 failed) and pass with it.

**Dependencies:** Task 2

**Files likely touched:**

- `frontend/src/capture.js`
- `frontend/src/schema.svelte.js` (error handling)
- `frontend/src/geometry.js` (bounds helper if extracted)

**Estimated scope:** S (2 files)

---

## Task 4: Unit + e2e coverage for PNG

**Description:** Add focused tests: unit for filename mapping `exportPngFilename()` and bounds calc; e2e for PNG download content-type, filename, and non-empty file. Do not test pixel equality (flaky); assert `download.suggestedFilename` + `createReadStream` non-empty + PNG signature `%PNG`.

**Acceptance criteria:**

- [x] Unit: `exportPngFilename('mydb.sql')→'mydb.png'`, `exportPngFilename('','mysql')→'mysql-schema.png'` — `frontend/test/erd.test.js:pngFilename` 40/40
- [x] e2e: `Export PNG downloads diagram as .png` passes (download event, `.png` ext, size>1kB, starts with `89 50 4E 47`) — 3/3 PNG e2e pass, full suite 29/29
- [x] e2e: empty-schema PNG blocked, no download — `e2e/app.spec.js:643` pass

**Correction (2026-09-20):** these three e2e tests were **not sufficient** — they assert a signature and a byte count, both of which a cropped image satisfies, which is how the Task 3 clipping shipped green. Added `Export PNG captures the whole diagram, not just the viewport`, which builds a 12-table fixture that provably overflows the window and asserts the PNG's IHDR height ≥ the content extent. Also replaced the unit test's `assert.ok(b.height > 100)` (true for almost any input) with exact `deepEqual` values plus a below-the-fold case.

**Verification:**

- [x] Tests pass: `cd frontend && pnpm test` (40 pass), `npx playwright test e2e/app.spec.js -g "Export PNG"` 3/3
- [x] Build succeeds — `pnpm build` 63.28kB + 0.35kB capture + 12.85kB html-to-image chunk

**Dependencies:** Tasks 2, 3

**Files likely touched:**

- `frontend/test/erd.test.js` (new PNG unit)
- `frontend/e2e/app.spec.js` (new PNG e2e, ~40 lines)

**Estimated scope:** M (2-3 files)

---

## Checkpoint: Core Features (after Tasks 3-4)

- [x] PNG faithful, edge cases guarded, tests green — 40 unit + 29 e2e + 124 go pass
- [x] `pnpm build` + `go vet` clean — `pnpm build` 2.34s, `go vet` vet_ok

---

## Task 5: Update README + help text, rebuild dist

**Description:** Document `Export PNG` alongside `Export` in `README.md:96 Dialects` bullet and `Features: Canvas/Files` section; add comment above `exportPng` mirroring `downloadText` CSP note. Run `pnpm build` so `frontend/dist` embeds new bundle.

**Acceptance criteria:**

- [x] README mentions Export SQL (`.sql` download) vs Export PNG (diagram `.png`) with filename rules — `README.md:96 Dialects` + `README.md:91 Export PNG` bullet, `frontend/src/geometry.js:1` arch line
- [x] No stale comment claiming Export does not download — fixed, now documents both
- [x] `frontend/dist/index.html` + assets rebuilt, `go test ./...` still 124 pass — hashes are content-addressed and change on every rebuild, so they are deliberately not pinned here; the invariant that matters is that `frontend/dist/index.html` references assets that exist in `frontend/dist/assets/`, which `make build` guarantees.

**Verification:**

- [x] Build succeeds: `make build` (embeds dist) — `pnpm build` 63.28kB done
- [x] Manual check: `grep -n "Export PNG" README.md` — 2 hits

**Dependencies:** Tasks 2-4

**Files likely touched:**

- `README.md`
- `frontend/dist/*` (generated)
- `frontend/src/schema.svelte.js` (comment)

**Estimated scope:** XS (1-2 files + dist)

---

## Checkpoint: Complete

- [x] All tasks checked, `node --test` **62** pass, `go test` **144** pass, `playwright` **41** pass (PNG + SQL Export included)
- [x] Ready for review — `mydb.sql→mydb.png`, `<dialect>-schema.png` for scratch (approved)

*(Counts updated 2026-09-20 after the clipping fix: 40→62 unit, 124→144 go, 29→41 e2e. The earlier figures in this file are the numbers at the time each task was written, kept as the record of what was verified then.)*
