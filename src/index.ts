#!/usr/bin/env node
/**
 * Bob's Big Brain — unified entry point (one plugin, two modes).
 *
 * ONE plugin, dispatched at startup by whether TEAMKB_API_URL is set:
 *
 *   • local mode  (default, no TEAMKB_API_URL): the in-process governed brain —
 *     your files → ~/.teamkb, full self-service capture → govern → search with a
 *     SHA-256 hash-chained audit trail. No daemon, no network, no key. This is the
 *     public showcase: your personal brain.
 *
 *   • team mode   (TEAMKB_API_URL set): a remote proxy to your team's single
 *     governed brain over the tailnet (per-user token). Read + propose; capture/
 *     govern/promote are governed server-side. This is what the team uses.
 *
 * The modes are dynamic-imported so only the selected one loads. Team mode never
 * pulls in the local store's native module (better-sqlite3), so it runs from a
 * marketplace clone with zero install/build; local mode never opens a socket.
 * The tool surface is unified (`brain_*`) so the /brain and /brain-save skills
 * work identically in either mode.
 */

import { isConfigured, resolveMode } from './mode.js';
import { applyTeamConfig, loadTeamConfig, teamConfigPath, TeamConfigError } from './team-config.js';

async function main(): Promise<void> {
  // Config-file fallback + fail-closed gate (the onboarding fix). A GUI/Dock launch
  // never sources ~/.zshrc, so team env vars set there are absent; ~/.teamkb/team.json
  // (written 0600 by the double-click installer) supplies them regardless of the
  // launching shell. A present-but-broken team.json REFUSES loudly here rather than
  // silently running the wrong (empty local) brain — a teammate who dropped the file
  // clearly wants team mode. This MUST run before resolveMode + the dynamic import so
  // the merged values are in process.env when the selected mode reads them.
  let filled: string[] = [];
  try {
    filled = applyTeamConfig(process.env, loadTeamConfig(process.env));
  } catch (e) {
    const msg = e instanceof TeamConfigError || e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[governed-brain] REFUSING TO START — ${teamConfigPath(process.env)} is present but unusable:\n` +
        `  ${msg}\n` +
        `  Fix the file (or remove it to run the local brain). Refusing to silently run the wrong brain.\n`,
    );
    process.exit(1);
  }
  if (filled.length > 0) {
    process.stderr.write(
      `[governed-brain] team.json supplied: ${filled.join(', ')} (real env took precedence for the rest)\n`,
    );
  }

  // Team mode iff TEAMKB_API_URL is genuinely set — from real env, or filled from
  // team.json above. An empty value or an unexpanded "${TEAMKB_API_URL}" placeholder
  // both mean local mode. The exact predicate lives in (and is unit-tested through)
  // src/mode.ts.
  const { mode } = resolveMode(process.env['TEAMKB_API_URL']);

  // Fail-closed on a token-less team config: team mode is authenticated (the brain API
  // 401s without a bearer), so a URL with no token can only ever produce rejected
  // requests. Refuse at startup with a clear message rather than boot into a mode that
  // is guaranteed to 401 on the first call.
  if (mode === 'team' && !isConfigured(process.env['TEAMKB_API_TOKEN'])) {
    process.stderr.write(
      `[governed-brain] REFUSING TO START — team mode is configured (TEAMKB_API_URL is set) but no ` +
        `TEAMKB_API_TOKEN is available. Set your per-user token in ${teamConfigPath(process.env)} ` +
        `(the "apiToken" field) or the environment. Refusing to run team mode without a token.\n`,
    );
    process.exit(1);
  }

  if (mode === 'team') {
    // Team mode — remote proxy over the tailnet.
    const { startRemoteServer } = await import('./remote-server.js');
    await startRemoteServer();
  } else {
    // Local mode — in-process governed brain (default).
    const { startLocalServer } = await import('./local-server.js');
    await startLocalServer();
  }
}

void main();
