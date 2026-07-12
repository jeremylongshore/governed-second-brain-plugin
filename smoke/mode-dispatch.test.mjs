// Smoke: the mode-dispatch + fail-closed wiring in src/index.ts, exercised END-TO-END
// through the SHIPPED bundle (plugin-runtime/governed-brain.cjs) — the layer the unit
// tests (which cover the pure helpers) cannot reach. Spawns the real runtime with an
// isolated TEAMKB_BASE_PATH and a CLEAN env, and asserts the four load-bearing paths:
//   1. a group/world-readable team.json  → REFUSE loudly, exit 1 (never boots)
//   2. a valid 0600 team.json + NO env   → fill env from the file, boot TEAM mode
//   3. no team.json + no env             → boot LOCAL mode, no refusal (public showcase)
//   4. a snake_case api_url (no apiUrl)  → REFUSE (the silent-local typo trap)
// Zero egress: team mode opens no socket at boot, so nothing leaves the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');

// Spawn the bundle with an isolated brain base and a clean env (no inherited TEAMKB_*
// team vars). Resolves once the process exits on its own (the refuse path) OR prints
// its stderr boot line (the dispatch paths, which then wait on stdio — we capture the
// line and SIGKILL). A hard 8s cap guarantees the test can never hang CI.
function runBundle(base, { expectBoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], {
      env: {
        ...process.env,
        TEAMKB_BASE_PATH: base,
        TEAMKB_API_URL: '',
        TEAMKB_API_TOKEN: '',
        TEAMKB_TENANT_ID: '',
      },
      // stdin kept open (never written/ended) so the dispatch-path server stays up
      // until we kill it; stdout ignored; stderr captured (the boot/refusal lines).
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const finish = (code) => {
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => finish(null), 8000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (expectBoot && /\bstarted\b/.test(stderr)) finish(null);
    });
    child.on('exit', (code) => finish(code));
    child.on('error', reject);
  });
}

function withBase(fn) {
  const base = mkdtempSync(join(tmpdir(), 'gsb-dispatch-'));
  return Promise.resolve(fn(base)).finally(() => rmSync(base, { recursive: true, force: true }));
}

function writeTeam(base, obj, mode) {
  const p = join(base, 'team.json');
  writeFileSync(p, JSON.stringify(obj));
  chmodSync(p, mode);
  return p;
}

test('fail-closed: a group/world-readable team.json REFUSES and exits 1 (never boots)', () =>
  withBase(async (base) => {
    writeTeam(base, { apiUrl: 'http://127.0.0.1:3847', apiToken: 't', tenantId: 'intent-solutions' }, 0o644);
    const { code, stderr } = await runBundle(base, { expectBoot: false });
    assert.equal(code, 1, `expected exit 1, got ${code}. stderr:\n${stderr}`);
    assert.match(stderr, /REFUSING TO START/);
    assert.match(stderr, /0600/);
    assert.doesNotMatch(stderr, /\bstarted\b/);
  }));

test('team dispatch: a valid 0600 team.json with NO env fills env and boots TEAM mode', () =>
  withBase(async (base) => {
    writeTeam(base, { apiUrl: 'http://127.0.0.1:3847', apiToken: 't', tenantId: 'intent-solutions' }, 0o600);
    const { stderr } = await runBundle(base, { expectBoot: true });
    assert.match(stderr, /governed-brain:team\] started/);
    assert.match(stderr, /team\.json supplied/);
  }));

test('local default: no team.json and no env boots LOCAL mode, no refusal', () =>
  withBase(async (base) => {
    const { stderr } = await runBundle(base, { expectBoot: true });
    assert.match(stderr, /governed-brain:local\] started/);
    assert.doesNotMatch(stderr, /REFUSING TO START/);
  }));

test('fail-closed: a snake_case api_url (no camelCase apiUrl) REFUSES — the silent-local trap', () =>
  withBase(async (base) => {
    writeTeam(base, { api_url: 'http://127.0.0.1:3847', api_token: 't' }, 0o600);
    const { code, stderr } = await runBundle(base, { expectBoot: false });
    assert.equal(code, 1, `expected exit 1, got ${code}. stderr:\n${stderr}`);
    assert.match(stderr, /no usable "apiUrl"/);
  }));
