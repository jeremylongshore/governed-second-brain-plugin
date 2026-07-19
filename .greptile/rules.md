# bobs-big-brain-plugin ("Bob's Big Brain" plugin) — review context for Greptile

The single installable Claude Code + Cowork plugin for Bob's Big Brain. **One plugin, two
runtime modes** dispatched at startup by `TEAMKB_API_URL`:

- **local** (default, no `TEAMKB_API_URL`): the in-process governed brain over `~/.teamkb` — full
  `brain_*` surface (read: `brain_search` / `brain_status` / `brain_audit_verify`; write:
  `brain_capture` / `brain_govern` / `brain_transition`). Daemon-free, zero network.
- **team** (`TEAMKB_API_URL` set): a dependency-free remote proxy to the team's ONE shared brain over
  the tailnet, with a per-user token.

The old standalone `intent-brain` plugin is **retired** — folded into this plugin's team mode; don't
resurrect a second one.

## The invariants you must protect

1. **Dispatch predicate (`src/mode.ts`).** team iff `TEAMKB_API_URL` is *genuinely* set; unset /
   empty / whitespace / an unexpanded `${...}` placeholder -> local. The `${...}` guard is the subtle
   one — without it a misconfigured host silently runs the WRONG brain.
2. **Team mode is dependency-free (`src/remote-server.ts`).** Import only `node:crypto`, `fetch`,
   `zod`, and the MCP SDK — never `@qmd-team-intent-kb/*` or anything pulling `better-sqlite3`. And
   errors must SURFACE (`ok:false` + message), never a silent `count:0`.
3. **Writers fail closed under the write lock.** Local writers take `~/.teamkb/.write.lock` via
   flock(2), interoperating with the nightly compile cron's `/usr/bin/flock` on the same file; a
   writer that can't acquire the lock does not proceed.
4. **`plugin-runtime/governed-brain.cjs` is GENERATED.** `build.mjs` bundles `src/` into it — never
   hand-edit; rebuild + commit it with any `src/` change (and keep `gsb.lock.json` versions in sync,
   enforced by `smoke/check-lock.mjs`).
5. **Govern is deterministic; `candidates` is insert-only.** The model proposes (capture);
   deterministic govern disposes. Retirement is marker-based, never a destructive delete.

## Prioritize (in order)

- **Mode-dispatch correctness + team-mode isolation** — the two highest-risk seams.
- **Error surfacing** — no swallowed failures presented as empty success.
- **Lock safety** — writers fail closed; lock path interoperates with the cron.
- **Bundle discipline** — src change -> rebuilt .cjs; version tuple consistent.
- **Audit + secret honesty** — see below.

## Deprioritize

- Style-only / naming nits — eslint + prettier + typecheck cover these.
- Churn on the generated bundle (`plugin-runtime/*.cjs`) and `dist/` / `coverage/`.

## Honesty invariant (brand-load-bearing)

The chain is **tamper-evident**, not tamper-proof. **Forbidden as product claims:** tamper-proof,
immutable, non-repudiation (local mode), blockchain. `brain_audit_verify` reports an honest 3-state
banner — ok:true with N benign CHAIN_FORK forks is NOT tamper; ok:false IS. Never re-hash the chain
(ratified D5) and never resurrect the old false 'TAMPER DETECTED' klaxon.

## Related repos (multi-repo context)

This plugin bundles the Bob's Big Brain Registrar (`bobs-big-brain-registrar`) govern engine and points
at the Bob's Big Brain Compiler (`bobs-big-brain-compiler`) compile engine; all sit under the
`intent-solutions-io/bobs-big-brain-umbrella` umbrella. Greptile's config schema has no multi-repo key, so these are noted here for reviewer
context. Full topology + the code-verified system map: umbrella `000-docs/005-AT-ARCH` + `007-AT-SMAP`.
