# TASKS

Open work, each with the trigger that makes it worth doing. Done work lives in
git history, not here.

## Deferred — add when trigger fires

- [ ] Box geometry lives in `geometry.js` but CSS hardcodes the same numbers
      (`.row { height:26px }`, table `width:280px` in App.svelte).
      Trigger: first visual bug from ROW_H/HDR_H/BOX_W vs CSS mismatch; fix
      by driving CSS from the JS constants.

## Done elsewhere (trail, not tracking)

- Extract fetch glue (lint/save/export round-trips) out of `App.svelte`:
  trigger fired — Playwright e2e covers those round-trips server-side
  (`frontend/e2e/api.spec.js`), so DOM-adapter extraction loses its second
  consumer; retired instead of done.

- splitTop escape fix + geometry/lint split + node --test suites + docs
  sync + stripped binary: shipped as commits 4568625, 649ffb5, 20349ba.
- 50/50 rebalance: grammar (model/generate/parse/lint/inserts) moved to Go
  (`grammar.go`), `.sql` store added (`files.go`), JS grammar half deleted,
  file-picker UX replaced by server file list — pays the grammar-drift debt.
