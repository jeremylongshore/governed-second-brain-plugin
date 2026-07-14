# Onboarding — plug a teammate into Bob's Big Brain

The brain is a **plugin**, so it runs inside a **desktop** Claude — never a website.

| Where you run Claude | Works? | How |
|---|---|---|
| **Claude Code** or **Cowork** | ✅ recommended | The same `/plugin` install (below). macOS + Claude Code also has a one-click installer. |
| **Claude Desktop** (standalone chat app) | ⚙️ manual | Add a custom `mcpServers` entry by hand (below). |
| **claude.ai in a browser**, phone apps | ⛔ no | A browser tab can't reach a local plugin or a private network. Install Claude Code and use that. |

Every teammate needs two things: a **desktop Claude** (Claude Code is quickest) and **Tailscale**
(so their machine can reach the brain over the private network — the one genuinely-manual
prerequisite; the GUI *Allow* dialogs can't be automated).

## Claude Code or Cowork (recommended)

### macOS — one click (Claude Code)

**Double-click [`install-bobs-big-brain.command`](install-bobs-big-brain.command).** It checks
tailnet reachability, takes the token (typed hidden), writes `~/.teamkb/team.json` at mode `600`,
and installs the plugin. It prints one green line and a `/brain` question to try. (On Cowork, or to
do it by hand, use the manual steps below.)

### Windows, or by hand (Claude Code or Cowork)

1. **Add the plugin** — in Claude Code or Cowork. Public repo, so no org membership or `gh` login:
   ```
   /plugin marketplace add jeremylongshore/governed-second-brain-plugin
   /plugin install governed-second-brain@governed-second-brain
   ```
2. **Write `team.json`** — `~/.teamkb/team.json` (Windows: `%USERPROFILE%\.teamkb\team.json`) at
   mode `600`, using the shape below.
3. **Restart the app**, then ask with **keywords**: `/brain shipped this week` → a cited `qmd://`
   answer means you're connected. (Retrieval is keyword-based — strong words beat a full sentence;
   0 hits usually means the query, not the setup — try a topic like `backup` or `deploy`.)

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
double-click.

`team.json` shape (the installer writes exactly this, mode `600`):

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

- **Auth-free install.** The installer adds **this public repo as its own marketplace**
  (`claude plugin marketplace add jeremylongshore/governed-second-brain-plugin` →
  `claude plugin install governed-second-brain@governed-second-brain`), so a teammate needs **no**
  `intent-solutions-io` org membership, no private-repo access, and no `gh` login — the earlier
  "repository not found" Prereq-0 is gone.
- **Merge-gated.** The marketplace source tracks this repo's `main` branch unpinned, so
  `claude plugin install` pulls the `main` bundle — only distribute the `.command` after the
  behaviour it depends on is merged to `main`.
- Mint the per-user token, then hand the teammate **the token and this `.command`
  over the same trusted channel** (email/DM). You may pre-fill `TOKEN=` and `NAME=`
  at the top of the `.command` so they *only* double-click — but leaving `TOKEN`
  empty (they paste it) keeps the secret out of the file entirely.
- The token **never** lands in `~/.claude.json`, shell history, argv, or a chat
  transcript — only in `~/.teamkb/team.json` at mode `600`.
- Gatekeeper will flag an unsigned `.command` as "unidentified developer" until we
  ship a signed build (Phase 2): right-click → **Open** clears it.
