# TEST_AUDIT.md — bobs-big-brain-plugin

> Diagnostic produced by the `/audit-tests` 7-layer + gate sweep. Date: 2026-07-13.
> Scope: the installable **Bob's Big Brain** plugin — a Claude Code + Cowork MCP
> server, ONE plugin with TWO modes dispatched by `TEAMKB_API_URL`: `local`
> (in-process brain over `~/.teamkb`, native `better-sqlite3` + the private sibling
> monorepo `@qmd-team-intent-kb/*`, zero network) and `team` (a dependency-free
> stdio proxy to the remote brain over the tailnet). Node/pnpm/vitest — **not Bun.**

## Grade: B+ (87/100)

Strong, multi-layer, hard-gated posture: 72 vitest unit tests + 20 zero-dep
anchor-verifier tests green, coverage above its scoped floor, and a full **zero-egress**
system smoke that drives the SHIPPED committed bundle (`plugin-runtime/governed-brain.cjs`)
end to end through capture → govern → audit-verify → search. Gate configs are
hash-pinned (`audit-harness verify`), so silently gutting the CI workflow, lowering a
coverage floor, or narrowing the typecheck scope becomes a `HARNESS_TAMPERED` failure.

Held below A− by three honest structural gaps: (1) **no local pre-commit mirror** —
every gate lives only in CI, so a dev can commit lint/type/test failures and only learn
on the PR (the AGP-family siblings ship a `.githooks/pre-commit` that mirrors CI); (2)
**unit coverage is scoped to 3 files** (`mode.ts`, `remote-server.ts`, `team-config.ts`)
— the local-mode surface (`local-server.ts`, `govern.ts`, `anchor.ts`) is only reachable
through the private sibling monorepo, so it is exercised by smoke but carries no
unit-coverage number; and (3) **no RTM/traceability docs** and no mutation/architecture
gates. Gaps (1) and (2)(local-mode CI constraint) are the only things standing between
this and an A−.

## Classification

**Installable MCP plugin — CLI/library hybrid, dual-mode.** The plugin owns the MCP
tool surface (`brain_capture`, `brain_govern`, `brain_search`, `brain_status`,
`brain_transition`, `brain_audit_verify`) and the mode-dispatch + fail-closed boot in
`src/index.ts`/`src/mode.ts`. Governance (dedupe / policy / promotion / hash-chained
audit) is bundled from the private INTKB monorepo at pinned versions (`gsb.lock.json`)
and inlined into the committed runtime bundle by esbuild; on-device retrieval is upstream
`qmd`, SHA-256-pinned. The shipped artifact is the committed `.cjs` bundle, so CI attests
and smokes it rather than rebuilding it.

## The CI constraint (why not everything runs in plain CI)

The build-only devDeps are `link:../bobs-big-brain-registrar/*` — a **sibling monorepo
that does not exist in a fresh GitHub Actions checkout**. So full `build` and full
`typecheck` cannot run in generic CI. CI therefore gates the surface reachable **without**
the sibling (eslint parse-only over all `src/`, a scoped `typecheck:ci`, the vitest unit
suite, the anchor tests, and the committed-bundle smoke), and the full local stack is
validated locally + by the zero-egress smoke that drives the shipped bundle. This is a
deliberate, documented boundary (`tests/TESTING.md`), not an oversight.

## 7-layer presence / config / enforcement

| Layer | State | Evidence |
|---|---|---|
| L1 — git hooks & CI | ◑ CI-only HARD | 2 workflows: `ci.yml` (lint · `typecheck:ci` · `test:coverage` · anchor tests · `audit-harness verify`) + `smoke.yml` (full-chain, zero egress). **No local pre-commit hook** — no `.githooks/`, no `core.hooksPath`, no `.beads/hooks/pre-commit`; enforcement exists only on the PR. |
| L2 — static / lint / types | ✅ HARD | eslint flat + typescript-eslint (parse-only, all `src/`); `tsc --noEmit` (CI-safe subset `tsconfig.ci.json`; full `tsconfig.json` locally); `audit-harness verify` hash-pins the 5 gate configs (`.harness-hash` + `.harness-hash-extra-patterns`). |
| L3 — unit & function | ✅ HARD | 72 vitest tests across 6 files (`mode`, `remote-server`, `team-config`, `write-lock` + fail-closed) with a v8 coverage floor (`vitest.config.ts`); 20 zero-dep `node:test` anchor-verifier tests (`scripts/verify-anchors.test.mjs`). |
| L4 — integration | ✅ | `remote-server.test.ts` drives the team proxy against a request-capturing stub (401/403/422/500 role-aware surfacing, auth headers, search error-swallow characterized R4/R8); `smoke/b1-inbox-sweep.mjs` seeds remote-shape candidates and drives the sweep (promote/quarantine/duplicate/keep + idempotency); `smoke/inbox-approve.mjs` exercises the admin tool→wire contract over a real socket. |
| L5 — system quality | ✅ HARD | `smoke/smoke.mjs` (`smoke.yml`) drives the committed bundle through capture → govern → audit-verify → search **hermetically, zero LLM egress**, against the `gsb.lock.json`-pinned stack, with a lockfile-drift guard (`smoke/check-lock.mjs`). |
| L6 — E2E / acceptance packs | ✅ | `smoke/mode-dispatch.test.mjs` (local/team dispatch + fail-closed team.json fallback end-to-end through the bundle), `smoke/autocapture-hook.test.mjs` (opt-in hook safety guards — silent no-op unless deliberately enabled), `smoke/audit-verify-banner.test.mjs`. |
| L7 — acceptance / business | ✅ | The audit trust-model acceptance proven end to end in smoke: newcomer-safe verify messaging (no false TAMPER), counts-only default response omitting raw `breaks[]`/`detail` (R8), external-anchor consistency — the guarantees `SECURITY.md` commits to. |

## Deterministic gates (run 2026-07-13)

| Gate | Result |
|---|---|
| eslint (`pnpm lint`, all `src/`) | PASS (clean) |
| typecheck CI subset (`pnpm typecheck:ci`) | PASS |
| vitest unit + coverage (`pnpm test:coverage`) | PASS — 72 tests; stmts 82.08% (floor 68), branches 71.87% (floor 60), funcs 68.29% (floor 60), lines 83.40% (floor 70) |
| anchor verifier (`node --test scripts/verify-anchors.test.mjs`) | PASS — 20/20 |
| full-chain smoke (`node smoke/smoke.mjs`) | PASS — capture→govern→audit-verify→search, 0 tamper, 1 cited hit, zero egress |
| audit-harness verify (hash-pin) | OK — 5 gate configs unchanged |
| mutation testing | ABSENT — not configured |
| architecture gate (dependency-cruiser) | ABSENT — not configured |

## Gaps

**P0:** none.

**P1:**
- **No local pre-commit mirror.** All L1 enforcement lives in CI only — there is no
  `.githooks/pre-commit` / `core.hooksPath` / `.beads/hooks/pre-commit` running the gate
  chain before a commit. A dev can commit a lint/type/test regression locally and only
  discover it after pushing and opening a PR. The AGP-family siblings (e.g.
  `bob-the-intendant`) ship a local hook that mirrors CI; wiring one here (lint +
  `typecheck:ci` + `test` + `audit-harness verify`) would close the loop. Low effort,
  high value.

**P2 (logged only):**
- **Unit coverage is scoped to 3 files by design.** `vitest.config.ts` includes only
  `mode.ts`, `remote-server.ts`, `team-config.ts`; the local-mode core
  (`local-server.ts`, `govern.ts`, `anchor.ts`) is only reachable through the private
  sibling monorepo, so it carries no unit-coverage number and is validated by smoke
  instead. Honest given the CI constraint, but the headline coverage % does not describe
  the whole codebase. Ratchet the scope/floor up as more of the surface becomes unit-testable.
- **No RTM.md / PERSONAS.md / JOURNEYS.md traceability docs** under `tests/` — only a
  narrative `tests/TESTING.md`. Requirements↔test mapping is implicit.
- **No mutation testing and no dependency-cruiser architecture gate** — the "model
  proposes, deterministic code owns durable state" and "no direct-write bypass of the
  govern kernel" invariants (CONTRIBUTING.md) are enforced by review + tests, not a
  deterministic layering gate.
- **Full `typecheck` (all `src/**`) cannot run in generic CI** (private sibling dep) —
  only the CI-safe subset gates on PRs; the full typecheck runs locally + on the smoke
  host. Documented and intentional, noted here for completeness.

## Handoff

**P1 is worth wiring** — a local pre-commit hook mirroring the CI gate chain
(`pnpm lint` → `pnpm typecheck:ci` → `pnpm test` → `npx audit-harness verify`), activated
on a fresh clone via `git config core.hooksPath .githooks`. Everything else is P2 /
logged-only; the deterministic hard-gate chain is fully enforced in CI today.
