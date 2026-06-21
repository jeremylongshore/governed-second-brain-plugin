#!/usr/bin/env node
/**
 * Governed Second Brain — unified entry point (one plugin, two modes).
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

async function main(): Promise<void> {
  // Team mode iff TEAMKB_API_URL is genuinely set. An empty value, or an
  // unexpanded "${TEAMKB_API_URL}" placeholder (what the host may pass when the
  // var is not set in the user's environment), both mean local mode.
  const raw = process.env['TEAMKB_API_URL']?.trim();
  const apiUrl = raw !== undefined && raw !== '' && !raw.startsWith('${') ? raw : undefined;

  if (apiUrl !== undefined) {
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
