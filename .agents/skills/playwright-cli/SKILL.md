---
name: playwright-cli
description: "Author, fix, or interactively probe Playwright e2e for this repo (Go server + embedded dist, serial suite). Use when asked to validate browser flows, write or fix e2e specs, or drive the running app."
---

# Playwright e2e (this repo)

Adapted from microsoft/playwright `playwright-cli` — pinned
[SKILL.md](https://github.com/microsoft/playwright/blob/500c9c822ce7664539a4c8a88810048dfe090c3b/packages/playwright-core/src/tools/skills/playwright-cli/SKILL.md),
[test-generation](https://ossrules.md/microsoft/playwright/skills/playwright-cli-82c9bb78dcc7/file?path=references%2Ftest-generation.md)
(see upstream LICENSE). The upstream `playwright-cli` binary is NOT installed
here — `@playwright/test ^1.63.0` is the runner. Borrow its plan→generate→heal
mechanics, not its CLI.

## Run

```sh
cd frontend && pnpm run e2e                    # full suite (from frontend/)
npx playwright test e2e/<name>.spec.js         # one file (from frontend/)
npx playwright test --debug                    # headed, step through
```

## Setup facts (`playwright.config.js`, `e2e/server-probe.mjs`)

- Suite drives the REAL product: Go server + embedded `frontend/dist`, Chromium.
- `workers: 1` — serial is deterministic; the suite shares one `schemas-e2e/` store.
- `E2E_PORT` lives in `e2e/server-probe.mjs` (single source; config imports it).
- `global-setup` probe REFUSES a foreign process on the port (a stale binary or a
  server pointed at real `schemas/` — every test wipes the store it finds).
  `ERD_E2E_REUSE=1` trusts whatever is on the port; only for deliberate debugging.
- NEVER point the suite at the real `schemas/` directory.

## Conventions (`e2e/helpers.js`, `e2e/*.spec.js`)

- `test.beforeEach`: `wipeStore(request)` — every test starts from an empty store.
- Locators: `getByRole` / `getByTestId` first; `.tname`, `section.table` class
  locators where specs already use them. No fragile CSS chains in new tests.
- Assertions: `toBeVisible`, `toHaveValue`, `toHaveText`, `toHaveCount` on
  observable UI state. Add the assertion by hand — recorded actions aren't tests.
- New flows go in the matching spec (`app`, `dialog`, `keyboard`, `api`,
  `api-validation`, `new-features`); extend `e2e/helpers.js`, don't duplicate.
- Generate locators with `npx playwright codegen http://127.0.0.1:<port>`; paste
  only the locator, keep the hand-written assertion.
