# Onboarding — Bob's Big Brain (Governed Second Brain)

The brain is a **plugin** inside a **desktop** Claude (Claude Code or Cowork) — never a website.

**Live walkthrough (copy-paste prompts):** https://demos.intentsolutions.io/bbb/

| Path | Who | Needs | Mode |
|---|---|---|---|
| **Team** | Intent Solutions teammates | Tailscale (`@intentsolutions.io`) + personal token + desktop Claude | Remote team brain via `~/.teamkb/team.json` |
| **Local (public)** | Anyone | Desktop Claude only | In-process personal brain — no Tailscale, no token |

| Where you run Claude | Works? |
|---|---|
| **Claude Code** or **Cowork** | Yes — recommended. Same paste prompts on Mac, Windows, Linux. |
| **Claude Desktop** | Manual MCP config (see live page). |
| **claude.ai web / phone** | No. |

There is **no OS-specific installer.** One paste-to-Claude path for everyone.

---

## Team path (invite-only)

1. Tailscale + `@intentsolutions.io`
2. Desktop Claude
3. **One paste** — install plugin + write `team.json` (token + required `tenantId: intent-solutions`)
4. Restart → `/brain shipped this week` → `qmd://` citations
5. Optional: standing order in `~/.claude/CLAUDE.md` / `AGENTS.md`

### Paste to Claude (team)

```
Install and connect me to Bob's Big Brain (the Intent Solutions team brain). Run these steps in order. Stop and tell me if any step errors.

1) Add and install the plugin from the public marketplace (no GitHub login needed):
   claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   claude plugin marketplace update governed-second-brain
   claude plugin install governed-second-brain@governed-second-brain

2) Write my team connection file at ~/.teamkb/team.json (Windows: %USERPROFILE%\.teamkb\team.json · Linux: ~/.teamkb/team.json) with restrictive permissions (mode 600). Use exactly this JSON. Replace PASTE-YOUR-TOKEN-HERE with the token I give you — or ask me for the token if I have not pasted it yet. Do NOT invent or change a token. Keep tenantId exactly as written; without it, searches return empty results even with a good token:

{
  "apiUrl": "http://100.109.119.103:3847",
  "apiToken": "PASTE-YOUR-TOKEN-HERE",
  "tenantId": "intent-solutions"
}

3) Tell me to fully quit and reopen Claude Code or Cowork. After I restart I will run: /brain shipped this week and I should get an answer with qmd:// citations.

Prereqs: Tailscale with @intentsolutions.io, desktop Claude. Do not rewrite the plugin manifest. Public marketplace only.
```

**Health check:** `curl -sS -m 8 http://100.109.119.103:3847/api/health` → `"status":"healthy"`.

---

## Local path (public / personal)

### Paste to Claude (local)

```
Install Bob's Big Brain (Governed Second Brain) for me as a LOCAL personal brain on this machine. Run these steps in order. Stop and tell me if any step errors.

1) Add and install the plugin from the public marketplace (no GitHub login needed):
   claude plugin marketplace add jeremylongshore/bobs-big-brain-plugin
   claude plugin marketplace update governed-second-brain
   claude plugin install governed-second-brain@governed-second-brain

2) Keep me in LOCAL mode only:
   - Do NOT create ~/.teamkb/team.json
   - Do NOT set TEAMKB_API_URL, TEAMKB_API_TOKEN, or TEAMKB_TENANT_ID
   - If team.json already exists and I want local-only, tell me how to rename or remove it (do not delete without my confirmation)

3) Tell me to fully quit and reopen Claude Code or Cowork.

4) After restart, help me verify the governed-brain tools are available (brain_status or /brain). An empty local brain is normal on first install — I will feed it with /brain-save.

Do not rewrite the plugin manifest. Do not invent tokens. Do not connect me to any remote team API.
```

---

## Commands

| Command | Role |
|---|---|
| **`/brain`** | **Read** — search the brain. Use 1–2 **keywords**, not full sentences. Hits return `qmd://` citations. |
| **`/brain-save`** | **Write** — capture one fact/decision. Explicit only (never auto). Team: governed shared brain. Local: on your machine. |

Examples: `/brain shipped this week` · `/brain backup` · `/brain-save we use SOPS + age for secrets`

---

## How mode resolution works

```
real environment variable  →  ~/.teamkb/team.json  →  (absent → local mode)
```

`team.json` (team only, mode `600`):

```json
{
  "apiUrl": "http://100.109.119.103:3847",
  "apiToken": "<per-user bearer token>",
  "tenantId": "intent-solutions"
}
```

**Fail-closed:** broken `team.json` refuses to start — no silent fall back to local.

---

## Admin notes (Jeremy)

- Public marketplace: `jeremylongshore/bobs-big-brain-plugin` — no org membership / `gh` login
- Hand teammates: **token + page link**
- Token only in `team.json` mode `600`
- Live page: `~/demos/bbb/index.html` → https://demos.intentsolutions.io/bbb/
- Automated tests: `pnpm test:plugin` · `pnpm test:plugin:live` · see `tests/TESTING.md` + `onboarding/DOGFOOD.md`
