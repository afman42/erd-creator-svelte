# TASKS

Open work, each with the trigger that makes it worth doing. Done work lives in
git history, not here.

## Deferred — add when trigger fires

- [ ] Extract file-picker/save/export-fetch out of `App.svelte`.
      Trigger: second consumer (headless CLI export, multi-tab app state) or
      a DOM test runner already in deps. Today: one adapter, DOM-bound,
      untested-on-purpose; extracting needs jsdom = new dep for no second caller.
- [ ] Single source of truth for the MySQL emit grammar (JS `generate()`/
      `parse()` ↔ Go `buildMysql()` + mirrored helpers: quoteIdent/quoteTick,
      INT_RE/isInt, sqlString/sqlStr).
      Trigger: the emitted grammar next changes and the two sides drift —
      the drift is now pinned by round-trip + escaping tests, so it fails
      loudly, not silently. Fix shape when paid: generate in Go, client calls
      /export mysql too, JS parser shrinks to what Go emits.
- [ ] Box geometry lives in `geometry.js` but CSS hardcodes the same numbers
      (`.row { height:26px }`, table `width:280px` in App.svelte).
      Trigger: first visual bug from ROW_H/HDR_H/BOX_W vs CSS mismatch; fix
      by driving CSS from the JS constants.

## Done elsewhere (trail, not tracking)

- splitTop escape fix + geometry/lint split + node --test suites + docs
  sync + stripped binary: shipped as commits 4568625, 649ffb5, 20349ba.
