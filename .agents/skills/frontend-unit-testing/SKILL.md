---
name: frontend-unit-testing
description: "Write behaviour-driven unit tests for frontend/src JS under node:test. Use when adding, backfilling, or reviewing frontend unit tests, or when a test only asserts existence."
---

# Frontend unit testing (this repo)

Discipline adapted from gradio-app/gradio `frontend-unit-testing` — pinned
[SKILL.md](https://github.com/gradio-app/gradio/blob/0293306f3f25bf4cda44b6e819060edd5fcbd09e/.agents/skills/frontend-unit-testing/SKILL.md)
— plus grafana/grafana `frontend-testing-strategy` — pinned
[SKILL.md](https://github.com/grafana/grafana/blob/20a1eaa5e56d8ca8ac5603a779bb0eb37a98c6c5/.claude/skills/frontend-testing-strategy/SKILL.md)
(see upstream LICENSEs). Rejected: Vitest browser mode,
`@self/tootils`/`run_shared_prop_tests`, `jest.mocked`/`setTestFlags` — here it
is `node --test test/*.test.js` plus local harnesses.

## Run

```sh
cd frontend && pnpm test                  # all: node --test test/*.test.js
node --test test/<name>.test.js           # one file
```

## Harness (`test/helpers.js`, `test/fixtures.js`)

- Extend the shared harnesses, never duplicate: `makeStore`, `makeFlash`,
  `stubFetch`, `withPrompt`, `sleep`, `readSrc`; factories `S`/`T`/`C`/`GT`.
- Stub only what is genuinely unavailable (fetch, prompt, timers). Run real
  modules otherwise; every mock is confidence given up.

## Bar

- Behaviour, not implementation: assert computed values and observable effects,
  never class names or DOM structure for its own sake.
- Expected values are frozen literals, never recomputed by calling the code
  under test. Mutate-to-red before landing: a test that stays green proves nothing.
- Name the test for exactly what it asserts; no "renders without crashing", no
  `toBeDefined`/`not.toThrow` as the whole test; delete redundant coverage.
- Paint-only props (canvas colours, spacing) get
  `test.todo("VISUAL: <prop> → <expected look> — needs e2e screenshot")`,
  never a shallow assert. No snapshot tests. (`test.todo` exists in
  `node:test` v24; the runner reports a todo count, not a silent pass.)
