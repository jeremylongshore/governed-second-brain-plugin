# Onboarding — plug a teammate into Bob's Big Brain

The brain is a **plugin**, so it runs inside a **desktop** Claude — never a website.

| Where you run Claude | Works? | How |
|---|---|---|
| **Claude Code** or **Cowork** | ✅ recommended | Same install path on every OS: paste one prompt to Claude (below). |
| **Claude Desktop** (standalone chat app) | ⚙️ manual | Add a custom `mcpServers` entry by hand (below). |
| **claude.ai in a browser**, phone apps | ⛔ no | A browser tab can't reach a local plugin or a private network. Install Claude Code and use that. |

Every teammate needs two things: a **desktop Claude** (Claude Code is quickest) and **Tailscale**
(so their machine can reach the brain over the private network — the one genuinely-manual
prerequisite; the GUI *Allow* dialogs can't be automated).

**Full walkthrough (live):** https://demos.intentsolutions.io/bbb/

That page covers: Tailscale → desktop Claude → install + `team.json` → proof `/brain` query → **optional Step 5** (teach Claude when to search the brain via a short standing order in `~/.claude/CLAUDE.md` / `AGENTS.md`). Installing the plugin connects the brain; it does **not** by itself make the agent look there first.

## Claude Code or Cowork (recommended) — one path for every OS

There is **no separate Windows or Mac installer.** Plugin install and writing `team.json` both work
the same way everywhere: paste a short prompt to Claude and let it run the steps.

### Paste this to Claude

Replace `PASTE-YOUR-TOKEN-HERE` with the per-user token (or let Claude ask for it):

```
Install and connect me to Bob's Big Brain (the team brain). Run these steps in order. Stop and tell me if any step errors.

1) Add and install the plugin from the public marketplace (no GitHub login needed):
   claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   claude plugin marketplace update governed-second-brain
   claude plugin install governed-second-brain@governed-second-brain

2) Write my team connection file at ~/.teamkb/team.json (Windows: %USERPROFILE%\.teamkb\team.json) with restrictive permissions (mode 600). Use exactly this JSON, and replace PASTE-YOUR-TOKEN-HERE with the token I give you — or ask me for the token if I have not pasted it yet. Do NOT invent or change a token. Keep tenantId exactly as written; without it, searches return empty results even with a good token:

{
  "apiUrl": "http://100.109.119.103:3847",
  "apiToken": "PASTE-YOUR-TOKEN-HERE",
  "tenantId": "intent-solutions"
}

3) Tell me to fully quit and reopen Claude Code or Cowork. After I restart I will run: /brain shipped this week and I should get an answer with qmd:// citations.

Do not rewrite the plugin manifest. Do not hunt for a newer CLI. Use only the public marketplace above.
```

### Or by hand (three short parts)

1. **Add the plugin** — in Claude Code or Cowork. Public repo, so no org membership or `gh` login:
   ```
   /plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   /plugin install governed-second-brain@governed-second-brain
   ```
2. **Write `team.json`** — `~/.teamkb/team.json` (Windows: `%USERPROFILE%\.teamkb\team.json`) at
   mode `600`, using the shape below. **`tenantId` is required** — without it you get empty
   results even with a good token.
3. **Restart the app**, then ask with **keywords**: `/brain shipped this week` → a cited `qmd://`
   answer means you're connected. (Retrieval is keyword-based — strong words beat a full sentence;
   0 hits usually means the query, not the setup — try a topic like `backup` or `deploy`.)

> **Legacy note:** [`install-bobs-big-brain.command`](install-bobs-big-brain.command) is a macOS
> double-click script kept in-tree for operators who still want it. The page and the recommended
> path no longer lead with OS installers.

## Claude Desktop (advanced — manual MCP config)

Claude Desktop can run the brain but doesn't use the `/plugin` system — register it as a custom MCP
server. Put the plugin's `governed-brain.cjs` on disk (from your Claude Code plugin install, or
`npm install -g governed-second-brain`), then add to the Desktop config file — `%APPDATA%\Claude\claude_desktop_config.json`
on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "governed-brain": {
      "command": "node",
      "args": ["/full/path/to/plugin-runtime/governed-brain.cjs"],
      "env": {
        "TEAMKB_API_URL": "http://<brain-host>:3847",
        "TEAMKB_API_TOKEN": "<your per-user token>",
        "TEAMKB_TENANT_ID": "<your tenant>"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop; `brain_search` will be available.

## How the connection actually works

The plugin (`src/index.ts`) resolves its mode at startup with this precedence,
**per key**:

```
real environment variable  →  ~/.teamkb/team.json  →  (absent → local mode)
```

`team.json` is the fix for the day-one failure where a teammate set
`TEAMKB_API_URL` in `~/.zshrc`, but a **GUI/Dock-launched Claude never sources
`~/.zshrc`**, so the vars were absent and the plugin silently ran an empty *local*
brain. A file on disk doesn't depend on the launching shell, so it works from a
double-click or a Claude-written file the same way.

`team.json` shape (mode `600`):

```json
{
  "apiUrl": "http://100.109.119.103:3847",
  "apiToken": "<the teammate's per-user bearer token>",
  "tenantId": "intent-solutions"
}
```

**Fail-closed, by design:** a `team.json` that is present but group/world-readable,
unreadable, or not valid JSON makes the plugin **refuse to start** with a clear
message — it does *not* silently fall back to the local brain. A teammate who has a
`team.json` wants team mode; a broken one is an error worth surfacing, not laundering.

## For the admin (Jeremy)

- **Auth-free install.** The path adds **this public repo as its own marketplace**
  (`claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin` →
  `claude plugin install governed-second-brain@governed-second-brain`), so a teammate needs **no**
  `intent-solutions-io` org membership, no private-repo access, and no `gh` login.
- **Merge-gated.** The marketplace source tracks this repo's `main` branch unpinned, so
  `claude plugin install` pulls the `main` bundle — only tell teammates to install after the
  behaviour they need is merged to `main`.
- Mint the per-user token, then hand the teammate **the token + the paste prompt** (or the live
  page) over a trusted channel. Prefer leaving the token out of any script file entirely.
- The token **never** lands in `~/.claude.json`, shell history, argv, or a chat
  transcript — only in `~/.teamkb/team.json` at mode `600`.
- Live page source of truth for the dogfood run: `~/demos/bbb/index.html` →
  https://demos.intentsolutions.io/bbb/
