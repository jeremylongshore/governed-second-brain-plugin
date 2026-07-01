/**
 * Tests for the honest 3-state `brain_audit_verify` banner (bead
 * `compile-then-govern-e06.2` / risk `010-AT-RISK` R8 / umbrella `#27`).
 *
 * The old handler returned `ok:false` + a hard-coded `⚠ TAMPER DETECTED` for
 * ANY chain break — including the live brain's 155 benign same-timestamp
 * ordering forks — which fires a false klaxon at a newcomer and inverts the
 * "govern by receipts" honesty brand. These tests pin the fixed behaviour:
 *
 *   - a brain whose only breaks are benign CHAIN_FORKs  -> ok:true, NO "TAMPER"
 *   - a brain with a real tamper signature (a mutated stored entry_hash)
 *                                                       -> ok:false, "TAMPER DETECTED"
 *   - the default response omits the raw breaks[]/detail arrays (R8 info-leak);
 *     `verbose:true` surfaces them.
 *
 * Each case seeds an ISOLATED throwaway brain under a temp `TEAMKB_BASE_PATH`
 * and drives the BUILT runtime (plugin-runtime/governed-brain.cjs) over a real
 * stdio MCP session. NOTHING here touches ~/.teamkb.
 *
 * Run: `node --test smoke/audit-verify-banner.test.mjs` (or `npm run audit-verify-banner:test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createDatabase,
  AuditRepository,
  computeEntryHash,
  CURRENT_AUDIT_HASH_VERSION,
} from '@qmd-team-intent-kb/store';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');

const TENANT = 'local';

/** Insert one clean, correctly-chained audit event via the repository. */
function insertClean(repo, i) {
  repo.insert({
    id: randomUUID(),
    action: 'promoted',
    memoryId: randomUUID(),
    tenantId: TENANT,
    actor: { type: 'ai', id: 'test' },
    details: { i },
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  });
}

/**
 * Seed a fresh brain DB at <base>/teamkb.db with `cleanCount` correctly-chained
 * rows, then apply `mutate(db, rows)` for the case-specific surgery. Returns the
 * base path (its own temp dir) for the stdio session to point at.
 */
function seedBrain(cleanCount, mutate) {
  const base = mkdtempSync(join(tmpdir(), 'gsb-audit-banner-'));
  const db = createDatabase({ path: join(base, 'teamkb.db') });
  try {
    const repo = new AuditRepository(db);
    for (let i = 0; i < cleanCount; i++) insertClean(repo, i);
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all();
    if (mutate) mutate(db, rows);
  } finally {
    db.close();
  }
  return base;
}

/** Drive the built runtime and return the parsed brain_audit_verify result. */
async function verifyAgainst(base, args = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [RUNTIME],
    env: { ...process.env, TEAMKB_BASE_PATH: base, TEAMKB_TENANT_ID: TENANT },
  });
  const client = new Client({ name: 'audit-banner-test', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: 'brain_audit_verify', arguments: args });
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close().catch(() => {});
  }
}

// ─── benign fork: intact hashes, non-linear link → ok:true, NO "TAMPER" ────────

test('benign CHAIN_FORK only → ok:true and message contains no "TAMPER"', async () => {
  // Seed 3 clean rows, then append a 4th whose prev link points back to an
  // already-walked, INTACT earlier row (row[1]) instead of its immediate
  // predecessor (row[2]). Its own entry_hash is computed correctly, so every
  // hash is intact and the walker classifies it as CHAIN_FORK — not tampering.
  const base = seedBrain(3, (db, rows) => {
    const anchor = rows[1]; // an already-seen intact row's stored hash
    const id = randomUUID();
    const memoryId = randomUUID();
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString();
    const actor_json = JSON.stringify({ type: 'ai', id: 'test' });
    const details_json = JSON.stringify({ i: 'fork' });
    const entry_hash = computeEntryHash(
      {
        id,
        action: 'promoted',
        memory_id: memoryId,
        tenant_id: TENANT,
        actor_json,
        reason: null,
        details_json,
        timestamp,
        prev_entry_hash: anchor.entry_hash,
      },
      CURRENT_AUDIT_HASH_VERSION,
    );
    db.prepare(
      `INSERT INTO audit_events (id, action, memory_id, tenant_id, actor_json, reason,
        details_json, timestamp, entry_hash, prev_entry_hash, hash_version, seq)
       VALUES (@id, 'promoted', @memory_id, @tenant_id, @actor_json, NULL,
        @details_json, @timestamp, @entry_hash, @prev_entry_hash, @hash_version,
        (SELECT COALESCE(MAX(seq),0)+1 FROM audit_events))`,
    ).run({
      id,
      memory_id: memoryId,
      tenant_id: TENANT,
      actor_json,
      details_json,
      timestamp,
      entry_hash,
      prev_entry_hash: anchor.entry_hash,
      hash_version: CURRENT_AUDIT_HASH_VERSION,
    });
  });
  try {
    const ver = await verifyAgainst(base);
    assert.equal(ver.ok, true, `expected ok:true, got ${JSON.stringify(ver)}`);
    assert.equal(ver.tamperSignatures, 0);
    assert.ok(ver.chainForks >= 1, `expected >=1 fork, got ${ver.chainForks}`);
    assert.doesNotMatch(ver.message, /TAMPER/, `message must not say TAMPER: "${ver.message}"`);
    assert.match(ver.message, /benign/i);
    // R8: default response is counts-only — no raw arrays.
    assert.equal(ver.chainBreaks, undefined);
    assert.equal(ver.detail, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── tamper signature: a mutated stored entry_hash → ok:false, "TAMPER DETECTED" ─

test('a mutated stored entry_hash → ok:false and message says "TAMPER DETECTED"', async () => {
  // Seed 3 clean rows, then flip one stored entry_hash. Recomputation no longer
  // matches, so the walker reports ENTRY_HASH_MISMATCH — a tamper signature with
  // no manifest amnesty.
  const base = seedBrain(3, (db, rows) => {
    const victim = rows[1];
    const forged = 'f'.repeat(64);
    assert.notEqual(victim.entry_hash, forged);
    db.prepare('UPDATE audit_events SET entry_hash = ? WHERE id = ?').run(forged, victim.id);
  });
  try {
    const ver = await verifyAgainst(base);
    assert.equal(ver.ok, false, `expected ok:false, got ${JSON.stringify(ver)}`);
    assert.ok(ver.tamperSignatures >= 1, `expected >=1 tamper signature, got ${ver.tamperSignatures}`);
    assert.match(ver.message, /TAMPER DETECTED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── verbose flag surfaces the detail arrays the default hides ─────────────────

test('verbose:true surfaces the per-break detail the default omits', async () => {
  const base = seedBrain(3, (db, rows) => {
    db.prepare('UPDATE audit_events SET entry_hash = ? WHERE id = ?').run('e'.repeat(64), rows[1].id);
  });
  try {
    const terse = await verifyAgainst(base, {});
    assert.equal(terse.detail, undefined, 'default response must not carry detail');

    const ver = await verifyAgainst(base, { verbose: true });
    assert.ok(ver.detail, 'verbose response must carry a detail object');
    assert.ok(Array.isArray(ver.detail.tamperSignatures));
    assert.ok(ver.detail.tamperSignatures.length >= 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── a clean, fully-linear chain → ok:true, zero forks, zero tamper ────────────

test('a clean linear chain → ok:true, 0 forks, 0 tamper, no "TAMPER"', async () => {
  const base = seedBrain(3);
  try {
    const ver = await verifyAgainst(base);
    assert.equal(ver.ok, true);
    assert.equal(ver.tamperSignatures, 0);
    assert.equal(ver.chainForks, 0);
    assert.doesNotMatch(ver.message, /TAMPER/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
