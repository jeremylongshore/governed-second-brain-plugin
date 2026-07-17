# REVIEW.md

Repository-specific guidance for the automated pull-request reviewer.

Catch defects, unsafe claims, and boundary drift that CI cannot judge. Report only findings
introduced by the pull request and verify each against surrounding source.

## Review objective

This repo is the **public, installable Bob's Big Brain plugin** (npm `governed-second-brain`) — one
TypeScript stdio MCP runtime that bundles the compile/govern/retrieve engines and dispatches into two
runtime modes via `resolveMode(TEAMKB_API_URL)` (`src/mode.ts`):

- **local** (default, `TEAMKB_API_URL` unset) — in-process against the user's OWN `~/.teamkb`, a
  single-admin trust domain, full `brain_*` surface (`src/local-server.ts`).
- **team** (`TEAMKB_API_URL` set + per-user bearer token) — remote proxy over the tailnet to the ONE
  shared brain, role-gated (`src/remote-server.ts`).

Review for **four boundaries in priority order**: secret/credential safety (this is a public repo),
mode-boundary integrity, the rebundle contract, and audit-claim honesty — plus the govern invariant
and ordinary correctness. This repo is the *installable code*; the landing/thesis lives in the company
umbrella. It is not an app backend, a telemetry store, or the engines themselves.

## Authority and truth hierarchy

Read `CLAUDE.md` and `AGENTS.md` (the single source of truth for what this is, the dual-mode dispatch,
`govern.ts` / `seed-policy.ts`, the team-mode server contract, and the build). For estate-level
context, the umbrella repo (`intent-solutions-io/bobs-big-brain-umbrella`) carries the system map,
backup scope, and the *compile, then govern* thesis.

1. Explicit owner decisions govern intended architecture (e.g. one plugin / two modes; team mode is
   dependency-free; the old standalone `intent-brain` plugin is retired — do not resurrect a second one).
2. Running reality and executable repository state decide implementation status.
3. Current source, `AGENTS.md`, and CI guards outrank summaries, PR descriptions, chat assertions, and
   historical notes.
4. Historical records describe what was known then. Require a dated correction or successor instead of
   rewriting them to fit today's narrative.
5. Green CI and a passing local smoke prove only the checks that ran — not team-mode remote integration,
   remote durability, or production readiness.

Flag silent boundary changes, second sources of truth, or proposals presented as authority.

## Disclosure and secret safety — this is a PUBLIC repo (highest-risk boundary)

Treat secret/credential leakage as this repository's highest-risk boundary. Every commit is public.

- Never permit a hardcoded `TEAMKB_API_URL`, bearer token, per-user token, API key, tailnet host or IP,
  or any plaintext secret in Git. All of these must come only from the environment at runtime.
- Flag any change that could **log, echo, print, or otherwise leak** the token or the API URL (error
  messages, debug prints, exception dumps, telemetry).
- Flag any internal identifier, private hostname, or team-only detail that should not appear in a
  public artifact (README, tool descriptions, fixtures, tests).

Never reproduce a suspected secret in a review comment; identify only its location and the required
remediation (move to env, remove from history, rotate).

## Mode-boundary integrity

Local and team are two different trust domains sharing one codebase. Guard the seam.

- **Local mode is the default and must stay the default.** An unset (or unexpanded `${...}`)
  `TEAMKB_API_URL` must fall to local — never error, never silently open a network connection.
- **Team mode is role-gated over the network.** Flag any change that exposes a write or admin tool in
  team mode without its role gate (member vs admin), or that weakens an existing gate.
- **`src/remote-server.ts` is dependency-free by contract** — it copies tool enums/Zod schemas by hand
  rather than importing `@qmd-team-intent-kb/*` or anything pulling `better-sqlite3`, so the team bundle
  runs from a marketplace clone with zero build. Flag a new import that violates this. Flag **drift**
  between the two servers' tool surfaces or enums (a tool/enum changed in one server but not mirrored).
- Do not blur local-vs-team dispatch (`src/index.ts` / `src/mode.ts`): the mode is decided once, and
  exactly one server is loaded.

## The rebundle contract

The engines are vendored into `plugin-runtime/governed-brain.cjs` by `npm run build` (esbuild inlines
the compiled sibling packages). A file-copy `/plugin install` runs that committed bundle without a build.

- Flag a **hand-edit** of the generated `plugin-runtime/governed-brain.cjs`.
- Flag a `src/` change whose **bundle was not regenerated** (the committed bundle must match the source
  it claims to carry).
- Flag the bundle **drifting** from the engine source it vendors (a stale `dist` inlined, a source
  change absent from the bundle).

The bundle is excluded from the reviewer's diff scope; judge it indirectly — a `src/` change with no
corresponding bundle update is the tell.

## The govern invariant

The model proposes; the deterministic system owns durable state. Write tools go through
**capture → govern** (deterministic: dedupe → policy → secret-detection → promotion). Flag any tool
or code path that mutates durable governed state directly, bypassing that path.

## Audit-claim honesty

Tool descriptions and the README are **brand surfaces** and are CI-adjacent to the umbrella's honesty
discipline. The audit chain is tamper-**evident** (detection of edits/reordering), **not**
tamper-proof: a local writer with write access can edit an event and re-hash the chain forward. Local
mode is **integrity + ordering + rewrite-detection** only.

**Forbidden claim words — flag any introduced:** tamper-proof, immutable, non-repudiation (for local
mode), blockchain. Also flag a bare "append-only" that is not qualified, and any over-claim in tool
descriptions, README, or user-facing strings.

## Status and evidence integrity (claims lane)

Judge completion and readiness against executable state, not assertion.

- Documentation, merged code, and green CI are not deployment or live integration.
- A passing **local** `smoke.mjs` is not proof the **team-mode** remote path (`src/remote-server.ts`
  over the tailnet) works; local embedded proof is not remote durability.
- A rebuilt bundle claimed but not evidenced is not a verified bundle.
- Flag unsupported terms such as "verified", "production-ready", or "complete"; version drift across
  `package.json` / README / CHANGELOG / plugin manifest; a diff doing materially more or less than the
  description; a new second source of truth; and any privacy/secret over-share in a public-repo PR.

## Verification expectations

New behavior needs a test of the observable result (the vitest suite covers `src/mode.ts`,
`src/remote-server.ts`, write-lock, team-config). A team-mode change should be exercised by
`smoke-team.mjs` (dispatch → proxy → bearer → tenant → Author-object → admin 403); a local change by
`smoke.mjs` (capture → govern → search, incl. the seeded-policy rejection). Do not repeat CI output
inline; review why green checks might still mask a leaked secret, a mode-boundary break, a stale
bundle, or a false claim.

## Severity calibration

- **Critical:** a secret/token/API-URL/tailnet host committed or leakable to a public artifact; a
  team-mode write/admin tool exposed without its role gate; local mode broken so it errors or hits the
  network by default; durable state mutated outside capture → govern; a hand-edited or drifted runtime
  bundle shipped as authoritative; or a false production/complete claim that could mislead an installer.
- **Warning:** enum/schema drift between the two servers; a new import in `remote-server.ts`; a
  `src/` change with no regenerated bundle; a forbidden honesty word or unqualified "append-only"; an
  untested boundary path; misleading status; version drift.
- **Info:** a concrete maintainability or documentation improvement with real future cost. Use
  sparingly, never for personal preference.

Do not flag formatting-only differences or failures already enforced and reported by tooling
(typecheck, eslint, vitest, smoke, gitleaks). Severity follows credible impact, not file importance.

## Comments and summary

Comment on an exact changed line only when actionable. Inspect enough context to prove the issue; do
not post speculative or duplicate findings. Explain the impact and the smallest safe correction. Never
reproduce a suspected secret. If no actionable finding remains, respond with `lgtm` and nothing else.

The reviewer is **advisory only** — it never blocks a merge. The deterministic gate is always the
blocking `ci.yml` / `smoke.yml` jobs plus gitleaks.
