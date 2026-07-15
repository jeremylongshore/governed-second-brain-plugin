#!/usr/bin/env node
/**
 * Auto-capture hook (jfv.7) — OFF BY DEFAULT, opt-in, NEVER auto-installed.
 *
 * A Claude Code Stop/SessionEnd hook that, on a finished session, distills the
 * transcript into a few DURABLE learnings and proposes them to your team's governed
 * brain via brain_capture (team mode → the remote inbox → governed + agent-reviewed
 * overnight). It is the automatic counterpart of the manual /brain-save.
 *
 * It writes NOTHING durable itself: every proposal lands QUARANTINED and is governed
 * by deterministic code + reviewed by an agent before anything is remembered
 * (014-AT-DECR). Your raw transcript never leaves your machine — only the distilled
 * learnings the model judges durable, with secrets/PII stripped.
 *
 * THREE hard guards, ALL required, so this can only ever run when you deliberately
 * turned it on:
 *   1. The opt-in marker file `~/.teamkb/autocapture.enabled` exists (or
 *      TEAMKB_AUTOCAPTURE=1). Written only by `enable-autocapture.mjs`, which makes
 *      you read what it does + consent first.
 *   2. Team mode is configured (TEAMKB_API_URL + TEAMKB_API_TOKEN). Autocapture is a
 *      TEAM feature — it never touches a local brain.
 *   3. This is not a recursive child (the distiller's own session ending must not
 *      re-fire the hook).
 *
 * Any guard unmet → exit 0, silent no-op. It NEVER blocks or fails your session:
 * the distiller runs detached in the background and its errors go to a log, never to
 * your terminal.
 *
 * Install (opt-in) is via `enable-autocapture.mjs`, not plugin.json — this hook is
 * deliberately NOT a plugin-declared hook, so installing the plugin does not enable it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const TEAMKB_HOME = process.env['TEAMKB_HOME']?.trim() || join(HOME, '.teamkb');
const MARKER = join(TEAMKB_HOME, 'autocapture.enabled');
const LOG_DIR = join(TEAMKB_HOME, 'autocapture-logs');

/** Exit as a silent no-op — the hook must never disturb the teammate's session. */
function noop(reason) {
  if (process.env['TEAMKB_AUTOCAPTURE_DEBUG'] === '1') {
    process.stderr.write(`[autocapture] skipped: ${reason}\n`);
  }
  process.exit(0);
}

/**
 * Resolve team-mode config the SAME way the plugin does (src/team-config.ts):
 * real env wins per-key, else ~/.teamkb/team.json fills the gap. A teammate who
 * configured team mode via team.json (GUI/Dock launch, no shell env) would
 * otherwise have this hook silently no-op — team.json is the documented onboarding
 * path, so the hook must honor it too.
 */
function resolveTeamConfig() {
  let file = {};
  try {
    const parsed = JSON.parse(readFileSync(join(TEAMKB_HOME, 'team.json'), 'utf8'));
    if (parsed !== null && typeof parsed === 'object') file = parsed;
  } catch {
    /* absent / unreadable / malformed → env-only */
  }
  const pick = (envKey, fileKey) => {
    const e = process.env[envKey]?.trim();
    if (e) return e;
    const f = typeof file[fileKey] === 'string' ? file[fileKey].trim() : '';
    return f || undefined;
  };
  return {
    apiUrl: pick('TEAMKB_API_URL', 'apiUrl'),
    apiToken: pick('TEAMKB_API_TOKEN', 'apiToken'),
    tenantId: pick('TEAMKB_TENANT_ID', 'tenantId') || 'intent-solutions',
  };
}

// ── Guard 3: never recurse (the distiller is itself a claude session). ──
if (process.env['TEAMKB_AUTOCAPTURE_CHILD'] === '1') noop('recursive child');

// ── Guard 1: hard opt-in. ──
if (!existsSync(MARKER) && process.env['TEAMKB_AUTOCAPTURE'] !== '1') {
  noop('not enabled (no ~/.teamkb/autocapture.enabled marker)');
}

// ── Guard 2: team mode only (env OR team.json — parity with the plugin). ──
const TEAM = resolveTeamConfig();
const API_URL = TEAM.apiUrl;
const API_TOKEN = TEAM.apiToken;
if (!API_URL || !API_TOKEN) noop('team mode not configured (need TEAMKB_API_URL + TEAMKB_API_TOKEN, via env or ~/.teamkb/team.json)');

// ── Read the hook payload from stdin (Claude Code passes JSON). ──
// No fixed timeout (that could truncate a large payload — a stdin read can exceed
// any fixed budget under load). A manual run has no piped stdin, detected via
// isTTY, and resolves empty immediately; a real hook always sends JSON then closes
// the stream, so we wait for 'end'.
let raw = '';
try {
  raw = process.stdin.isTTY
    ? ''
    : await new Promise((resolve) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (buf += c));
        process.stdin.on('end', () => resolve(buf));
        process.stdin.on('error', () => resolve(buf));
      });
} catch {
  raw = '';
}
let transcriptPath = '';
/** Stable session key for capture idempotency (session + learningIndex slots). */
let sessionId = '';
try {
  const payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  // Claude Code hook payloads may expose session_id / sessionId; fall back to a
  // stable hash of the transcript path so re-fires of the same session collapse.
  const rawSid =
    (typeof payload.session_id === 'string' && payload.session_id) ||
    (typeof payload.sessionId === 'string' && payload.sessionId) ||
    '';
  sessionId = rawSid.trim();
  if (!sessionId && transcriptPath) {
    // Deterministic fallback from path (not crypto — keep hook deps zero).
    let h = 0;
    for (let i = 0; i < transcriptPath.length; i++) h = (Math.imul(31, h) + transcriptPath.charCodeAt(i)) | 0;
    sessionId = `transcript:${(h >>> 0).toString(16)}:${transcriptPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-48)}`;
  }
} catch {
  transcriptPath = '';
  sessionId = '';
}
if (!transcriptPath || !existsSync(transcriptPath)) noop('no readable transcript_path in the hook payload');
if (!sessionId) noop('no session id resolvable from hook payload');

// ── The runtime bundle (this file lives in <plugin>/hooks/). ──
const RUNTIME = join(new URL('..', import.meta.url).pathname, 'plugin-runtime', 'governed-brain.cjs');
if (!existsSync(RUNTIME)) noop(`plugin runtime not found at ${RUNTIME}`);

// ── The distiller prompt — conservative, secrets-stripped, capped. ──
// It runs headless with the team-mode brain MCP (member token), so it can ONLY
// brain_capture (propose) — it cannot promote or write durable state. Every proposal
// is governed + agent-reviewed server-side before anything is remembered.
//
// Idempotency: ALWAYS pass sessionId + learningIndex (0..4). The plugin mints a
// per-slot id so re-distill of slot i collapses, while slots 0..N stay distinct.
const PROMPT = [
  'You are the auto-capture distiller for a teammate\'s just-finished Claude Code session.',
  `Read the session transcript at: ${transcriptPath}`,
  `Session id (REQUIRED on every brain_capture): ${sessionId}`,
  'Extract AT MOST 5 DURABLE, transferable learnings — decisions made, patterns that emerged,',
  'gotchas worth not relearning, conventions adopted — each self-contained so a teammate finds it',
  'useful in 30 days with zero memory of today. Weight real conclusions over chatter.',
  'HARD RULES: NEVER capture a secret, token, credential, connection string, or PII. Skip ephemeral',
  'debugging noise, status updates, half-baked ideas, and anything already in a CLAUDE.md/README.',
  'A small honest set beats a padded one — capturing NOTHING is a correct, common outcome.',
  'For each durable learning i (0-based, max 4), call brain_capture with ALL of:',
  `{ title, content, category, sessionId: "${sessionId}", learningIndex: i }`,
  'category one of: decision, pattern, convention, architecture, troubleshooting, onboarding, reference.',
  'NEVER omit sessionId or learningIndex. Re-distill of the same i must use the same learningIndex.',
  'These are PROPOSALS to the team inbox — the pipeline + an agent reviewer decide what is kept.',
  'Do not call any other tool. When done, print a one-line summary: "autocapture: proposed N".',
].join(' ');
// A minimal, team-mode MCP config passed explicitly (the plugin is not assumed to be
// enabled in the headless child). Env-expanded from the current team credentials.
const mcpConfig = JSON.stringify({
  mcpServers: {
    'governed-brain': {
      command: 'node',
      args: [RUNTIME],
      env: {
        TEAMKB_API_URL: API_URL,
        TEAMKB_API_TOKEN: API_TOKEN,
        TEAMKB_TENANT_ID: TEAM.tenantId,
      },
    },
  },
});

// ── Fire the distiller DETACHED + backgrounded — never blocks session end. ──
try {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* best-effort */
}
const stamp = raw.length > 0 ? transcriptPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40) : 'manual';
const logPath = join(LOG_DIR, `${stamp}.log`);
let logFd;
try {
  logFd = openSync(logPath, 'a', 0o600);
} catch {
  logFd = 'ignore';
}

try {
  const child = spawn(
    'claude',
    ['-p', PROMPT, '--mcp-config', mcpConfig, '--strict-mcp-config', '--dangerously-skip-permissions'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // On Windows, `claude` is a .cmd shim that spawn can't exec without a shell.
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        TEAMKB_AUTOCAPTURE_CHILD: '1', // Guard 3: the child must not re-fire the hook.
        TEAMKB_API_URL: API_URL,
        TEAMKB_API_TOKEN: API_TOKEN,
        TEAMKB_TENANT_ID: TEAM.tenantId,
      },
    },
  );
  child.unref();
} catch (e) {
  if (process.env['TEAMKB_AUTOCAPTURE_DEBUG'] === '1') {
    process.stderr.write(`[autocapture] could not spawn distiller: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Always succeed — the hook is best-effort and must never disturb the session.
process.exit(0);
