# Changelog

All notable changes to the **Governed Second Brain** plugin are documented here. This is the
installable Claude Code + Cowork plugin (a local stdio MCP server); the engines it bundles
(`ico` / `qmd` / govern kernel) carry their own changelogs in their repos. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **SessionEnd multi-learning slots + hook wiring.** `deriveCandidateId` now takes
  `learningIndex` (0..4): key = `(tenant, sessionId, session-end, index)` so up to 5 learnings
  per session stay distinct while re-distill of the same index collapses. Autocapture hook
  resolves `session_id` / `sessionId` / transcript-path fallback and **requires**
  `brain_capture({ sessionId, learningIndex })` in the distiller prompt. Client no longer
  invents `already_exists` from bare HTTP 200 without `intake`. Skill docs corrected (inbox
  does dedupe at intake).
- **Session-stable capture idempotency + frozen outbox contract (Property 1/2 seam).**
  `deriveCandidateId` uses session keys when `sessionId` is provided; without `sessionId` keeps
  content-hash UUIDv5 for manual `/brain-save`. Outbox freezes final POST body; drain replays
  file bytes only. Surfaces `intake` / `alreadyExists` from the server.

### Fixed

- **`/brain` now retries with keywords when a full-sentence question returns nothing.** Retrieval is
  keyword-AND, so a natural question ("what did the team ship this week?") could return zero even when
  the topic is well covered — a new user running the suggested proof query saw an empty result and
  assumed the setup was broken. The `/brain` skill now drops filler/question words and retries once
  with the strong keywords before reporting empty, and the onboarding proof query is now a keyword
  query (`shipped this week`) in the README and the macOS installer. (The deeper retrieval-side
  OR-fallback is tracked separately.)

### Added

- **Per-platform install instructions.** The README and `onboarding/README.md` now spell out that the
  plugin runs in **Claude Code or Cowork** (same `/plugin` install), takes a **manual `mcpServers`
  config on Claude Desktop**, and **cannot** run in claude.ai in a browser or the phone apps — plus a
  **Windows** path (`/plugin` commands + `%USERPROFILE%\.teamkb\team.json`) alongside the macOS
  one-click installer.

## [1.1.1] - 2026-07-13

### Fixed

- **Team-mode search returned zero results for every teammate.** `brain_search` never sent the tenant
  to `/api/search`, but the API scopes qmd by `tenantId` — so a fully-connected teammate got empty
  results (auth worked, queries came back blank). Now sends `tenantId: TENANT_ID` (defaults to the
  shared `intent-solutions`); the server-side tenancy guard still validates a scoped token.
- **Root `.mcp.json` would not launch in project scope.** It used the marketplace-only
  `${CLAUDE_PLUGIN_ROOT}` (unresolved when the repo is opened as a project). Switched to a repo-relative
  runtime path and added a `TEAMKB_TENANT_ID` passthrough (also added to `.claude-plugin/plugin.json`).

### Changed

- **Public name is now "Bob's Big Brain"** across the README, skills, installer, code headers, and the
  marketplace/plugin descriptions. Technical ids (repo, package `name`, plugin id) are unchanged.

### Added (internal)

- Standalone anchor-verifier re-hash-forward test + a store↔standalone anchor **conformance** gate
  (a new required CI job that provisions the sibling store).

## [1.1.0] - 2026-07-11

### Added

- **`~/.teamkb/team.json` config-file fallback for team mode.** `src/index.ts` now fills any absent
  `TEAMKB_API_URL` / `TEAMKB_API_TOKEN` / `TEAMKB_TENANT_ID` from a `team.json` on disk **before**
  mode dispatch, so a GUI/Dock-launched Claude (which never sources `~/.zshrc`) reaches team mode
  without shell env vars. Precedence: real env → `team.json` → local. New `src/team-config.ts`.
- **Fail-closed mode resolution.** A present-but-unusable `team.json` — group/world-readable,
  unreadable, invalid JSON, non-object, or missing a usable `apiUrl` (e.g. a snake_case `api_url`
  typo) — makes the plugin **refuse to start** with a clear message instead of silently running the
  empty local brain. A genuinely-empty environment still runs local (the public showcase).
- **`onboarding/install-bobs-big-brain.command`** — a readable, double-clickable macOS installer:
  checks tailnet reachability, takes the token via a hidden prompt (never argv/history), writes
  `team.json` at mode `600`, and installs the plugin from the private marketplace.
- **`smoke/mode-dispatch.test.mjs`** — drives the shipped bundle through all four dispatch /
  fail-closed paths (loose-perms → refuse; valid 0600 + no env → team; no file → local; snake_case →
  refuse). Wired into the smoke workflow.

### Security

- The team bearer token now lives only in `~/.teamkb/team.json` (mode `600`) — never in
  `~/.claude.json`, shell history, argv, or a chat transcript. The plugin refuses to load a
  group/world-readable `team.json`, and a malformed-`team.json` error is content-free so no token
  fragment can reach the MCP debug log.

### Fixed

- **`plugin-runtime/` is now self-contained.** Added `plugin-runtime/package.json` and a `build.mjs`
  postbuild step that installs the externalized native modules (`better-sqlite3`, `bindings`,
  `fs-ext`) into `plugin-runtime/node_modules`. Previously a copied / marketplace `plugin-runtime/`
  had no `better-sqlite3` and **local mode** failed with `better-sqlite3 not built for this machine`
  (`brain_status` returned `total: 0`); it only worked in-repo by resolving `require()` upward to the
  parent `node_modules`. **Team mode was unaffected** (the mode dispatcher never imports sqlite), and
  the npm-publish path was already fine (deps declared). Verified by running the runtime from an
  isolated copy with no ancestor `node_modules` → `brain_status total: 2189`. (#22, bead
  `compile-then-govern-jfv.6.18`)

## [1.0.0] - 2026-06-20

### Added

- **Team mode** — the plugin is now ONE plugin with two runtime modes, dispatched at startup by
  whether `TEAMKB_API_URL` is set:
  - **local** (default, unchanged behavior): the in-process governed brain over your own files
    (`~/.teamkb`) — full `brain_*` read+write surface, no daemon, no network, no key.
  - **team** (`TEAMKB_API_URL` set): a remote proxy to your team's single governed brain over the
    tailnet, with a per-user token. Exposes the unified `brain_search` (read); capture/govern stay
    governed server-side.
  This absorbs the former standalone `intent-brain` plugin as this plugin's team mode — one plugin,
  one tool surface (`brain_*`), the same `/brain` and `/brain-save` skills in both modes. Only your
  data + `TEAMKB_API_URL` + token are private; the plugin code is public.
- `src/index.ts` mode dispatcher; `src/remote-server.ts` (the tailnet proxy, moved in from
  `qmd-team-intent-kb` and renamed `teamkb_search` → `brain_search`); `smoke-team.mjs` (a stub-API
  team-mode smoke proving dispatch → proxy → `qmd://` citation → bearer forwarding).

### Changed

- The build now bundles the dispatcher (`src/index.ts`) instead of the local server directly; both
  modes are inlined into the single `plugin-runtime/governed-brain.cjs`, lazily — so team mode never
  loads the local store's native module (`better-sqlite3`) and runs from a marketplace clone with zero
  install/build. Manifests (`.mcp.json`, `plugin.json`, `marketplace.json`) declare the
  `TEAMKB_API_URL` / `TEAMKB_API_TOKEN` env passthrough; the dispatcher treats an empty or unexpanded
  `${TEAMKB_API_URL}` placeholder as local mode.
- Version bumped to **1.0.0** across `package.json`, `plugin.json`, `.mcp.json`, `marketplace.json`,
  and `gsb.lock`.

## [0.1.7] - 2026-06-20

### Changed

- Bundled govern engine re-pinned to **qmd-team-intent-kb v0.7.0** (`gsb.lock`, was v0.6.0) and the
  runtime rebundled against it. This is an accuracy / sync release — v0.7.0's headline work (the
  candidate-intake disclosure gate and the one-shot promote endpoint) is team/API-side and is not
  part of the local single-user plugin's surface.

### Added

- Governance scaffolding: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), and this `CHANGELOG.md`.
- `brain_audit_verify` documented in the README tool table (the server already registered it). (#4)
- Retrieval roadmap recorded in the plugin guidance — `brain_search` stays BM25 (qmd search) now;
  a lean native sqlite-vec semantic path (EmbeddingGemma-300M) is eval-gated. (#1)

### Fixed

- README footer link uses the canonical trailing-slash root (`intentsolutions.io/`). (#2)
- README "Coming" no longer lists already-shipped npm provenance + the `gsb.lock` pin. (#4)

## [0.1.6]

### Added

- MCP server declared **inline in `plugin.json`** (`mcpServers`) so the marketplace sync — which
  drops a root `.mcp.json` — still registers the local server.

## [0.1.5]

### Changed

- DB-backed tools **fail actionably** on a non-installer install (detect a missing native dependency
  and emit an install hint) instead of throwing an opaque error.

## [0.1.4]

### Added

- `gsb.lock.json` reproducible pin (exact ICO × INTKB × qmd × plugin tuple) with a hermetic
  full-chain CI smoke against the pinned set.
- External **audit-chain anchor** — govern commits the chain head; `brain_audit_verify` checks it.
- npm **provenance** via the CI release workflow + a qmd version check.

### Changed

- All version strings aligned to a single source (the `validate-plugin` marketplace-tier gate).

— Jeremy Longshore · [intentsolutions.io](https://intentsolutions.io)
