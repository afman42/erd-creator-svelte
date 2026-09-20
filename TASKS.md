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
      name plus one parenthesised argument list, which covers every type the UI
      offers (verified against all 13, including `ENUM('a b','c,d')` and
      `NUMERIC(8, 2)`). Trigger: a legitimate type rejected — e.g. array or
      nested-parameter syntax (`VARCHAR(255)[]`). Widen the pattern deliberately
      and add the case to `TestAcceptsRealTypes`; do not loosen it to "anything
      without a semicolon", which is what made the original injection possible.

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
