import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A stub `claude` on PATH so the "attempted" test never invokes the real model. */
function stubClaudeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-bin-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * jfv.7 — the auto-capture hook's SAFETY guards. The one property that must never
 * regress: the hook is a silent no-op unless the teammate DELIBERATELY enabled it
 * (opt-in marker) AND team mode is configured AND it is not a recursive child.
 * "Attempted to distill" is observable as the creation of the autocapture-logs dir
 * (created only right before the detached distiller spawn); a no-op leaves it absent.
 */
const HOOK = join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'session-end-capture.mjs');

/** Run the hook with a throwaway TEAMKB_HOME + env + stdin; return {code, logsDir, attempted}. */
function runHook({ enabled = false, teamMode = false, child = false, transcript = null, teamJson = null, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tkb-ac-'));
  if (enabled) writeFileSync(join(home, 'autocapture.enabled'), 'enabled\n');
  if (teamJson) writeFileSync(join(home, 'team.json'), JSON.stringify(teamJson));
  const stdin = transcript ? JSON.stringify({ transcript_path: transcript }) : '{}';
  const res = spawnSync('node', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMKB_HOME: home,
      TEAMKB_API_URL: teamMode ? 'http://127.0.0.1:1/never' : '',
      TEAMKB_API_TOKEN: teamMode ? 'tok' : '',
      TEAMKB_AUTOCAPTURE_CHILD: child ? '1' : '',
      ...env,
    },
  });
  const logsDir = join(home, 'autocapture-logs');
  const attempted = existsSync(logsDir);
  rmSync(home, { recursive: true, force: true });
  return { code: res.status, attempted };
}

test('resolves team mode from ~/.teamkb/team.json when the env is unset (parity with the plugin)', () => {
  if (platform() === 'win32') return;
  const bin = stubClaudeBin();
  const tdir = mkdtempSync(join(tmpdir(), 'tkb-t-'));
  const tf = join(tdir, 'transcript.jsonl');
  writeFileSync(tf, '{"role":"user","content":"hi"}\n');
  // NO team env vars — only a team.json file. The hook must still activate.
  const r = runHook({
    enabled: true,
    teamMode: false,
    transcript: tf,
    teamJson: { apiUrl: 'http://127.0.0.1:1/never', apiToken: 'tok', tenantId: 'intent-solutions' },
    env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  rmSync(tdir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, true); // team.json alone was enough to configure team mode
});

test('no-op when NOT enabled (no marker) — the default', () => {
  const r = runHook({ enabled: false, teamMode: true, transcript: '/etc/hostname' });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, false); // never tried to distill
});

test('no-op when enabled but team mode is NOT configured', () => {
  const r = runHook({ enabled: true, teamMode: false, transcript: '/etc/hostname' });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, false);
});

test('no-op on a recursive child (must not re-fire on the distiller\'s own session)', () => {
  const r = runHook({ enabled: true, teamMode: true, child: true, transcript: '/etc/hostname' });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, false);
});

test('no-op when there is no readable transcript in the payload', () => {
  const r = runHook({ enabled: true, teamMode: true, transcript: '/does/not/exist' });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, false);
});

test('when fully enabled + configured + a real transcript, it ATTEMPTS the distill (best-effort, detached)', (t) => {
  if (platform() === 'win32') return; // POSIX stub shim only
  // A real, readable transcript file + a STUB `claude` on PATH (so we never invoke
  // the real model): the hook exits 0 and creates the logs dir (the "attempted"
  // signal), while the detached distiller is a harmless no-op stub.
  const bin = stubClaudeBin();
  const tdir = mkdtempSync(join(tmpdir(), 'tkb-t-'));
  const tf = join(tdir, 'transcript.jsonl');
  writeFileSync(tf, '{"role":"user","content":"hi"}\n');
  const r = runHook({
    enabled: true,
    teamMode: true,
    transcript: tf,
    env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  rmSync(tdir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.code, 0);
  assert.equal(r.attempted, true);
});
