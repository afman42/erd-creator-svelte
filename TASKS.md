# TASKS

Open work, each with the trigger that makes it worth doing. Done work lives in
git history, not here.

## Deferred — add when trigger fires

- [ ] **Was CI ever green after `4e088cf`?** The frontend lint step
      (`pnpm run lint` → `biome check src test e2e`) exited 1 at `4e088cf`,
      `db91922` and `d0b0f2e` — verified by checking out each commit and
      running it. CI runs that as a hard step, so either the workflow was red
      for three commits without anyone noticing, or the CI environment differed
      in some way. This matters beyond tidiness: the security work in the same
      branch was reviewed on the premise that CI passes, and lint is the
      cheapest of those gates. The violations themselves are fixed (see the
      trail below); this item is the *question* they leave open. Trigger:
      already fired. Fix is to check the Actions history for those commits and,
      if CI was in fact red, add a required status check so a red lint cannot
      merge again.

- [ ] Drive CSS from the JS constants instead of mirroring them. The numbers
      still live in both places (`geometry.js` and `TableCard.svelte`'s
      `<style>`), but a unit test now parses the CSS and asserts it matches, so
      drift fails at test time. **Half the trigger has fired:** `capture.js`'s
      `captureSize()` is now a third consumer of `BOX_W`/`boxHeight()`, so the
      metrics have three readers (`TableCard.svelte` CSS, `layout()`/`addTable()`
      stacking, and PNG bounds). The other half — "a visual bug the test did not
      catch" — has not: the CSS-drift test covers every metric `captureSize()`
      reads (`BOX_W` via `section.table width`, `boxHeight()` via
      `HDR_H`/`ROW_H`/`ADDCOL_H`/`BORDER_H`), so a drift there still fails at
      test time rather than silently cropping the PNG. Not yet worth the
      refactor on one of two conditions; the real fix is CSS custom properties
      set from `geometry.js`, which removes the duplication rather than
      guarding it. Trigger: a visual bug the test did not catch, or a *fourth*
      consumer.

- [ ] **Authentication.** There is none — reaching the port is the whole
      authorization model. That is correct for a single local user and is why
      the default binds loopback only. Trigger: binding beyond loopback on a
      network you do not fully control, or any second user. Minimum viable fix
      is a shared secret compared with `crypto/subtle.ConstantTimeCompare` on
      every request, not a login page.

- [ ] **TLS.** The server is plain HTTP. Trigger: any bind beyond loopback —
      the schema and the generated DDL then cross the wire in the clear. Fix is
      a `-tls-cert`/`-tls-key` pair with `ListenAndServeTLS`; the CSP and
      `sameOriginGuard` already assume the browser sees one origin, so nothing
      else needs to change. Only then add HSTS, which is meaningless over http.

- [ ] **Rate limiting.** None, deliberately: a loopback tool has no remote
      attacker to throttle, and the 1 MiB body cap plus the server timeouts
      bound the damage. Trigger: the auth item above, or any bind beyond
      loopback — a limiter in front of one process is enough (no shared store
      needed) since this runs as a single instance.

- [ ] **Dependency audit is not in CI.** `pnpm audit` is clean today and no
      installed dependency declares an install script (verified), but nothing
      enforces either — CI runs lint, unit, build and e2e only. Trigger: adding
      a dependency, or cutting a release. Add `pnpm audit --audit-level=high`
      to the frontend job and a committed script policy
      (`pnpm.onlyBuiltDependencies`) so a future dependency cannot run an
      install script unreviewed.

- [ ] **`validateOutput` is a heuristic.** It flags a `;` that is not at a line
      end and not inside quotes, which catches the injection shape the emitters
      cannot produce — but it is pattern-matching generated text, not parsing
      it. Trigger: a new dialect that legitimately emits a mid-line semicolon,
      or a bypass found in review. Fix is to emit through a structured builder
      that cannot concatenate raw input, making the check unnecessary.

- [ ] **The accepted type grammar is a narrow allowlist.** `typeExpr` permits a
      name plus one parenthesised argument list, optionally followed by one
      array suffix. **Half the trigger has fired:** array syntax
      (`VARCHAR(255)[]`) was accepted deliberately, because it is a legitimate
      PostgreSQL type modifier — see the F8 entry in the trail. The other half —
      *nested-parameter* syntax, e.g. `NUMERIC(8,2) UNSIGNED` or a second
      argument list — has not, and multi-dimension (`INT[][]`) is refused on
      purpose rather than widened to. Widen further only for a concrete type a
      real dialect needs, and add it to `TestAcceptsRealTypes`; do not loosen
      the pattern to "anything without a semicolon", which is what made the
      original injection possible.

- [ ] **The CSP has no nonce path.** It is strict (`script-src 'self'`, no
      `unsafe-inline`) and the built app satisfies it because vite emits an
      external script and stylesheet. Trigger: any inline script or style becomes
      necessary. Add a per-response nonce then — do not add `unsafe-inline`,
      which would undo the XSS protection the header exists for.

- [ ] **E2E silently reuses a foreign server.** `playwright.config.js` sets
      `reuseExistingServer: true` and hardcodes port 8731, so if anything is
      already listening there the suite runs against *that* process — wrong
      binary, wrong `-dir` — with no warning. Reproduced: started a server on
      8731 with a different `-dir`, and playwright would have reused it. This
      cost real time during the security review (a stale build was measured
      three times before the cause was found). Trigger: already firing. Fix is
      to derive the port from the config, probe it before the run, and fail
      loudly if something is already bound rather than adopting it.

- [ ] **A deleted file is unrecoverable.** `deleteFile` confirms, then
      `os.Remove`s — no trash, no backup, and `history.length = 0` drops the
      undo snapshots that described it. Trigger: a user loses work to a
      mis-click, or the store is shared. Fix is a move to a `.trash/` sibling
      with a retention sweep, not a soft-delete flag (the file IS the model, so
      a half-deleted file in the listing would be worse).

- [ ] **Final save can be lost on tab close.** Marked `ponytail` in
      `schema.svelte.js`: a plain `fetch` may abort mid-unload, dropping up to
      800ms of edits. Trigger: real reports of edits lost on tab close. Fix is
      `keepalive: true` on the flush (64 KiB cap, ample here).

- [ ] **`.gitignore` has no secret patterns.** No `.env`, `*.pem` or `*.key`
      entry, and none exist today — so this is preventive, not a leak. Trigger:
      the first secret-bearing file is introduced (a TLS key from the TLS item
      above would be the likely first). Add the patterns before that lands, and
      remember a committed secret must be rotated, not just deleted.

## Done elsewhere (trail, not tracking)

- Min-max cardinality labels on FK edges (`0..1`, `1..1`, `0..N`), always on.
  Derived, never authored — which is the whole design: a stored cardinality
  field would be a second source of truth that could contradict the flags and
  would have to round-trip through a `.sql` file that stores no such thing.
  Deriving means no model change, no format change, and no way for the diagram
  to disagree with the DDL. `UQ` or a **sole** `PK` → child `0..1`, else `0..N`;
  `NOT NULL` → parent `1..1`, else `0..1`.

  Two things are worth recording. First, a composite-PK member is NOT unique on
  its own: in a junction table `PK(a, b)` each column repeats freely, which is
  precisely why it is M:N. Reading `pk` as unique would label every junction
  table `0..1` and invert the notation, so the check is `c.pk && pkCount === 1`.
  Second, the child minimum is always `0` — not a gap in the implementation, but
  a fact: SQL cannot express "every parent must have at least one child", so
  `1..N` would assert something no database enforces.

  **The unit tests passed while the feature was visibly broken, and only looking
  at the render caught it.** Three bugs survived a green suite:

  (1) The labels were anchored to the *path's* endpoints, and the path picks
  whichever borders are nearest — so when the child sat to the right the path
  started at the parent, drawing `0..N` on the parent and `1..1` on the child,
  inverting the notation.

  (2) With `text-anchor: middle`, a 22px label centred 6px from a border still
  reached 5px back over the card, and in the default stacked layout (all cards
  sharing an x range) one label landed inside the box.

  (3) In that same stacked layout the curve itself degenerated to a vertical
  line lying exactly on the card border — the edge was invisible, so its labels
  floated in empty space with nothing to attach to. The user spotted this one
  ("add it in arrow") and it was the real defect: fixing the label position
  while leaving the line invisible would have fixed nothing.

  The coordinate assertions were all true of the broken code, because they
  asserted where the labels *were* rather than which card each belonged to.

  The fix, in the end, was to stop positioning labels relative to cards at all:
  each label is evaluated **on the curve** with `pointOnCubic()` at t=0.25/0.75,
  so it cannot drift off its own line, and the curve **bows** (`EDGE_BOW`) when
  the cards overlap in x so there is a visible line to ride. Which end of the
  curve belongs to the child is tracked explicitly (`childAtStart`), because the
  routing starts at the *parent's* border when the child is to the right — the
  same inversion as (1), which is why a fixed fraction alone was not enough.

  Two more things the visual check caught after that. The fractions were 0.18/
  0.82 at first, and since every FK into one table terminates at the same point
  (its header centre) two such edges converge there — their parent-end labels
  landed 9px apart with 10px-tall text and overlapped. Pulling them back to
  0.25/0.75 uses the part of the curve where the edges are still apart, measured
  at 17px for the same fixture; a regression test now asserts ≥10px separation.
  And the labels carry a `paint-order: stroke` halo so the line does not strike
  through the text.

  **Two further routing bugs, found by an automated invariant sweep** (checking,
  for every layout, whether any label lands inside any card — the assertion the
  coordinate tests kept failing to make):

  (4) A **self-referencing FK** (`parent_id` → the same table — a tree or
  adjacency list, an ordinary pattern that parses, emits and round-trips) was
  routed `t.x` → `t.x + 60`, straight through the card body, so the loop and
  both labels were drawn inside the table. The UI cannot create one (the FK
  dropdown excludes the column's own table), so it is reachable only from a
  hand-written file — which is why no UI test had hit it.

  (5) **Partial** x-overlap. The bow was gated on `x1 === x2`, which is true only
  when the two borders coincide exactly; cards overlapping by any other amount
  took the side-to-side branch and the curve ran through both bodies. The check
  is now interval overlap (`t.x < p.x + BOX_W && p.x < t.x + BOX_W`), and the
  degenerate-bow condition is `x1 === x2` — the two are genuinely different
  questions, which is what the original code conflated.

  Both are covered: the self-loop test asserts the curve bows outside the card
  and neither label is inside it, the overlap test asserts both ends leave the
  rightmost border, and an e2e loads a self-referencing schema through the API
  and asserts no label overlaps any card in the real DOM.

  **The arrowhead was present but invisible** — reported as "i cannot see arrow
  in two tables in reference or not". The diagnosis is worth recording because
  the obvious reading was wrong: the marker was NOT missing from the export. The
  exported SVG contained `<marker id="crow">` and `marker-end="url(#crow)"`, and
  diffing a render with and without `marker-end` showed 22 differing pixels —
  it painted. It was simply unseeable: a 7×7 marker whose path had no
  `stroke-width` (a marker's contents do NOT inherit the referencing path's, so
  it drew at 1px while its line was 1.5px) in the same `#888` grey as that line.

  Fixed by enlarging to 11×11 with an explicit 1.8px stroke and moving line and
  marker onto a shared `--color-edge` token, brighter than `#888` and distinct
  from both the self-edge accent (`#bb5588`, which stays the self colour) and the
  label colour. Measured after: 64 differing pixels in a 10×11 box, ~3× the ink.

  One wrong turn is worth keeping: the first attempt used
  `stroke="context-stroke"` so the marker would inherit its path's colour and a
  self-edge would keep its accent. That is the documented mechanism, but it does
  NOT resolve when the path's stroke comes from a CSS class rather than a
  presentation attribute — the exported marker kept the literal string
  `context-stroke` and painted NOTHING, turning a faint arrow into no arrow. The
  colour is therefore written twice (marker attribute + `.edge` rule), and a test
  fails if the two disagree.

  **Then the line and labels were invisible in the export too** — "arrow head is
  visible but line and relationship cardinality not visible". The asymmetry was
  the clue: the arrowhead was the ONE element styled by a presentation
  attribute, while the line and labels were styled by CSS classes. Confirmed by
  inspecting the export: it contains NO `<style>` element and NO `.edge` rule,
  so `html-to-image` inlines computed styles for the HTML card divs (34 `style=`
  attributes) but not for SVG elements, and does not ship the stylesheet. The
  exported path was `<path class="edge svelte-…">` with no stroke at all.

  Proven rather than assumed: sampling the exported PNG at the curve and at both
  label positions returned `rgb(16,20,24)` — the background — at every point. The
  fix applies the paint as presentation attributes (`stroke`, `stroke-width`,
  `fill`, `font-size`, `text-anchor`, halo `stroke`), with the values as
  constants in `geometry.js`. Re-sampled after: `rgb(127,163,192)` at all three
  points. The duplication with `tokens.css` is load-bearing — a CSS custom
  property does not resolve in the exported document either — so a test asserts
  the constants and the tokens stay equal.

  The regression test asserts on **pixels**, not attributes: it exports both
  formats, reads the label positions out of the SVG, then samples the PNG there
  and requires luminance well above the background. Verified to FAIL on the
  broken version (`label 0 not painted … luminance 60 ≈ background 60`) and pass
  on the fixed one, so it is a real guard rather than a vacuous assertion.
  Totals moved 85→87 unit, 51→52 e2e.

- PostgreSQL array types (`INT[]`, `VARCHAR(255)[]`, `JSON[]`). This was
  originally my top recommendation as "a one-file allowlist widening" and I
  withdrew it on finding that was wrong: arrays are PostgreSQL syntax, so
  accepting the type in the model meant the MySQL/MariaDB/SQLite emitters would
  produce DDL the database rejects. Doing it properly required making validation
  **dialect-aware**, which is the substantive part of this change:

  `Validate` now delegates to `ValidateFor(dialect)`, split into a
  dialect-independent `validateShape` plus a dialect-specific layer that refuses
  an array for any non-postgres target. The parameter is not cosmetic:
  `/export` takes the dialect as a **separate request field**, so a schema
  stored as postgres can be exported as mysql, and the check must run against
  the *requested* dialect rather than the stored one. Save/`GenSQL` pass the
  schema's own dialect; the export handler passes what the caller asked for. The
  refusal names the target dialect, so the error says what to do.

  Three combinations are invalid in PostgreSQL too and are refused regardless of
  dialect: `INT[][]` (no emitter here renders multi-dimension, so accepting it
  would emit something that does not mean what the model says), `ENUM[]` (the
  ENUM rendering is `TEXT + CHECK (col IN (…))`, which describes one value —
  there is no correct CHECK for an array of them), and an array column as `PK`
  or `AI`. The modal's toggle clears PK/AI when switched on rather than leaving
  them for the server to reject.

  The suffix had to survive the dialect's own type mapping: `JSON[]` → `JSONB[]`
  → `JSON[]`. `pgType`/`pgToModelType` now split the suffix off before the
  mapping and re-attach it after, because `splitType` uppercases and splits on
  `(` and `INT[]` has neither — so a naive change would have emitted `JSONB` and
  silently dropped the dimension.

  One bug was mine and worth recording because it was invisible in review: I
  wrote the regex suffix as `\[\]?`, which means "literal `[` then an *optional*
  `]`" — not "optional `[]`". It therefore required a `[` character, and every
  plain `INT` column stopped parsing. The existing suite caught it immediately
  (5 failures across 3 files); the fix is the grouped `(?:\[\])?`. Test
  coverage: 4 new Go tests including dialect enforcement and invalid forms, the
  array cases added to the postgres type-mapping round-trip, 3 assertions in the
  frontend modal test, and 2 e2e tests (round-trip + the mysql refusal, and the
  PK/AI clearing). Totals moved 158→162 Go, 68 unit, 47→49 e2e.

- Composite indexes: an index over two or more columns is now a table-level
  `Index{Name, Cols}`, emitted as an inline `KEY name (a, b)` for
  MySQL/MariaDB and a separate `CREATE INDEX` for Postgres/SQLite — matching how
  each dialect already emits single-column indexes. A **one-column** index
  deliberately still uses `Col.Ix`: that keeps every existing file's bytes and
  every schema's JSON unchanged (`Indexes` is `omitempty`), and the three
  parsers route by column count (one → `Col.Ix`, several → `Index`), which is
  what lets both shapes round-trip. The UI is a dialog reached from `⌗` in the
  card header rather than a card control, for the same reason the column
  controls moved out: a column-list control does not fit a 280px card, and
  keeping it out of the card leaves `boxHeight()` — and therefore every FK edge
  anchor and the CSS-drift test — untouched.

  This also fixed a real pre-existing bug. `reIndex` matched
  `KEY idx (a, b)` but the handler pulled a *single* name out of the line, so a
  hand-written composite index parsed **without error and was silently
  dropped**: both columns came back `ix=false` and the index vanished. Silent
  because the line was recognised and simply mis-read — the worst shape for a
  parser. `TestCompositeIndexArityRouting` pins it.

  One test expectation was corrected rather than the code: a `;` in an index
  name is *not* rejected by `Validate`, and should not be — it is safe inside a
  quoted identifier, exactly as in a table name (`a;b` is legal here). It is
  `validateOutput` that catches it at the last gate. The test now pins which
  layer rejects what instead of asserting a stricter contract than the
  table-name path has. `cloneTable` also needed an explicit index copy: the
  `...t` spread shares the array by reference, so a duplicated table would have
  silently shared its original's indexes. Totals moved 151→158 Go, 66→68 unit,
  46→47 e2e.

- `Export SVG`: the vector twin of `Export PNG` — same `captureSize()` bounds,
  same empty-schema guard, same filename rule with a `.svg` extension. Two
  details worth recording, because both are silent failure modes:

  `toSvg` rather than `toPng`. `toPng`/`toBlob` build a canvas from an `<img>`
  whose `src` is a data URL, and the CSP's `connect-src 'self'` blocks that —
  `toSvg` serializes the clone directly and never creates an image, so it stays
  inside the policy the security work established.

  The unwrapping. `toSvg` returns a **data URL**, not markup
  (`data:image/svg+xml;charset=utf-8,` + `encodeURIComponent(svg)`). Writing it
  to a `.svg` verbatim produces a file that begins `data:image/svg+xml…`, which
  no viewer opens — and which an extension check, a byte count or a "contains
  `<svg`" assertion all pass, because the payload really is in there. So
  `decodeSvgDataUrl` is exported and unit-tested for exactly that (both
  percent-encoded and base64 forms, plus rejection of a non-SVG payload), and
  the e2e test asserts the file *starts with* `<svg` rather than merely
  containing one. Verified beyond the suite by parsing a real export with
  `DOMParser`: root `svg`, `width="360" height="286"`, table names present.
  The dynamic import is preserved — `capture.js` is its own chunk and
  `html-to-image` stays a separate 12.9 kB one, so the SQL path still pays
  nothing. Totals moved 63→66 unit, 42→46 e2e.

- FK `ON UPDATE`: `Ref` gained `OnUpdate`, all three emitters render it, and all
  three parsers read it back. The two referential actions use **opposite**
  defaults on purpose. `ON DELETE` unset still means `CASCADE`, because that is
  what every file already on disk says and changing it would rewrite them;
  `ON UPDATE` unset means **omit the clause**, so a schema with no ON UPDATE
  action emits byte-identical output and `TestGenSQLGolden`/`TestPostgresGolden`
  did not move. Both fields are now an allowlist (`fkActions`, five values) at
  the `Validate` boundary, not free text — an action is emitted as raw SQL
  inside the constraint clause, so it is the same injection class as the type
  field, and `TestRejectsFKActionInjection` pins it. The parser canonicalizes
  case (`normalizeFKAction`) the way it already uppercases type names, or a
  hand-written `on delete cascade` would load and then be rejected on save.

  The interesting part is the bug the round-trip test caught. `parsePostgres`
  and `parseSqlite` each carried their own **copy** of `attachPendingFKs` —
  postgres's with a stale comment about submatch indices, sqlite's inline —
  while only the mysql path called the shared function. Adding `OnUpdate` to the
  shared helper therefore reached mysql and silently missed postgres and sqlite,
  and the two hand-written literals would not even compile, which is what
  exposed them. Fixed by deleting both copies and calling `attachPendingFKs`
  from all three parsers, so a field added to `Ref` cannot reach one dialect's
  parser and miss another's. This is the same failure mode as the save/export
  drift the repo already documents ("two emitters for one grammar drifted
  before"), one layer down: two parsers for one grammar drift the same way.
  Coverage: 7 Go tests (round-trip across all four dialects, absent-means-omit,
  clause order, defaults, injection rejects, accepts-real-actions, lowercase
  normalization), 1 frontend unit test on `cloneTable`, and 1 e2e that drives
  the dialog through save, reload and the SQL panel. Totals moved 144→151 Go,
  62→63 unit, 41→42 e2e.

- PNG export clipping: `Export PNG` cropped every table past the viewport —
  `captureBounds()` was written and unit-tested but never passed to
  `toBlob`, so `html-to-image` sized from `clientWidth/clientHeight` (the
  viewport, since `.canvas` is `overflow: auto`). A 9-table diagram on a
  1280x800 window exported 1280×759 with the last two tables missing, plus the
  browser scrollbars painted in. The plan had predicted this exact risk and
  described the fix; it still shipped, because no test asserted the output's
  *size* — the e2e tests checked a PNG signature and a byte count, both of which
  a cropped image satisfies. Fixed by renaming to `captureSize()` (width/height
  only — `layout()` clamps coords to ≥0, so the old x/y offsets were
  unactionable), passing them to `toBlob`, and adding
  `style:{overflow:"hidden"}`. Guarded by an e2e test that builds a 12-table
  fixture, asserts it overflows the window, and requires the PNG's IHDR height
  to cover the content extent — verified to fail (3 passed/1 failed) when the
  sizing is reverted and pass with it. The store's duplicate `pngFilename` was
  deleted; `capture.js` now takes the schema from its caller instead of reaching
  for ambient state.

- Frontend lint was red and is now clean: seven `format` violations plus two
  `organizeImports` across `src/autosave.js`, `src/download.js`,
  `src/schema.svelte.js`, `test/download.test.js` and `test/history.test.js`,
  all from `4e088cf`/`db91922`, plus one `noUnusedFunctionParameters` warning in
  `test/autosave.test.js`. Fixed with `biome check --write` (formatting only —
  62 unit tests unchanged) and the underscore rename for the unused parameter.
  `biome check src test e2e` now exits 0 with zero diagnostics. The open
  question this leaves — whether CI was actually red on those commits — is
  tracked above.

- Security review: six exploitable issues found and fixed (commits eb08c9e,
  5b62f65, 77d5fab, d1d8905, a2aeeae). SQL injection through a column type
  (emitted raw, and persisted through the file parser), DNS rebinding (any Host
  accepted), cross-site writes (any Origin accepted), symlink escape on both
  read and write, no security headers, and no server timeouts. Fixed by
  validating at every input boundary, a Host allowlist and Origin guard,
  resolving store paths before use, a strict CSP, and read/idle timeouts.
  The residue is the deferred list above: auth, TLS, rate limiting and CI audit
  are all deliberate omissions with triggers, and `validateOutput` guards the
  injection class rather than eliminating it structurally.

- Box geometry vs CSS mismatch: trigger fired — column controls overflowed the
  card by up to 121px, and FK edges drifted 14px by the fourth column, because
  the metrics were hand-copied into CSS *and* re-derived at each call site
  (`layout()` added `24 + GAP`, `addTable()` a bare `36`, and both understated
  the real card by 3px). Fixed by deriving `boxHeight()`/`stackStep()` in
  `geometry.js`, pinning the CSS heights, and adding tests that read the CSS.
  The residue is the deferred item above: the duplication is guarded, not gone.

- Extract fetch glue (lint/save/export round-trips) out of `App.svelte`:
  trigger fired — Playwright e2e covers those round-trips server-side
  (`frontend/e2e/api.spec.js`), so DOM-adapter extraction loses its second
  consumer; retired instead of done.

- splitTop escape fix + geometry/lint split + node --test suites + docs
  sync + stripped binary: shipped as commits 4568625, 649ffb5, 20349ba.
- 50/50 rebalance: grammar (model/generate/parse/lint/inserts) moved to Go
  (`grammar.go`), `.sql` store added (`files.go`), JS grammar half deleted,
  file-picker UX replaced by server file list — pays the grammar-drift debt.
