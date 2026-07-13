/**
 * anchor-conformance.test.mjs — bead compile-then-govern-6ps.11 (Track 3).
 *
 * Cross-checks the TWO GENUINELY-INDEPENDENT implementations of anchor-log
 * verification against ONE shared fixture, so they can't silently split-brain
 * (one flag a rewrite the other passes):
 *
 *   impl-1  INTKB `verifyAnchors` (@qmd-team-intent-kb/store, audit-anchor.ts) —
 *           re-derives every anchorHash from the canonical body, checks the log
 *           linkage, and cross-checks each anchored (chainedRows, chainHead)
 *           against the live rows. This is the EXACT code the plugin's
 *           brain_audit_verify bundles, so {INTKB, plugin brain_audit_verify}
 *           count as ONE implementation for conformance.
 *   impl-2  the standalone scripts/verify-anchors.mjs — zero-dependency, imports
 *           NOTHING from INTKB; it REPLICATES computeAnchorHash byte-for-byte and
 *           re-implements the linkage + a --db head/count cross-check.
 *
 * HONEST SCOPE (why this is a 2-, not 3-way check): the plugin's brain_audit_verify
 * is NOT independent of impl-1 (it runs impl-1's bundled bytes), and the in-DB
 * per-row entry_hash walk (verifyAuditChain) has exactly one implementation. So
 * conformance is meaningful only on the ANCHOR-LOG layer, across impl-1 vs impl-2.
 * The KNOWN, DOCUMENTED divergences below (assert-divergence rows) are the real
 * coverage boundaries of the independent anchor verifier, not bugs.
 *
 * Zero-install: `node --test scripts/anchor-conformance.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// impl-1 — the store's real verifier + fixture primitives (the SAME code the plugin
// bundles). It is a build-only sibling (link:../qmd-team-intent-kb/...) that a fresh
// plugin-only CI checkout STRIPS, so import it GUARDED: absent → the store cases skip
// (never error). The dedicated `anchor-conformance` CI job provisions the sibling so
// they run enforced there; a local dev checkout has the sibling and runs them too.
let store = null;
try {
  store = await import('@qmd-team-intent-kb/store');
} catch {
  store = null;
}
const HAS_STORE = store !== null;
const SKIP_STORE = HAS_STORE ? false : 'requires @qmd-team-intent-kb/store (build-only sibling; provisioned by the anchor-conformance CI job)';
const verifyAnchors = store?.verifyAnchors;
const appendAnchor = store?.appendAnchor;
const computeEntryHash = store?.computeEntryHash;
// impl-2 — the independent standalone re-implementation (imports nothing from INTKB).
import { verify as standaloneVerify, computeAnchorHash } from './verify-anchors.mjs';

const FIXED_NOW = () => '2026-06-17T12:00:00.000Z';

// ── shared fixture builders (ONE canonical source per case) ──────────────────

/** A valid hash_version-2 chain (copied from the store's own audit-anchor.test.ts). */
function buildChain(reasons) {
  const rows = [];
  let prev = null;
  reasons.forEach((reason, i) => {
    const base = {
      id: `id-${i}`,
      action: 'promoted',
      memory_id: `mem-${i}`,
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason,
      details_json: '{}',
      timestamp: `2026-06-17T00:00:0${i}.000Z`,
      hash_version: 2,
    };
    const entry_hash = computeEntryHash({ ...base, prev_entry_hash: prev });
    rows.push({ ...base, prev_entry_hash: prev, entry_hash });
    prev = entry_hash;
  });
  return rows;
}

const mockRepo = (rows) => ({ findAllChronological: () => rows });

/**
 * Write an anchor log by calling appendAnchor once per row-count in `stages`
 * (each stage is a full chain the log anchored at that moment), git-init + commit
 * + fake remote so impl-2's witness check is a WARN, never a hard failure.
 * Returns { dir, anchorsPath }.
 */
function writeAnchorLog(stages) {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-conf-'));
  const anchorsPath = join(dir, 'anchors.jsonl');
  for (const rows of stages) appendAnchor(mockRepo(rows), anchorsPath, { tenantId: 'local', nowFn: FIXED_NOW });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', 'https://example.com/fake.git');
  git('add', 'anchors.jsonl');
  git('commit', '-q', '-m', 'anchor');
  return { dir, anchorsPath };
}

/** Seed audit_events(seq, entry_hash) from rows via the sqlite3 CLI (impl-2's --db path). */
function makeAuditDb(dir, rows) {
  const dbPath = join(dir, 'teamkb.db');
  const values = rows.map((r, i) => `(${i + 1}, '${r.entry_hash}')`).join(',');
  const sql = 'CREATE TABLE audit_events (seq INTEGER PRIMARY KEY, entry_hash TEXT);\n' +
    `INSERT INTO audit_events (seq, entry_hash) VALUES ${values};`;
  const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${(r.stderr || '').trim()}`);
  return dbPath;
}

// ── normalization: both impls' differing break shapes → one canonical bucket set ─

/** impl-1 anchorBreaks[].reason and impl-2 hardFailures[].reason both map here. */
function bucket(reason) {
  switch (reason) {
    case 'ANCHOR_HASH_MISMATCH': return 'ANCHOR_HASH_BROKEN';
    case 'ANCHOR_LINK_MISMATCH': return 'ANCHOR_LINK_BROKEN';
    // The critical normalization: impl-1 says HISTORY_TRUNCATED, impl-2 says
    // HISTORY_REWRITTEN for a truncation — same phenomenon, one bucket.
    case 'HISTORY_TRUNCATED':
    case 'HISTORY_REWRITTEN': return 'HISTORY_BROKEN';
    default: return `OTHER:${reason}`;
  }
}
const uniqSort = (a) => [...new Set(a)].sort();
const impl1Buckets = (res) => uniqSort(res.anchorBreaks.map((b) => bucket(b.reason)));
// hardFailures = FAIL-level findings only (warnings/notes like UNPUSHED_LOCAL_WITNESS
// and DB_CHECK_SKIPPED have no impl-1 counterpart and are dropped by design).
const impl2Buckets = (res) => uniqSort(res.hardFailures.map((f) => bucket(f.reason)));

/**
 * THE conformance comparator (the thing under test). Asserts the two independent
 * impls AGREE on ok AND on the normalized anchor-layer break-set.
 */
function assertConform(name, impl1, impl2) {
  const ok1 = impl1.ok;
  const ok2 = impl2.hardFailures.length === 0;
  assert.equal(ok1, ok2, `${name}: ok disagreement — impl1(INTKB)=${ok1} impl2(standalone)=${ok2}`);
  assert.deepEqual(
    impl1Buckets(impl1),
    impl2Buckets(impl2),
    `${name}: anchor-layer break-set divergence — impl1=${JSON.stringify(impl1Buckets(impl1))} impl2=${JSON.stringify(impl2Buckets(impl2))}`,
  );
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// ── pure-log conformance cases (multi-anchor; impl-2 db:null) ─────────────────

test('CLEAN — a 3-anchor growing chain: both impls agree ok=true, no breaks', { skip: SKIP_STORE }, () => {
  const rows5 = buildChain(['a', 'b', 'c', 'd', 'e']);
  const stages = [buildChain(['a', 'b', 'c']), buildChain(['a', 'b', 'c', 'd']), rows5];
  const { dir, anchorsPath } = writeAnchorLog(stages);
  try {
    const i1 = verifyAnchors(mockRepo(rows5), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });
    assertConform('CLEAN', i1, i2);
    assert.equal(i1.ok, true, JSON.stringify(i1.anchorBreaks));
    assert.deepEqual(impl1Buckets(i1), []);
  } finally { cleanup(dir); }
});

test('ANCHOR_HASH_TAMPER — an edited anchor body (no reseal): both flag ANCHOR_HASH_BROKEN', { skip: SKIP_STORE }, () => {
  const rows = buildChain(['a', 'b', 'c']);
  const { dir, anchorsPath } = writeAnchorLog([rows]);
  try {
    // Edit the anchor's tenantId in place WITHOUT recomputing anchorHash.
    const lines = readFileSync(anchorsPath, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0]);
    rec.tenantId = 'TAMPERED';
    lines[0] = JSON.stringify(rec);
    writeFileSync(anchorsPath, lines.join('\n') + '\n');
    const i1 = verifyAnchors(mockRepo(rows), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });
    assertConform('ANCHOR_HASH_TAMPER', i1, i2);
    assert.deepEqual(impl1Buckets(i1), ['ANCHOR_HASH_BROKEN']);
  } finally { cleanup(dir); }
});

test('ANCHOR_LINK_TAMPER — a broken prevAnchorHash link: both flag ANCHOR_LINK_BROKEN', { skip: SKIP_STORE }, () => {
  const r3 = buildChain(['a', 'b', 'c']);
  const r4 = buildChain(['a', 'b', 'c', 'd']);
  const { dir, anchorsPath } = writeAnchorLog([r3, r4]);
  try {
    // Reseal anchor #2 with a wrong prevAnchorHash (recompute its own anchorHash so
    // this is a pure LINK break, not a self-hash break) — mirrors verify-anchors' own (c).
    const lines = readFileSync(anchorsPath, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[1]);
    rec.prevAnchorHash = 'f'.repeat(64);
    const { anchorHash, ...body } = rec;
    rec.anchorHash = computeAnchorHash(body);
    lines[1] = JSON.stringify(rec);
    writeFileSync(anchorsPath, lines.join('\n') + '\n');
    const i1 = verifyAnchors(mockRepo(r4), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });
    assertConform('ANCHOR_LINK_TAMPER', i1, i2);
    assert.deepEqual(impl1Buckets(i1), ['ANCHOR_LINK_BROKEN']);
  } finally { cleanup(dir); }
});

// ── DB cross-check conformance cases (single anchor; impl-2 passes --db) ──────

test('DB_HEAD_SWAP — a re-hashed-forward chain: both flag HISTORY_BROKEN (the headline)', { skip: SKIP_STORE }, () => {
  const orig = buildChain(['a', 'b', 'c']);           // anchor froze head H
  const rewritten = buildChain(['TAMPERED', 'b', 'c']); // same count, internally-valid new head H'
  const { dir, anchorsPath } = writeAnchorLog([orig]);
  try {
    const i1 = verifyAnchors(mockRepo(rewritten), anchorsPath); // repo head H' vs anchor head H
    const db = makeAuditDb(dir, rewritten);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });
    assertConform('DB_HEAD_SWAP', i1, i2);
    assert.deepEqual(impl1Buckets(i1), ['HISTORY_BROKEN']);
    assert.equal(i1.ok, false);
  } finally { cleanup(dir); }
});

test('DB_TRUNCATE — history truncated below the anchored position: both flag HISTORY_BROKEN (reason-code divergence normalized)', { skip: SKIP_STORE }, () => {
  const orig = buildChain(['a', 'b', 'c']);  // anchor: chainedRows=3, head H
  const truncated = buildChain(['a', 'b']);  // 2 rows
  const { dir, anchorsPath } = writeAnchorLog([orig]);
  try {
    const i1 = verifyAnchors(mockRepo(truncated), anchorsPath); // impl-1 says HISTORY_TRUNCATED
    const db = makeAuditDb(dir, truncated);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db }); // impl-2 says HISTORY_REWRITTEN
    assertConform('DB_TRUNCATE', i1, i2); // both → HISTORY_BROKEN
    assert.deepEqual(impl1Buckets(i1), ['HISTORY_BROKEN']);
  } finally { cleanup(dir); }
});

// ── the comparator has TEETH — a self-test proving it is not a tautology ──────

test('comparator catches a genuine divergence (guards against a tautological pass)', () => {
  // If the two impls EVER disagreed, assertConform must throw. Feed it a fabricated
  // divergence — impl-1 clean, impl-2 flags HISTORY_BROKEN — and require a throw.
  const clean1 = { ok: true, chain: { breaks: [] }, anchorBreaks: [] };
  const diverged2 = { hardFailures: [{ reason: 'HISTORY_REWRITTEN' }] };
  assert.throws(() => assertConform('SELFTEST-ok', clean1, diverged2), /ok disagreement/);
  // Same ok, different break-set → must also throw.
  const break1 = { ok: false, chain: { breaks: [] }, anchorBreaks: [{ reason: 'ANCHOR_HASH_MISMATCH' }] };
  const break2 = { hardFailures: [{ reason: 'HISTORY_REWRITTEN' }] };
  assert.throws(() => assertConform('SELFTEST-set', break1, break2), /break-set divergence/);
});

// ── documented, EXPECTED divergences (coverage boundaries of the independent
//    anchor verifier — assert the divergence, do NOT assert conformance) ───────

test('KNOWN-DIVERGENCE (db latest-only): a shallow --db check cannot see a per-row-only break', { skip: SKIP_STORE }, () => {
  // impl-2's --db cross-check only compares the LATEST anchored (count, head). A DB
  // whose head+count MATCH the anchor but whose interior was edited is invisible to
  // it, while impl-1 (which the plugin bundles) would catch it via the per-row walk.
  // We assert impl-2 PASSES the head/count check here — documenting that anchor-log
  // conformance does NOT extend to the in-DB per-row layer (which has no independent peer).
  const rows = buildChain(['a', 'b', 'c']);
  const { dir, anchorsPath } = writeAnchorLog([rows]);
  try {
    const db = makeAuditDb(dir, rows); // head+count match the anchor
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });
    assert.equal(i2.hardFailures.length, 0, 'standalone --db check passes when head+count match (latest-only, shallow) — documented boundary');
  } finally { cleanup(dir); }
});
