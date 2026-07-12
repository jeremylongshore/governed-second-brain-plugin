#!/usr/bin/env node
/**
 * enable-autocapture.mjs — the CONSENT-GATED opt-in for the auto-capture hook (jfv.7).
 *
 * Auto-capture is OFF by default and is NOT a plugin-declared hook, so installing the
 * plugin never turns it on. THIS script is the only supported way to enable it — and
 * it makes you read exactly what it does, and does NOT do, and consent, first. Nothing
 * is auto-installed behind your back.
 *
 *   node hooks/enable-autocapture.mjs            # show the disclosure, then prompt for consent
 *   node hooks/enable-autocapture.mjs --i-consent# non-interactive enable (same disclosure printed)
 *   node hooks/enable-autocapture.mjs --off      # pause: remove the hook + the opt-in marker
 *   node hooks/enable-autocapture.mjs --off --purge  # pause AND delete local autocapture logs
 *   node hooks/enable-autocapture.mjs --status   # is it on? where are the logs?
 *
 * It edits ONLY your own ~/.claude/settings.json (a timestamped backup is written
 * first) and a marker at ~/.teamkb/autocapture.enabled. It never touches the brain.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HOME = homedir();
const TEAMKB_HOME = process.env['TEAMKB_HOME']?.trim() || join(HOME, '.teamkb');
const MARKER = join(TEAMKB_HOME, 'autocapture.enabled');
const LOG_DIR = join(TEAMKB_HOME, 'autocapture-logs');
const SETTINGS = join(HOME, '.claude', 'settings.json');
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'session-end-capture.mjs');
const HOOK_COMMAND = `node ${HOOK_SCRIPT}`;

const args = new Set(process.argv.slice(2));

const DISCLOSURE = `
────────────────────────────────────────────────────────────────────────────
  Auto-capture for the governed team brain — what you are turning on
────────────────────────────────────────────────────────────────────────────
WHAT IT DOES
  When a Claude Code session ends on THIS machine, a background job reads that
  session's transcript, distills AT MOST 5 durable, transferable learnings
  (decisions, patterns, gotchas, conventions), and PROPOSES them to the team
  brain's inbox. That's the same thing you'd do by hand with /brain-save — just
  automatic.

WHAT IT DOES **NOT** DO
  • It does NOT send your raw transcript anywhere. Only the distilled learnings
    the model judges durable leave this machine.
  • It NEVER captures secrets, tokens, credentials, or PII (the distiller strips
    them, and the server's deterministic gate blocks them as a backstop).
  • It writes NOTHING durable. Every proposal lands QUARANTINED and is governed
    by deterministic code + reviewed by an agent before anything is remembered.
    You are proposing; the brain disposes — with a hash-chained receipt.
  • It only runs in TEAM mode (TEAMKB_API_URL + your token set). No local brain.
  • It never blocks or slows your session — it runs detached in the background.

HOW TO SEE / PAUSE / PURGE
  • See what ran:   ${LOG_DIR}/  (per-session logs)
  • See proposals:  ask your admin (they review the inbox) — yours are tagged to your token
  • PAUSE anytime:  node hooks/enable-autocapture.mjs --off
  • PURGE logs:     node hooks/enable-autocapture.mjs --off --purge
  (Already-proposed items live in the team inbox; ask an admin to reject any you regret.)

WHY
  So the whole team's daily learnings flow into the ONE governed brain
  automatically — not just whoever remembers to /brain-save — while every write
  still passes deterministic governance + leaves a receipt. Cited recall,
  hash-chained receipts. You stay in control: it's opt-in, pausable, and
  transparent.
────────────────────────────────────────────────────────────────────────────
`;

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`Refusing to edit ${SETTINGS} — it is not valid JSON. Fix it first.\n  ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

function writeSettings(obj) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, `${SETTINGS}.autocapture-bak`);
  }
  writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

/** Is our Stop hook already registered? */
function hookPresent(settings) {
  const stop = settings?.hooks?.Stop;
  if (!Array.isArray(stop)) return false;
  return stop.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === HOOK_COMMAND));
}

function addHook(settings) {
  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  // `??=` won't repair a Stop that exists but isn't an array (corruption / a
  // different shape) — a later .push() would then throw. Coerce to an array first.
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  if (!hookPresent(settings)) {
    settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  }
  return settings;
}

function removeHook(settings) {
  const stop = settings?.hooks?.Stop;
  if (!Array.isArray(stop)) return settings;
  settings.hooks.Stop = stop
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => h?.command !== HOOK_COMMAND) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  return settings;
}

function status() {
  const on = existsSync(MARKER) && hookPresent(readSettings());
  console.log(`auto-capture: ${on ? 'ON' : 'OFF'}`);
  console.log(`  marker:   ${existsSync(MARKER) ? MARKER : '(none)'}`);
  console.log(`  hook:     ${hookPresent(readSettings()) ? 'registered in ' + SETTINGS : '(not registered)'}`);
  console.log(`  logs:     ${LOG_DIR}`);
}

async function confirm() {
  process.stdout.write(DISCLOSURE);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question('Type  I CONSENT  to enable auto-capture (anything else cancels): ', resolve),
  );
  rl.close();
  return String(answer).trim().toUpperCase() === 'I CONSENT';
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
if (args.has('--status')) {
  status();
  process.exit(0);
}

if (args.has('--off')) {
  const settings = readSettings();
  writeSettings(removeHook(settings));
  if (existsSync(MARKER)) rmSync(MARKER, { force: true });
  if (args.has('--purge') && existsSync(LOG_DIR)) {
    // Remove the whole logs dir in one call (handles any nested files/dirs safely).
    rmSync(LOG_DIR, { recursive: true, force: true });
    console.log(`Purged local autocapture logs in ${LOG_DIR}.`);
  }
  console.log('auto-capture DISABLED — the Stop hook + opt-in marker are removed.');
  console.log('(Any already-proposed items are in the team inbox; ask an admin to reject any you regret.)');
  process.exit(0);
}

// Enable path — requires consent.
const consented = args.has('--i-consent') ? (process.stdout.write(DISCLOSURE), true) : await confirm();
if (!consented) {
  console.log('\nCancelled — auto-capture was NOT enabled. Nothing changed.');
  process.exit(0);
}
mkdirSync(TEAMKB_HOME, { recursive: true });
writeFileSync(MARKER, `enabled ${new Date().toISOString()}\n`, { mode: 0o600 });
chmodSync(MARKER, 0o600); // writeFileSync's mode only applies on CREATE; enforce 600 even if it pre-existed looser.
writeSettings(addHook(readSettings()));
console.log(`\nauto-capture ENABLED.`);
console.log(`  • Stop hook registered in ${SETTINGS} (backup: ${SETTINGS}.autocapture-bak)`);
console.log(`  • opt-in marker: ${MARKER}`);
console.log(`  • pause anytime: node ${HOOK_SCRIPT.replace(/session-end-capture\.mjs$/, 'enable-autocapture.mjs')} --off`);
console.log(`  Requires team mode (TEAMKB_API_URL + TEAMKB_API_TOKEN) to actually run — it no-ops otherwise.`);
process.exit(0);
