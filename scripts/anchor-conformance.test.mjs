/**
 * anchor-conformance.test.mjs — two-implementation conformance for the audit
 * ANCHOR-LOG layer (bead compile-then-govern-6ps.11).
 *
 * ─── Why this is a TWO-verifier harness, not three ──────────────────────────────
 * The estate ships three things that can "verify the audit chain":
 *
 *   A = INTKB `verifyAnchors` (qmd-team-intent-kb/packages/store/src/audit-anchor.ts)
 *   B = the plugin's `brain_audit_verify` MCP tool (src/local-server.ts)
 *   C = the standalone `scripts/verify-anchors.mjs` (this repo, zero-dependency)
 *
 * A and B are NOT independent: `brain_audit_verify` esbuild-BUNDLES A's exact
 * bytes (`@qmd-team-intent-kb/store` is a `link:` dep inlined into
 * plugin-runtime/governed-brain.cjs) and only adds orchestration + a 3-state
 * message. So "B agrees with A" is a bundle-freshness DRIFT GUARD, never a
 * conformance signal — a tautology by construction. The one genuinely-independent
 * reimplementation is C, which imports NOTHING from INTKB or the plugin and
 * deliberately REPLICATES the canonical anchor-body hash byte-for-byte.
 *
 * A and C also do not verify the same artifact: A walks the in-DB per-row
 * entry_hash chain AND cross-checks the anchor log; C verifies ONLY the external
 * anchor log (+ a shallow, latest-anchor-only DB head/count cross-check). There is
 * therefore no single artifact all three independently verify. The ACHIEVABLE
 * conformance is a 2-implementation cross-check on the ANCHOR-LOG layer:
 *
 *   impl-1 = INTKB `verifyAnchors`   (also exactly what `brain_audit_verify` runs)
 *   impl-2 = standalone `verify-anchors.mjs`
 *
 * ONE shared fixture per case (a canonical anchor log written by the store's own
 * `appendAnchor`, plus a live-state view of the SAME rows) is fed to both. Each
 * mutates the shared fixture identically, then both must agree on a NORMALISED
 * break-bucket SET and on `ok`. See the design record for compile-then-govern-6ps.11.
 *
 * ─── What this does NOT cover (named honestly; see the xfail rows at the bottom) ─
 *   U1 CHAIN_FORK        — an in-DB per-row phenomenon; C has no per-row walk.
 *   U2 mixed v1/v2 rows  — per-row hash recompute is INTKB-only.
 *   U3 inner-anchor DB rewrite past a GROWN tail — C's --db check is latest-anchor
 *      -only, so it shallow-misses a rewrite below a since-grown chain.
 *   U4 mid-chain ENTRY_HASH_MISMATCH with head+count unchanged — C sees head+count
 *      only, so it misses it; A's per-row walk catches it.
 * These are real coverage boundaries of the independent anchor verifier, asserted
 * below as KNOWN-DIVERGENCE rows (we assert the divergence is expected — we do NOT
 * pretend the two agree).
 *
 * Run: `node --test scripts/anchor-conformance.test.mjs` (or `npm run conformance`).
 * Requires the sibling `@qmd-team-intent-kb` monorepo (the `link:` store dist) — it
 * self-SKIPS cleanly when that is absent (e.g. a fresh public CI checkout), exactly
 * like the full build/smoke, so it is a LOCAL-authoritative gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// impl-2: the standalone, independent reimplementation (same repo — in-process).
import {
  verify as standaloneVerify,
  computeAnchorHash as standaloneComputeAnchorHash,
} from './verify-anchors.mjs';

// impl-1: INTKB's real verifier, reached via the `link:` store dist ESM barrel.
// A missing sibling monorepo (public CI) makes this import throw → whole suite
// self-skips rather than erroring. `verifyAnchors` here is byte-identical to what
// the plugin's `brain_audit_verify` bundles and runs.
let store = null;
try {
  store = await import('@qmd-team-intent-kb/store');
} catch {
  store = null;
}
const SKIP = store
  ? false
  : 'requires the sibling @qmd-team-intent-kb monorepo (link: store dist) — local-only gate';

// ─── shared fixture builders ────────────────────────────────────────────────────

/**
 * Build a VALID in-DB hash chain from a list of reasons, using the STORE's own
 * `computeEntryHash` (copied from packages/store/src/audit-anchor.test.ts). The
 * chain is prefix-stable: row i depends only on rows 0..i, so
 * buildChain(['a','b','c'])[2].entry_hash === buildChain(['a','b','c','d'])[2].entry_hash.
 * That is what lets one anchor over a 3-row prefix stay consistent with a later
 * 5-row chain.
 */
function buildChain(reasons) {
  const { computeEntryHash } = store;
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

/** The minimal AuditRepository shape verifyAnchors/appendAnchor touch. */
function mockRepo(rows) {
  return { findAllChronological: () => rows };
}

/** A fresh throwaway dir. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'anchor-conform-'));
}

/**
 * Git-init the dir, add + commit anchors.jsonl, and attach a fake remote — so the
 * standalone's witness layer is NEUTRALISED to a clean PASS. The witness has no
 * impl-1 counterpart, so it must never influence the compared break-set. (It is
 * ALSO excluded from the normalised set below, belt-and-suspenders.)
 */
function commitAnchors(dir) {
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('remote', 'add', 'origin', 'https://example.com/fake.git');
  git('add', 'anchors.jsonl');
  git('commit', '-q', '-m', 'anchor');
}

/**
 * Seed a throwaway teamkb.db `audit_events(seq, entry_hash)` from a row set — the
 * two columns the standalone's --db cross-check reads (count of non-null +
 * highest-seq head). Built with the sqlite3 CLI (the same binary the verifier
 * shells out to), so no native module is needed. Copied from
 * scripts/verify-anchors.test.mjs `makeAuditDb`.
 */
function makeAuditDb(dir, rows) {
  const dbPath = join(dir, 'teamkb.db');
  const values = rows.map((r, i) => `(${i + 1}, '${r.entry_hash}')`);
  const sql =
    'CREATE TABLE audit_events (seq INTEGER PRIMARY KEY, entry_hash TEXT);\n' +
    `INSERT INTO audit_events (seq, entry_hash) VALUES ${values.join(',')};`;
  const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${(r.stderr || '').trim()}`);
  return dbPath;
}

/** Read the anchor JSONL back into records. */
function readAnchorLines(anchorsPath) {
  return readFileSync(anchorsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Write records back as JSONL (used after an in-place mutation). */
function writeAnchorLines(anchorsPath, records) {
  writeFileSync(anchorsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ─── normalisation: reason → order-independent canonical bucket SET ──────────────
//
// The two impls represent breaks with different shapes and, for the same physical
// event, sometimes different reason codes (the headline case: an anchored-rows
// shrink is HISTORY_TRUNCATED in impl-1 but HISTORY_REWRITTEN in impl-2). Fold both
// onto INTEGRITY buckets and compare the SET. Witness warnings + the DB-skipped
// note are dropped (no impl-1 counterpart).
const BUCKET = {
  ANCHOR_HASH_MISMATCH: 'ANCHOR_HASH_BROKEN',
  ANCHOR_LINK_MISMATCH: 'ANCHOR_LINK_BROKEN',
  ANCHOR_ROWS_REGRESSED: 'HISTORY_BROKEN',
  HISTORY_TRUNCATED: 'HISTORY_BROKEN',
  HISTORY_REWRITTEN: 'HISTORY_BROKEN',
  ENTRY_HASH_MISMATCH: 'CHAIN_TAMPER',
  PREV_LINK_MISMATCH: 'CHAIN_TAMPER',
  PREV_LINK_AND_ENTRY_HASH_MISMATCH: 'CHAIN_TAMPER',
  CHAIN_FORK: 'CHAIN_FORK',
};
function bucket(reason) {
  const b = BUCKET[reason];
  if (!b) throw new Error(`unmapped break reason: ${reason}`);
  return b;
}
function bucketSet(reasons) {
  return [...new Set(reasons.map(bucket))].sort();
}
/** impl-1 anchor-LAYER set: anchorBreaks only (chain.breaks have no standalone peer). */
function impl1Buckets(res) {
  return bucketSet(res.anchorBreaks.map((b) => b.reason));
}
/** impl-2 set: HARD failures only (drop witness warnings + the DB-skip note). */
function impl2Buckets(res) {
  return bucketSet(res.hardFailures.map((f) => f.reason));
}

/**
 * The conformance assertion shared by every conformable case:
 *   (a) impl1.ok === (impl2 has no hard failures)
 *   (b) normalised bucket SETs are identical, and equal the expected set
 *   (c) index alignment for the anchor-LOG-positioned buckets only
 *       (HISTORY_BROKEN is dropped — impl-2 tags DB findings with index -1)
 */
function assertConform(name, i1, i2, expected) {
  assert.equal(
    i1.ok,
    i2.hardFailures.length === 0,
    `${name}: ok/hard-failure agreement (impl1.ok=${i1.ok}, impl2.hard=${i2.hardFailures.length})`,
  );
  const b1 = impl1Buckets(i1);
  const b2 = impl2Buckets(i2);
  assert.deepEqual(b1, b2, `${name}: impl-1 buckets ${JSON.stringify(b1)} != impl-2 buckets ${JSON.stringify(b2)}`);
  assert.deepEqual(b1, [...expected].sort(), `${name}: bucket set != expected ${JSON.stringify(expected)}`);
  for (const B of ['ANCHOR_HASH_BROKEN', 'ANCHOR_LINK_BROKEN']) {
    if (expected.includes(B)) {
      const idx1 = i1.anchorBreaks.filter((b) => bucket(b.reason) === B).map((b) => b.index).sort();
      const idx2 = i2.hardFailures.filter((f) => bucket(f.reason) === B).map((f) => f.index).sort();
      assert.deepEqual(idx1, idx2, `${name}: index mismatch for ${B}`);
    }
  }
}

// ─── drift guard: the deliberate byte-for-byte replication really is identical ───

test('the standalone anchor-hash replication is byte-identical to the store', { skip: SKIP }, () => {
  const body = {
    schemaVersion: 1,
    anchoredAt: '2026-06-17T01:00:00.000Z',
    tenantId: 'local',
    chainedRows: 3,
    chainHead: 'a'.repeat(64),
    prevAnchorHash: null,
  };
  assert.equal(
    standaloneComputeAnchorHash(body),
    store.computeAnchorHash(body),
    'standalone computeAnchorHash diverged from the store — the independent replication drifted',
  );
});

// ─── PURE-LOG conformable cases (multi-anchor; impl-2 db=null → NOTE, not a fail) ─

test('CLEAN — 3-anchor log over a growing chain: both agree OK', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    // Three anchors over a 3 → 4 → 5 row growing chain.
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd', 'e'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T03:00:00.000Z',
    });
    commitAnchors(dir);

    const live = buildChain(['a', 'b', 'c', 'd', 'e']);
    const i1 = verifyAnchors(mockRepo(live), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });

    assert.equal(i1.ok, true);
    assert.equal(i2.hardFailures.length, 0);
    assertConform('CLEAN', i1, i2, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ANCHOR_HASH_TAMPER — edit an anchor body without resealing: both {ANCHOR_HASH_BROKEN}@1', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd', 'e'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T03:00:00.000Z',
    });

    // Corrupt anchor #1's tenantId in the JSONL, leaving its stored anchorHash
    // stale → an ANCHOR_HASH_MISMATCH, with no HISTORY/link side effects.
    const recs = readAnchorLines(anchorsPath);
    recs[1] = { ...recs[1], tenantId: 'SOMEONE-ELSE' };
    writeAnchorLines(anchorsPath, recs);
    commitAnchors(dir);

    const live = buildChain(['a', 'b', 'c', 'd', 'e']);
    const i1 = verifyAnchors(mockRepo(live), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });

    assertConform('ANCHOR_HASH_TAMPER', i1, i2, ['ANCHOR_HASH_BROKEN']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ANCHOR_LINK_TAMPER — reseal an anchor with a forged prev link: both {ANCHOR_LINK_BROKEN}@2', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors, computeAnchorHash } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd', 'e'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T03:00:00.000Z',
    });

    // Reseal anchor #2 with a forged prevAnchorHash and a RECOMPUTED anchorHash —
    // isolating a pure LINK break (no hash mismatch, no HISTORY change).
    const recs = readAnchorLines(anchorsPath);
    const body = {
      schemaVersion: recs[2].schemaVersion,
      anchoredAt: recs[2].anchoredAt,
      tenantId: recs[2].tenantId,
      chainedRows: recs[2].chainedRows,
      chainHead: recs[2].chainHead,
      prevAnchorHash: 'f'.repeat(64),
    };
    recs[2] = { ...body, anchorHash: computeAnchorHash(body) };
    writeAnchorLines(anchorsPath, recs);
    commitAnchors(dir);

    const live = buildChain(['a', 'b', 'c', 'd', 'e']);
    const i1 = verifyAnchors(mockRepo(live), anchorsPath);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db: null });

    assertConform('ANCHOR_LINK_TAMPER', i1, i2, ['ANCHOR_LINK_BROKEN']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── DB cases (SINGLE-anchor: latest == only, so deep & shallow examine the same
//     position; anchor log clean-committed; impl-2 gets a real --db) ─────────────

test('DB_HEAD_SWAP — re-hash-forward at the anchored head: both {HISTORY_BROKEN}', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    // Anchor a clean 3-row chain (head H).
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    commitAnchors(dir);

    // The live chain was edited at row 0 and re-hashed FORWARD: same row count, a
    // new internally-consistent head H'. verifyAuditChain alone is fooled; the
    // anchor is the only witness the head at the anchored position moved.
    const rewritten = buildChain(['TAMPERED', 'b', 'c']);
    const i1 = verifyAnchors(mockRepo(rewritten), anchorsPath);
    // sanity: the rewritten chain is internally valid (no per-row break)
    assert.equal(i1.chain.breaks.length, 0);

    const db = makeAuditDb(dir, rewritten); // count 3, head H'
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    assertConform('DB_HEAD_SWAP', i1, i2, ['HISTORY_BROKEN']);
    // impl-1 says HISTORY_REWRITTEN; impl-2 says HISTORY_REWRITTEN (head moved).
    assert.ok(i1.anchorBreaks.some((b) => b.reason === 'HISTORY_REWRITTEN'));
    assert.ok(i2.hardFailures.some((f) => f.reason === 'HISTORY_REWRITTEN'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DB_TRUNCATE — rows deleted below the anchored count: both {HISTORY_BROKEN} (reason codes DIVERGE → normalised)', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    commitAnchors(dir);

    const truncated = buildChain(['a', 'b']); // 2 rows < anchored 3
    const i1 = verifyAnchors(mockRepo(truncated), anchorsPath);
    const db = makeAuditDb(dir, truncated); // count 2
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    assertConform('DB_TRUNCATE', i1, i2, ['HISTORY_BROKEN']);
    // The headline normalisation: DIFFERENT reason codes, SAME bucket.
    assert.ok(
      i1.anchorBreaks.some((b) => b.reason === 'HISTORY_TRUNCATED'),
      'impl-1 should emit HISTORY_TRUNCATED',
    );
    assert.ok(
      i2.hardFailures.some((f) => f.reason === 'HISTORY_REWRITTEN'),
      'impl-2 should emit HISTORY_REWRITTEN (chainedRows > current)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIXED — anchor-body edit AND a DB head-swap: both {ANCHOR_HASH_BROKEN, HISTORY_BROKEN}', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    // Edit the anchor's tenantId (stale hash) — but NOT its chainHead — then commit.
    const recs = readAnchorLines(anchorsPath);
    recs[0] = { ...recs[0], tenantId: 'SOMEONE-ELSE' };
    writeAnchorLines(anchorsPath, recs);
    commitAnchors(dir);

    const rewritten = buildChain(['TAMPERED', 'b', 'c']); // head moved
    const i1 = verifyAnchors(mockRepo(rewritten), anchorsPath);
    const db = makeAuditDb(dir, rewritten);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    assertConform('MIXED', i1, i2, ['ANCHOR_HASH_BROKEN', 'HISTORY_BROKEN']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── NEGATIVE / MUTATION experiment — the comparator is NOT vacuous ──────────────
// Proves the conformance assertion REJECTS a divergence. If either verifier is made
// to disagree with the other, assertConform throws. (This is the in-suite guarantee;
// the design's catchesFailure also corrupts a real case externally and captures the
// failing `node --test` output.)

test('meta — assertConform REJECTS an impl-2-only break (ok booleans diverge)', () => {
  assert.throws(
    () =>
      assertConform(
        'divergent',
        { ok: true, anchorBreaks: [], hardFailures: [] }, // impl-1: clean
        { ok: false, anchorBreaks: [], hardFailures: [{ index: -1, reason: 'HISTORY_REWRITTEN' }] }, // impl-2: broken
        [],
      ),
    /ok\/hard-failure agreement/,
  );
});

test('meta — assertConform REJECTS a bucket-set divergence (same ok, different break class)', () => {
  assert.throws(
    () =>
      assertConform(
        'divergent2',
        { ok: false, anchorBreaks: [{ index: 1, reason: 'ANCHOR_HASH_MISMATCH' }], hardFailures: [] },
        { ok: false, anchorBreaks: [], hardFailures: [{ index: 2, reason: 'ANCHOR_LINK_MISMATCH' }] },
        ['ANCHOR_HASH_BROKEN'],
      ),
    /impl-1 buckets .* != impl-2 buckets/,
  );
});

test('meta — assertConform REJECTS an anchor-index divergence (same bucket, different position)', () => {
  assert.throws(
    () =>
      assertConform(
        'divergent3',
        { ok: false, anchorBreaks: [{ index: 1, reason: 'ANCHOR_HASH_MISMATCH' }], hardFailures: [] },
        { ok: false, anchorBreaks: [], hardFailures: [{ index: 3, reason: 'ANCHOR_HASH_MISMATCH' }] },
        ['ANCHOR_HASH_BROKEN'],
      ),
    /index mismatch for ANCHOR_HASH_BROKEN/,
  );
});

// ─── NAMED-UNCOVERED / KNOWN-DIVERGENCE rows (assert the divergence is EXPECTED) ──
// These are phenomena the independent standalone verifier CANNOT reproduce, so they
// are NOT conformable. We assert the boundary explicitly rather than pretend
// agreement: impl-1 catches, impl-2 is silent by design.

test('U1 CHAIN_FORK — impl-1 catches (chain layer); impl-2 has no per-row peer (KNOWN DIVERGENCE)', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors, computeEntryHash } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    // A non-linear ordering fork: r2's prev_entry_hash points back at r0 (a real,
    // already-walked intact row), not its immediate predecessor r1. Every hash is
    // intact — this is CHAIN_FORK, not tampering (bead yxp).
    const base = buildChain(['a', 'b']); // r0, r1
    const r2base = {
      id: 'id-2',
      action: 'promoted',
      memory_id: 'mem-2',
      tenant_id: 'local',
      actor_json: '{"type":"ai","id":"curator"}',
      reason: 'c',
      details_json: '{}',
      timestamp: '2026-06-17T00:00:02.000Z',
      hash_version: 2,
      prev_entry_hash: base[0].entry_hash, // fork: links past r1 back to r0
    };
    const forked = [...base, { ...r2base, entry_hash: computeEntryHash(r2base) }];

    appendAnchor(mockRepo(forked), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    commitAnchors(dir);

    const i1 = verifyAnchors(mockRepo(forked), anchorsPath);
    const db = makeAuditDb(dir, forked);
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    // impl-1 fails via the in-DB chain walk (CHAIN_FORK), but its ANCHOR layer is
    // clean; impl-2 (anchor + head/count only) sees nothing wrong.
    assert.equal(i1.chain.breaks.some((b) => b.reason === 'CHAIN_FORK'), true);
    assert.equal(i1.ok, false);
    assert.deepEqual(impl1Buckets(i1), []); // anchor layer clean
    assert.equal(i2.hardFailures.length, 0); // standalone: clean
    // The divergence the two impls CANNOT reconcile: ok booleans disagree.
    assert.notEqual(i1.ok, i2.hardFailures.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U3 inner-anchor DB rewrite below a GROWN tail — impl-1 catches every anchor; impl-2 --db is latest-anchor-only (KNOWN DIVERGENCE)', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    // Two anchors: one at 3 rows, one at 5 rows.
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    appendAnchor(mockRepo(buildChain(['a', 'b', 'c', 'd', 'e'])), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T02:00:00.000Z',
    });
    commitAnchors(dir);

    // History rewritten at row 0 AND the chain has since GROWN to 7 rows. Every
    // anchored head (rows 3 and 5) moved, but the current count (7) exceeds the
    // LATEST anchor's count (5) → the standalone's --db check treats it as "chain
    // grew normally" and does not re-examine the anchored position.
    const rewrittenGrown = buildChain(['TAMPERED', 'b', 'c', 'd', 'e', 'f', 'g']);
    const i1 = verifyAnchors(mockRepo(rewrittenGrown), anchorsPath);
    const db = makeAuditDb(dir, rewrittenGrown); // count 7
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    // impl-1 catches HISTORY_REWRITTEN at BOTH anchored positions.
    assert.equal(i1.anchorBreaks.filter((b) => b.reason === 'HISTORY_REWRITTEN').length, 2);
    assert.equal(i1.ok, false);
    assert.deepEqual(impl1Buckets(i1), ['HISTORY_BROKEN']);
    // impl-2 shallow-misses: latest anchor (5) < current (7) → "grew", no check.
    assert.equal(i2.hardFailures.length, 0);
    assert.notEqual(i1.ok, i2.hardFailures.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U4 mid-chain ENTRY_HASH_MISMATCH with head+count unchanged — impl-1 catches; impl-2 (head+count only) misses (KNOWN DIVERGENCE)', { skip: SKIP }, () => {
  const { appendAnchor, verifyAnchors } = store;
  const dir = makeDir();
  const anchorsPath = join(dir, 'anchors.jsonl');
  try {
    const rows = buildChain(['a', 'b', 'c', 'd', 'e']); // 5 rows, head unchanged below
    appendAnchor(mockRepo(rows), anchorsPath, {
      tenantId: 'local',
      nowFn: () => '2026-06-17T01:00:00.000Z',
    });
    commitAnchors(dir);

    // Corrupt a MIDDLE row's stored entry_hash only — head (row 4) and count (5)
    // are untouched, so the anchor's head/count cross-check still matches.
    const tampered = rows.map((r) => ({ ...r }));
    tampered[2] = { ...tampered[2], entry_hash: 'd'.repeat(64) };

    const i1 = verifyAnchors(mockRepo(tampered), anchorsPath);
    const db = makeAuditDb(dir, rows); // count 5, head = the ORIGINAL head (unchanged)
    const i2 = standaloneVerify({ anchors: anchorsPath, auditDir: dir, db });

    // impl-1's per-row walk catches the entry-hash + downstream prev-link breaks.
    assert.ok(i1.chain.breaks.some((b) => b.reason === 'ENTRY_HASH_MISMATCH'));
    assert.equal(i1.ok, false);
    assert.deepEqual(impl1Buckets(i1), []); // anchor head/count still consistent
    // impl-2 sees only head + count, both unchanged → clean.
    assert.equal(i2.hardFailures.length, 0);
    assert.notEqual(i1.ok, i2.hardFailures.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// U2 (mixed v1/v2 rows) is a per-row hash-recompute phenomenon: verifyAuditChain
// re-derives each row under its own hash_version, a walk the standalone verifier
// does NOT perform (it has no per-row peer at all — only anchor + head/count). It is
// therefore in the same NOT-CONFORMABLE class as U1/U4 and is covered by INTKB's own
// unit tests (packages/store/src/audit-verify*.test.ts), not here.
