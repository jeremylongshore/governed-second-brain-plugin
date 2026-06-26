# CLAUDE.md

**Agent + developer guidance for this repo lives in [`AGENTS.md`](AGENTS.md)** — the single source of
truth (what it is, the local|team dual-mode dispatch, `govern.ts` / `seed-policy.ts`, the team-mode
server contract, build + smokes, the tenant-default gotcha, retrieval roadmap, tracking). Read it first.

Two rules load-bearing enough to repeat here:

1. **Team mode (`src/remote-server.ts`) is dependency-free.** Import only `node:crypto`, `fetch`,
   `zod`, and the MCP SDK — **never** `@qmd-team-intent-kb/*` or anything pulling `better-sqlite3`. The
   team bundle must run from a marketplace clone with zero build. (AGENTS.md § Architecture.)
2. **Audit honesty.** The chain is tamper-**evident**, not tamper-proof. **Forbidden words:**
   tamper-proof, immutable, non-repudiation (local mode), blockchain.

One plugin, two modes (local default / team when `TEAMKB_API_URL` is set). The old standalone
`intent-brain` plugin is **retired** — folded into this plugin's team mode; don't resurrect a second
one. Rebuild + commit `plugin-runtime/governed-brain.cjs` with any `src/` change.
