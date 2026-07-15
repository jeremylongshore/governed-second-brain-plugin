# Testing — bobs-big-brain-plugin

The installable Claude Code / Cowork plugin. **One plugin, two modes** dispatched by
`TEAMKB_API_URL`: `local` (in-process brain over `~/.teamkb`, native `better-sqlite3` +
the private sibling monorepo `@qmd-team-intent-kb/*`) and `team` (a dependency-free
stdio proxy to the remote brain over the tailnet). The shipped artifact is the committed
bundle `plugin-runtime/governed-brain.cjs` (esbuild inlines the private packages).

## The CI constraint (why not everything runs in plain CI)

The build-only devDeps are `link:../qmd-team-intent-kb/*` — a **private sibling monorepo
that does not exist in a fresh GitHub Actions checkout**. So `build` and the full
`typecheck` cannot run in generic CI (same reason `smoke.yml` never builds). CI therefore
gates the surface that is reachable **without** the sibling monorepo, and the full stack
is validated locally + by the committed-bundle smoke.

## Layers

| Layer | Gate | Where |
|---|---|---|
| L2 static — lint | `pnpm lint` (eslint flat, typescript-eslint, parse-only) | CI `ci.yml` + local |
| L2 static — types (CI-safe subset) | `pnpm typecheck:ci` (`tsconfig.ci.json`: `src/mode.ts` + `src/remote-server.ts`) | CI `ci.yml` |
| L2 static — types (full) | `pnpm typecheck` (all `src/**`, needs the sibling monorepo) | local + smoke host |
| L3 unit | `pnpm test` / `pnpm test:coverage` (vitest) — `src/mode.ts`, `src/remote-server.ts` | CI `ci.yml` + local |
| L3 unit — anchor verifier | `pnpm verify-anchors:test` (zero-dep `node:test`) | CI `ci.yml` + local |
| L3 unit — anchor-on-transition | `pnpm anchor-on-transition:test` (esbuilds `src/anchor.ts` → needs sibling) | local |
| L5 system — full chain (zero egress) | `smoke/smoke.mjs`, `smoke/audit-verify-banner.test.mjs` (drive the committed bundle) | `smoke.yml` + local |
| L5 system — B1 auto-govern inbox sweep | `smoke/b1-inbox-sweep.mjs` (seeds remote-shape candidates in a throwaway `candidates` table, drives the sweep: promote/quarantine/duplicate/keep-in-inbox + idempotency) | `smoke.yml` + local |
| Policy pin | `audit-harness verify` (this file + any future `features/*.feature`) | CI `ci.yml` + local |

## Coverage floor

Scoped (`vitest.config.ts`) to the CI-testable modules `src/mode.ts` + `src/remote-server.ts`.
Current floor: **lines 55 / statements 50 / functions 45 / branches 45** — an honest number
for the pure helpers the unit suite owns (`resolveMode`, `errorResult`, `authHeaders`,
`search`). The `brain_capture` / `brain_transition` tool handlers and stdio boot in
`remote-server.ts` are exercised by the smoke suite over a real MCP session, not the unit
suite, so the file-level floor is modest by design. **Ratchet up as the unit surface grows;
never down.**

## What the unit suite pins (the review's risk areas)

- **`src/mode.ts`** — the local-vs-team dispatch predicate, extracted from `src/index.ts` so
  the "silently falls into local mode" trap (an unexpanded `${TEAMKB_API_URL}` placeholder,
  empty/whitespace values) is a regression-guarded function.
- **`src/remote-server.ts`** — `errorResult` (401/403/422/500 all surface a clear, role-aware
  message — never a silent success), `authHeaders` (bearer present/absent), and `search`.
  Two `search` tests **characterize** the current error-swallow (network error / non-OK →
  empty result) that the review flagged (R4/R8): pinned so the fix lands as a visible diff.

## Run it

```bash
pnpm install            # from a checkout that is a sibling of qmd-team-intent-kb
pnpm lint
pnpm typecheck:ci       # or: pnpm typecheck (full, needs the sibling monorepo)
pnpm test:coverage
pnpm verify-anchors:test
```

## One entrypoint — `pnpm test:plugin` (Governed Second Brain)

Product-shaped packs over the hermetic suite. Prefer this before a dogfood push or release.

| Command | What it runs |
|---|---|
| `pnpm test:plugin` | Unit + skill contract + local smoke + team stub smoke + mode-dispatch + onboarding assert (hits live demos page locally) |
| `pnpm test:plugin:quick` | Hermetic only (no vitest) |
| `pnpm test:plugin:live` | Above + `smoke/live-smoke.mjs` (team API health; set `TEAMKB_API_TOKEN` for auth/search) |
| `pnpm onboarding:assert` | Package + demos page alone |
| `pnpm smoke:live` | Team API only |

**Pack map**

| Pack | Script | Proves |
|---|---|---|
| A hermetic | `smoke/smoke.mjs`, `smoke-team.mjs`, `mode-dispatch`, vitest | Bundle + mode + stub team proxy |
| B live | `smoke/live-smoke.mjs` | Real team API on tailnet (+ optional token) |
| C onboarding | `smoke/onboarding-assert.mjs` | Manifest author object, skills, demos page prompts/commands/footer |
| D skills | `smoke/skill-contract.test.mjs` | `/brain` + `/brain-save` frontmatter + write-never-auto |

Human acceptance: [`onboarding/DOGFOOD.md`](../onboarding/DOGFOOD.md).
