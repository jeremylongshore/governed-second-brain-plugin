# CLAUDE.md

Guidance for Claude Code working in this repository.

## What This Is

The **public Governed Second Brain plugin** — a local-first, in-process Claude Code + Cowork plugin.
This is the *installable code*; the *landing/thesis* lives in the company umbrella repo.

| | Repo | Role |
|---|---|---|
| **This repo** | `jeremylongshore/governed-second-brain-plugin` (personal) | the plugin: MCP runtime + skills |
| **Umbrella** | `intent-solutions-io/governed-second-brain` (company) | landing page, thesis, competitive teardown — points here |
| **Engines** | `jeremylongshore/{intentional-cognition-os, qmd-team-intent-kb}` | ICO (compile) + INTKB (govern) — separate repos, untouched |

**Do NOT touch the internal plugin.** A *different*, internal `intent-brain` plugin lives inside
`qmd-team-intent-kb/.claude-plugin/` (team mode, remote proxy over the tailnet, published to the private
`intent-solutions-io/claude-plugins` catalog). It is unrelated to this public plugin and stays as-is.
Both happen to define skills named `brain`/`brain-save`, but they wire to different MCP servers
(`teamkb` vs `governed-brain`); never merge or cross-edit them.

## Architecture (the part that matters)

A self-contained stdio MCP server (`src/local-server.ts`) drives qmd + the deterministic govern kernel
+ the local `~/.teamkb` store **directly, in-process** — no daemon, no HTTP, no network, no API key.

- **Tool surface** (matches the two skills' `allowed-tools` exactly — no dead tools): `brain_search`,
  `brain_status` (read); `brain_capture`, `brain_govern`, `brain_transition` (write).
- **`brain_govern`** (`src/govern.ts`) is the daemon-free drive: ingest spool → `Curator.processBatch`
  (dedupe → policy → promote) → `runExport` (markdown, no git) → qmd index refresh. Promotion writes the
  SHA-256 hash-chained audit event. The staleness sweep is intentionally off.
- **Separation = an egress feature.** ICO (compile) is the only part that egresses; INTKB (govern) +
  qmd (retrieve) are fully local. `brain_capture`+`brain_govern` run the whole loop with **zero ICO,
  zero egress** — that's the basis of the planned `--index-only` no-egress mode.

## Building

The MCP runtime is **bundled from the sibling `../qmd-team-intent-kb` workspace** — esbuild **inlines**
its compiled packages into the `.cjs`, so the private INTKB monorepo is never published (bundle, don't
publish). The link paths in `package.json` assume `../qmd-team-intent-kb` is a sibling checkout.

```bash
pnpm -C ../qmd-team-intent-kb build   # refresh INTKB dist/ FIRST — the bundle inlines compiled JS; stale dist = stale bundle
pnpm install                          # links the 8 INTKB packages + installs zod/sdk/better-sqlite3
pnpm build                            # node build.mjs → plugin-runtime/governed-brain.cjs
node smoke.mjs                        # capture→govern→search over the MCP protocol, isolated ~/.gsb-smoke base
```

Hard facts the build depends on:
- **Single native dep**: `better-sqlite3` is `--external` (a compiled `.node` can't be bundled) + needs
  its `bindings` dep; ship a complete `plugin-runtime/node_modules/better-sqlite3` install tree (the
  installer provisions it per-platform — NOT committed). `ajv`/`ajv-formats` stay **bundled** (the MCP
  SDK validates every tool call with ajv — externalizing them makes the runtime inert).
- **Single zod**: `build.mjs` aliases `zod` to one copy so the SDK and our tool schemas share an instance
  (cross-instance `instanceof` otherwise breaks tool registration).
- **qmd 2.x on PATH** for retrieval (`brain_search` runs `qmd search`, BM25); govern degrades gracefully
  if qmd is absent (capture/promote/audit still complete — only the index refresh waits).
- **Single-user neutralizers**: `.mcp.json` pins `TEAMKB_TENANT_ID=local`; the server hard-defaults the
  owner role (local mode is a single trust domain) and omits `TEAMKB_API_URL` (in-process, no network).

## Audit-claim honesty

The chain is tamper-**evident** (detection of edits/reordering), **not** tamper-proof: a local writer can
edit an event *and* re-hash forward. Keep the "What the receipt does *not* do" framing honest.
**Forbidden words:** tamper-proof, immutable, non-repudiation (for local mode), blockchain.

## Retrieval roadmap (2026-06-18 council decision)

`brain_search` uses **BM25** (`qmd search`) today — zero ML, cited hits. Semantic recall is
**roadmapped, not shipped**: a *lean* native sqlite-vec backend on EmbeddingGemma-300M only
(~320 MB), eval-gated, dropping qmd's 1.7 B query-expander + 0.6 B reranker. We **skip** qmd's
2.2 GB hybrid (heavier *and* unwired) and **reject** the stale NEXUS RAG stack. Before any
semantic path ships, the qmd binary + GGUF weights get **SHA-256-pinned (fail closed)** —
`gsb.lock.json` already pins versions; weight-hash pinning extends that discipline.

Canonical record: `qmd-team-intent-kb/000-docs/038-AT-DECR`; epic `qmd-team-intent-kb-0t9`
(GH `jeremylongshore/qmd-team-intent-kb#170` / Plane INTKB-7). The plugin's semantic-recall
bead `compile-then-govern-qy7.13` lands via `0t9.3`.

## Tracking

Program-level beads + the GitHub tracking issue live on the **umbrella** repo
(`intent-solutions-io/governed-second-brain` — epic `compile-then-govern-qy7`, issue #1), not here.
This repo is code; file code-anchored issues here and cross-reference the epic.
