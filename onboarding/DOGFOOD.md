# Dogfood checklist — Governed Second Brain

Human acceptance for the installable plugin. Run after a release candidate or
onboarding-page change. ~15 minutes.

**Automated first:**

```bash
cd ~/000-projects/bobs-big-brain-plugin
pnpm test:plugin --live          # needs Tailscale + TEAMKB_API_TOKEN for full Pack B
```

---

## A. Team path (teammate)

- [ ] On Tailscale as `@intentsolutions.io`
- [ ] `curl -sS -m 8 http://100.109.119.103:3847/api/health` → `"status":"healthy"`
- [ ] Open https://demos.intentsolutions.io/bbb/ → **Team** tab
- [ ] Copy install prompt → paste into Claude Code / Cowork with real token
- [ ] Fully quit + reopen Claude
- [ ] `/brain shipped this week` → answer with **`qmd://`** citations
- [ ] `/brain backup` → hits (keywords work)
- [ ] Full-sentence query that returns 0, then keyword works (document if confusing)
- [ ] Commands section on page matches: `/brain` read, `/brain-save` write

**Failure cards (known):**

| Symptom | Likely cause |
|---|---|
| 401 / not working | Rotated token — reissue |
| 0 hits always | Missing `tenantId: intent-solutions` |
| Health timeout | Off Tailscale |
| Marketplace author error | Fixed upstream — `marketplace update` |

---

## B. Local path (public)

- [ ] **Local** tab on demos page
- [ ] Paste local install prompt (no token, no `team.json`)
- [ ] Restart Claude
- [ ] `/brain-save dogfood local install <date>`
- [ ] `/brain dogfood` or keyword from that save → hit or clear empty-brain messaging

---

## C. Sign-off

| Field | Value |
|---|---|
| Date | |
| Tester | |
| Plugin version | |
| Claude Code version | |
| OS | |
| Result | PASS / FAIL |
| Notes | |

Automated evidence: paste `pnpm test:plugin --live` last lines here.
