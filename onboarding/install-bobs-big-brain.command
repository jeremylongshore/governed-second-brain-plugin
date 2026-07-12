#!/bin/bash
#
#  Bob's Big Brain — team onboarding, one double-click.
#  ─────────────────────────────────────────────────────────────────────────────
#  You were handed this file and a token over the same trusted channel. On a Mac,
#  double-click it in Finder — it opens in Terminal and walks you through:
#     1) checking you can reach the team brain over Tailscale,
#     2) taking your token (typed in hidden — never shown, never saved to history),
#     3) saving it to ~/.teamkb/team.json, owner-only (mode 600),
#     4) installing the Bob's Big Brain plugin.
#
#  It is plain text on purpose — open it in TextEdit and read every line first if
#  you like. Nothing here phones home except your own team brain on the tailnet.
#
#  (Gatekeeper: if macOS says "unidentified developer", right-click the file →
#   Open → Open. That's expected until we ship a signed build.)
#
set -euo pipefail

# ── Admin pre-fill (optional) ────────────────────────────────────────────────
# Jeremy may fill these two in before handing the file over, so the teammate just
# double-clicks. Leave TOKEN empty to be prompted — the safe default: the token is
# then never stored in this file, never in shell history, never on a command line.
NAME=""    # e.g. "Max" — cosmetic, used only in the final greeting
TOKEN=""   # leave empty → you'll be asked to paste it (recommended)

# ── Fixed team brain endpoint ────────────────────────────────────────────────
# The tailnet IP, deliberately NOT the flaky 'dev' DNS name.
API_URL="http://100.109.119.103:3847"
TENANT_ID="intent-solutions"
TEAMKB_DIR="$HOME/.teamkb"
TEAM_JSON="$TEAMKB_DIR/team.json"

say()   { printf '%s\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

say ""
bold "  Bob's Big Brain — connecting you to the team brain"
say  "  ──────────────────────────────────────────────────"
say ""

# 1) Reachability. Any HTTP reply (even 401) means we reached the brain over the
#    tailnet; only a connection failure (empty / code 000) means Tailscale trouble.
say "  1) Checking the tailnet connection to the brain…"
code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$API_URL/api/health" 2>/dev/null || true)"
if [ -z "$code" ] || [ "$code" = "000" ]; then
  red "  ✗ Can't reach the brain at $API_URL."
  say ""
  say "  This is almost always Tailscale. Check, in order:"
  say "    • Tailscale is running and the menu-bar icon shows you connected."
  say "    • You're on the right account: run  tailscale switch  and pick the one"
  say "      ending in @intentsolutions.io (tail70fc2c)."
  say "    • If you just joined, your device may be pending admin approval — ping"
  say "      Jeremy, then Quit and reopen Tailscale to re-sync."
  say "    • Quit and reopen the Tailscale app once to refresh the network map."
  say ""
  exit 1
fi
green "  ✓ Brain is reachable (HTTP $code)."

# 2) Token. Prompt if not pre-filled. 'read -s' → never echoed to screen, never
#    written to shell history, never passed as a command-line argument.
if [ -z "$TOKEN" ]; then
  say ""
  say "  2) Paste the token Jeremy emailed you, then press Return."
  say "     (it stays hidden as you paste — that's expected)"
  printf '     token: '
  read -r -s TOKEN
  printf '\n'
fi
if [ -z "$TOKEN" ]; then
  red "  ✗ No token entered — nothing written. Re-run me and paste your token."
  exit 1
fi

# 3) Save ~/.teamkb/team.json, born 0600. umask BEFORE the token ever hits disk,
#    write to a temp file, then atomically move into place. The plugin refuses to
#    load a group/world-readable team.json, so 0600 is not optional.
say ""
say "  3) Saving your connection (owner-only, mode 600)…"
mkdir -p "$TEAMKB_DIR"
umask 077
tmp="$(mktemp "$TEAMKB_DIR/.team.json.XXXXXX")"
cat > "$tmp" <<JSON
{
  "apiUrl": "$API_URL",
  "apiToken": "$TOKEN",
  "tenantId": "$TENANT_ID"
}
JSON
chmod 600 "$tmp"
mv -f "$tmp" "$TEAM_JSON"
green "  ✓ Saved to $TEAM_JSON"

# 4) Install the plugin (skills + tools). Needs the private team marketplace, which
#    needs your intent-solutions-io GitHub membership + a logged-in claude/gh. If it
#    can't complete, your connection is already saved — the brain works the moment
#    the plugin is installed by any path.
say ""
say "  4) Installing the Bob's Big Brain plugin…"
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add intent-solutions-io/team-intent-claude-plugins >/dev/null 2>&1 || true
  if claude plugin install governed-second-brain@intent-solutions-io >/dev/null 2>&1; then
    green "  ✓ Plugin installed."
  else
    say "  • Couldn't auto-install the plugin (usually GitHub access). Your connection is"
    say "    saved. In Claude Code you can finish it yourself with these two commands:"
    say "        /plugin marketplace add intent-solutions-io/team-intent-claude-plugins"
    say "        /plugin install governed-second-brain@intent-solutions-io"
    say "    …or ask Jeremy to finish it."
  fi
else
  say "  • The 'claude' command isn't on your PATH yet. Install Claude Code, then"
  say "    re-run me — your saved connection will still be here."
fi

# 5) One green line. The real proof is asking the brain — not a curl.
say ""
green "  ✅ You're plugged into the big brain${NAME:+, $NAME}."
say ""
bold "  Try it: start a NEW Claude Code session and ask —"
say  "     /brain what did the team ship this week?"
say  "  You should get an answer with qmd:// citations. That's first light."
say ""
say "  (You can close this window.)"
