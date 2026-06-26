# AGENTS.md

Agent + developer guidance for the **Governed Second Brain plugin** repo. Tool-agnostic; `CLAUDE.md` points here.

## What this is

The **unified, public Governed Second Brain plugin** — a Claude Code + Cowork plugin that runs as a
single stdio MCP server in **two modes**:

- **local** (default): an in-process governed brain over your own files (`~/.teamkb`) — no daemon, no
  network, no API key.
- **team** (when `TEAMKB_API_URL` is set): a remote proxy to a shared governed-brain HTTP API over your
  network.

This is the *installable code*; the *landing/thesis* lives in the company umbrella repo.

| | Repo | Role |
|---|---|---|
| **This repo** | `jeremylongshore/governed-second-brain-plugin` (personal, public) | the plugin: MCP runtime (local + team) + skills |
| **Umbrella** | `intent-solutions-io/governed-second-brain` (company) | landing page, thesis, competitive teardown — points here |
| **Engines** | `jeremylongshore/{intentional-cognition-os, qmd-team-intent-kb}` | ICO (compile) + INTKB (govern) — separate repos |
| **Team marketplace** | `intent-solutions-io/team-intent-claude-plugins` (private) | publishes **this** plugin (team mode) for the internal team |

**The old standalone `intent-brain` plugin is RETIRED.** It used to live in
`qmd-team-intent-kb/.claude-plugin/` as a separate team-only plugin; it has been folded into **this**
plugin's team mode and removed from the team marketplace (bead `compile-then-govern-650.4`). There is
now ONE plugin for both local and team — do not resurrect a second one.

## Architecture — the dual-mode dispatch (the part that matters)

`src/index.ts` is the dispatcher: it reads `TEAMKB_API_URL` and `await import()`s exactly one server
(an unexpanded `${...}` placeholder counts as unset → local):

- **`src/local-server.ts`** — LOCAL mode. Drives qmd + the deterministic govern kernel + `~/.teamkb`
  **directly, in-process** (imports `@qmd-team-intent-kb/*` + `better-sqlite3`). Full tool surface (6):
  `brain_search` / `brain_status` / `brain_audit_verify` (read) + `brain_capture` / `brain_govern` /
  `brain_transition` (write).
- **`src/remote-server.ts`** — TEAM mode. Proxies to the INTKB HTTP API (`apps/api`) over the network
  with a per-user bearer token. Tool surface (3): `brain_search` (read), `brain_capture`
  (propose → `POST /api/candidates`), `brain_transition` (admin → `POST /api/memories/:id/transition`).
  **No `brain_govern`** (govern runs server-side); `brain_status` / `brain_audit_verify` are local-only.

### ⚠️ CRITICAL constraint — team mode is dependency-free

`src/remote-server.ts` may import **only** `node:crypto`, `fetch` (global), `zod`, and the MCP SDK —
**never** `@qmd-team-intent-kb/*` or anything pulling `better-sqlite3`. The team bundle must run from a
marketplace clone with **zero install/build** and never touch the native module. (Local-mode's native
imports are dynamically `import()`ed only on the local path, so they don't load in team mode.) If you
add a team tool, **mirror the local tool's Zod schema 1:1 but build the request by hand** — do not
import schema/store packages. `smoke-team.mjs` asserts the team bundle has no `@qmd-team-intent-kb/*`
behavior at runtime; a stray native import will break a marketplace install.

### Key files
- `src/index.ts` — mode dispatcher.
- `src/local-server.ts` — local 6-tool server; `brain_govern` → `src/govern.ts`.
- `src/govern.ts` — the daemon-free govern drive: seed local policy → ingest spool →
  `Curator.processBatch` (dedupe → policy → promote) → `runExport` → qmd index refresh → SHA-256
  hash-chained audit + git-committed external anchor.
- `src/seed-policy.ts` — seeds a minimal local default `GovernancePolicy` once per tenant (idempotent)
  so local govern produces **receipted** rejections (`secret_detection` + `content_length` min=25)
  instead of silent auto-approve. Wrapped in try/catch in `runGovern` (best-effort; never crash govern).
  Note: the `content_length` rule reads `parameters['min']`, **not** `minLength`.
- `src/remote-server.ts` — team server (dependency-free); proxies search/capture/transition. Tenant
  from `TEAMKB_TENANT_ID` (default `intent-solutions`). `errorResult()` maps 401/403/422 to clear
  member/admin messages.
- `src/config.ts` — local config; `tenantId` defaults to `local`.
- `plugin-runtime/governed-brain.cjs` — the built bundle (esbuild). **Committed** (a file-copy
  `/plugin install` runs it without a build). Rebuild + commit it with any `src/` change.

### Team-mode server contract (INTKB `apps/api`)
- `POST /api/candidates` — member-allowed; body = a full `MemoryCandidate` built client-side (the
  server `safeParse`s with no defaults — provide every field, like `local-server.ts` does).
- `POST /api/memories/:id/transition` — admin; body `{ to, reason, actor: <Author OBJECT>, supersededBy? }`
  (an Author **object** `{type:'human',id}`, **not** local mode's `actor` string).
- `POST /api/search` — read. Bearer token in `Authorization`. Writes must send `tenantId` explicitly
  (the current tokens are unrestricted).
- Promotion (`POST /api/candidates/:id/promote`) is admin and server-side — not exposed as a plugin tool.

## Building

The local MCP runtime is **bundled from the sibling `../qmd-team-intent-kb` workspace** — esbuild
**inlines** its compiled packages into the `.cjs` (bundle, don't publish). `package.json` link paths
assume `../qmd-team-intent-kb` is a sibling checkout.

```bash
pnpm -C ../qmd-team-intent-kb build   # refresh INTKB dist/ FIRST — the bundle inlines compiled JS; stale dist = stale bundle
pnpm install                          # links the INTKB packages + zod/sdk/better-sqlite3
pnpm typecheck                        # tsc --noEmit
node build.mjs                        # → plugin-runtime/governed-brain.cjs (commit it)
node smoke.mjs                        # LOCAL: capture→govern→search over MCP (isolated ~/.gsb-smoke); also asserts the seeded policy rejects a too-short capture
node smoke-team.mjs                   # TEAM: dispatch→proxy against a stub API; asserts the surface, bearer, tenant, the Author-object, and the admin 403
```

Build hard-facts:
- **Single native dep**: `better-sqlite3` is `--external` + needs `bindings`; the installer provisions
  `plugin-runtime/node_modules/better-sqlite3` per-platform (NOT committed). `ajv`/`ajv-formats` stay
  **bundled** (the SDK validates every tool call with ajv — externalizing them makes the runtime inert).
- **Single zod**: `build.mjs` aliases `zod` to one copy (cross-instance `instanceof` otherwise breaks
  tool registration).
- **qmd 2.x on PATH** for local retrieval; govern degrades gracefully if absent.
- **Tenant defaults**: do **not** hardcode `TEAMKB_TENANT_ID` in `plugin.json` / `.mcp.json` (a hardcoded
  `local` silently misroutes team writes into a tenant the team brain never reads). Local → `local`
  (config.ts); team → `intent-solutions` (remote-server.ts); a user env override applies in either mode.

## Audit-claim honesty
The chain is tamper-**evident** (detection of edits/reordering), **not** tamper-proof: a local writer
can edit an event *and* re-hash forward. Keep the "What the receipt does *not* do" framing honest.
**Forbidden words:** tamper-proof, immutable, non-repudiation (for local mode), blockchain.

## Retrieval roadmap
`brain_search` uses **BM25** (`qmd search`) today — zero ML, cited hits. A *lean* native sqlite-vec
semantic backend (EmbeddingGemma-300M, eval-gated, SHA-256-pinned weights) is **roadmapped, not
shipped**; qmd's 2.2 GB hybrid is skipped (heavier *and* unwired). Canonical record:
`qmd-team-intent-kb/000-docs/038-AT-DECR`; epic `qmd-team-intent-kb-0t9`.

## Tracking
Program-level beads + the GitHub tracking issue live on the **umbrella** repo
(`intent-solutions-io/governed-second-brain` — epic `compile-then-govern-qy7`, issue #1), not here.
This repo is code; file code-anchored issues here and cross-reference the epic.
