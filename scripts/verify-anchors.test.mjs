/**
 * Unit tests for scripts/verify-anchors.mjs — the standalone anchor verifier.
 *
 * Zero-dependency, like the tool it tests: uses only node:test + node:assert (the
 * built-in runner, no npm install). Run with `node --test scripts/verify-anchors.test.mjs`
 * or `npm run verify-anchors:test`.
 *
 * Fixtures are built inline (a valid 3-record log, a tampered anchorHash, a broken
 * prevAnchorHash link, an empty log) and written to a throwaway temp dir that is
 * `git init`-ed so the witness check runs deterministically. NOTHING touches
 * ~/.teamkb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { computeAnchorHash, readAnchors, verifyRecords, verify, UsageError } from './verify-anchors.mjs';

// ─── fixture builders ──────────────────────────────────────────────────────────

/** Build a well-formed anchor record: canonical body + correct anchorHash. */
function makeRecord({ anchoredAt, tenantId = 'test-tenant', chainedRows, chainHead, prevAnchorHash }) {
  const body = { schemaVersion: 1, anchoredAt, tenantId, chainedRows, chainHead, prevAnchorHash };
  return { ...body, anchorHash: computeAnchorHash(body) };
}

/** A valid, correctly-linked 3-record log. */
function validThreeRecords() {
  const r0 = makeRecord({
    anchoredAt: '2026-06-01T00:00:00.000Z',
    chainedRows: 10,
    chainHead: 'a'.repeat(64),
    prevAnchorHash: null,
  });
  const r1 = makeRecord({
    anchoredAt: '2026-06-02T00:00:00.000Z',
    chainedRows: 20,
    chainHead: 'b'.repeat(64),
    prevAnchorHash: r0.anchorHash,
  });
  const r2 = makeRecord({
    anchoredAt: '2026-06-03T00:00:00.000Z',
    chainedRows: 30,
    chainHead: 'c'.repeat(64),
    prevAnchorHash: r1.anchorHash,
  });
  return [r0, r1, r2];
}

/** Write records as JSONL into a fresh temp dir; git-init + commit so it is witnessed. */
function writeLog(records, { commit = true, addRemote = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-verify-test-'));
  const anchorsPath = join(dir, 'anchors.jsonl');
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  writeFileSync(anchorsPath, body);

  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  if (addRemote) git('remote', 'add', 'origin', 'https://example.com/fake.git');
  if (commit) {
    git('add', 'anchors.jsonl');
    git('commit', '-q', '-m', 'anchor');
  }
  return { dir, anchorsPath };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Seed a throwaway teamkb.db with an `audit_events(seq, entry_hash)` table — the
 * two columns the standalone verifier's --db cross-check reads: `chainedRows`
 * non-null rows (seq 1..N) whose highest-seq row's entry_hash == headHash. Built
 * with the sqlite3 CLI (the same binary the verifier shells out to), so the test
 * needs no native module. The intermediate rows carry distinct valid-hex dummy
 * hashes; only the count and the head matter to the cross-check.
 */
function makeAuditDb(dir, { chainedRows, headHash }) {
  const dbPath = join(dir, 'teamkb.db');
  const values = [];
  for (let i = 1; i <= chainedRows; i++) {
    const h = i === chainedRows ? headHash : i.toString(16).padStart(2, '0').repeat(32);
    values.push(`(${i}, '${h}')`);
  }
  const sql =
    'CREATE TABLE audit_events (seq INTEGER PRIMARY KEY, entry_hash TEXT);\n' +
    `INSERT INTO audit_events (seq, entry_hash) VALUES ${values.join(',')};`;
  const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${(r.stderr || '').trim()}`);
  return dbPath;
}

// ─── (a) a valid 3-record log ────────────────────────────────────────────────

test('(a) valid 3-record log — records verify clean; verdict is PASS with a remote', () => {
  const records = validThreeRecords();
  // record-level checks pass on their own
  assert.deepEqual(verifyRecords(records), []);

  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.verdict, 'PASS', JSON.stringify(res.findings));
    assert.equal(res.anchorCount, 3);
    assert.equal(res.hardFailures.length, 0);
    assert.equal(res.latest.chainedRows, 30);
  } finally {
    cleanup(dir);
  }
});

test('(a2) valid log committed but no remote — hard checks pass, WARN on unpushed witness', () => {
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: false });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.verdict, 'WARN');
    assert.equal(res.hardFailures.length, 0);
    assert.ok(res.warnings.some((w) => w.reason === 'UNPUSHED_LOCAL_WITNESS'));
  } finally {
    cleanup(dir);
  }
});

// ─── (b) a tampered anchorHash ───────────────────────────────────────────────

test('(b) tampered anchorHash — ANCHOR_HASH_MISMATCH, verdict FAIL, exit 1', () => {
  const records = validThreeRecords();
  // Edit a body field WITHOUT recomputing the stored anchorHash.
  records[1] = { ...records[1], chainedRows: 999 };

  const findings = verifyRecords(records);
  assert.ok(findings.some((f) => f.reason === 'ANCHOR_HASH_MISMATCH' && f.index === 1));

  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.verdict, 'FAIL');
    assert.ok(res.hardFailures.some((f) => f.reason === 'ANCHOR_HASH_MISMATCH'));
    // exit-code contract: the CLI exits 1 on FAIL
    assert.equal(exitCodeFor(anchorsPath, dir), 1);
  } finally {
    cleanup(dir);
  }
});

// ─── (c) a broken prevAnchorHash link ────────────────────────────────────────

test('(c) broken prevAnchorHash link — ANCHOR_LINK_MISMATCH, verdict FAIL', () => {
  const records = validThreeRecords();
  // Point r2 at the wrong previous hash, and re-seal it so the per-record hash
  // still matches (isolating the LINK break from a HASH break).
  const badBody = {
    schemaVersion: 1,
    anchoredAt: records[2].anchoredAt,
    tenantId: records[2].tenantId,
    chainedRows: records[2].chainedRows,
    chainHead: records[2].chainHead,
    prevAnchorHash: 'f'.repeat(64), // not r1.anchorHash
  };
  records[2] = { ...badBody, anchorHash: computeAnchorHash(badBody) };

  const findings = verifyRecords(records);
  assert.ok(findings.some((f) => f.reason === 'ANCHOR_LINK_MISMATCH' && f.index === 2));
  // and NOT a hash mismatch on r2 (we re-sealed it)
  assert.ok(!findings.some((f) => f.reason === 'ANCHOR_HASH_MISMATCH' && f.index === 2));

  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.verdict, 'FAIL');
    assert.ok(res.hardFailures.some((f) => f.reason === 'ANCHOR_LINK_MISMATCH'));
  } finally {
    cleanup(dir);
  }
});

test('(c2) first record with non-null prevAnchorHash is a link break', () => {
  const bad = makeRecord({
    anchoredAt: '2026-06-01T00:00:00.000Z',
    chainedRows: 5,
    chainHead: 'a'.repeat(64),
    prevAnchorHash: 'd'.repeat(64), // should be null at index 0
  });
  const findings = verifyRecords([bad]);
  assert.ok(findings.some((f) => f.reason === 'ANCHOR_LINK_MISMATCH' && f.index === 0));
});

test('(c3) regressed chainedRows is a hard failure', () => {
  const r0 = makeRecord({
    anchoredAt: '2026-06-01T00:00:00.000Z',
    chainedRows: 50,
    chainHead: 'a'.repeat(64),
    prevAnchorHash: null,
  });
  const r1 = makeRecord({
    anchoredAt: '2026-06-02T00:00:00.000Z',
    chainedRows: 40, // went backward
    chainHead: 'b'.repeat(64),
    prevAnchorHash: r0.anchorHash,
  });
  const findings = verifyRecords([r0, r1]);
  assert.ok(findings.some((f) => f.reason === 'ANCHOR_ROWS_REGRESSED' && f.index === 1));
});

// ─── (d) an empty log ────────────────────────────────────────────────────────

test('(d) empty log — no record failures; verdict driven only by witness', () => {
  assert.deepEqual(verifyRecords([]), []);

  const { dir, anchorsPath } = writeLog([], { commit: true, addRemote: true });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.anchorCount, 0);
    assert.equal(res.hardFailures.length, 0);
    assert.equal(res.latest, null);
    // empty + committed + remote => PASS (nothing broken to report)
    assert.equal(res.verdict, 'PASS');
  } finally {
    cleanup(dir);
  }
});

// ─── witness edge cases ──────────────────────────────────────────────────────

test('non-git audit dir — NO_EXTERNAL_WITNESS warning, still exit 0', () => {
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: false, addRemote: false });
  // remove the .git dir that writeLog created, to simulate a plain dir
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  try {
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.equal(res.verdict, 'WARN');
    assert.ok(res.warnings.some((w) => w.reason === 'NO_EXTERNAL_WITNESS'));
    assert.equal(res.hardFailures.length, 0);
    assert.equal(exitCodeFor(anchorsPath, dir), 0);
  } finally {
    cleanup(dir);
  }
});

test('uncommitted dirty anchor log — UNWITNESSED_LOCAL_EDIT warning', () => {
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  // dirty it AFTER commit
  writeFileSync(anchorsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n# trailing edit\n');
  try {
    // NB: that trailing '# trailing edit' line is not valid JSON, so readAnchors
    // would throw. Instead append a whole extra valid record to make it dirty-but-parseable.
    const extra = makeRecord({
      anchoredAt: '2026-06-04T00:00:00.000Z',
      chainedRows: 40,
      chainHead: 'e'.repeat(64),
      prevAnchorHash: records[2].anchorHash,
    });
    writeFileSync(
      anchorsPath,
      [...records, extra].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const res = verify({ anchors: anchorsPath, auditDir: dir, db: null });
    assert.ok(res.warnings.some((w) => w.reason === 'UNWITNESSED_LOCAL_EDIT'));
    assert.equal(res.hardFailures.length, 0);
  } finally {
    cleanup(dir);
  }
});

// ─── IO / usage ──────────────────────────────────────────────────────────────

test('missing anchors file — UsageError (exit 2 at CLI)', () => {
  assert.throws(
    () => readAnchors(join(tmpdir(), 'definitely-does-not-exist-anchors.jsonl')),
    UsageError,
  );
});

test('malformed JSON line — UsageError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-verify-test-'));
  const anchorsPath = join(dir, 'anchors.jsonl');
  writeFileSync(anchorsPath, '{not valid json}\n');
  try {
    assert.throws(() => readAnchors(anchorsPath), UsageError);
  } finally {
    cleanup(dir);
  }
});

// ─── end-to-end CLI exit-code check ──────────────────────────────────────────

/** Run the CLI as a subprocess and return its exit code. */
function exitCodeFor(anchorsPath, auditDir) {
  const scriptPath = new URL('./verify-anchors.mjs', import.meta.url).pathname;
  const r = spawnSync('node', [scriptPath, '--anchors', anchorsPath, '--audit-dir', auditDir], {
    encoding: 'utf8',
  });
  return r.status;
}

test('CLI exits 2 when the anchors file is missing', () => {
  const r = spawnSync(
    'node',
    [new URL('./verify-anchors.mjs', import.meta.url).pathname, '--anchors', join(tmpdir(), 'nope-anchors.jsonl')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2);
});

// A value-taking option must be followed by a real value — a trailing option, or
// one immediately followed by another flag, is a usage error (exit 2), not a
// silent undefined / flag-eaten-as-value. (Gemini review, PR #12.)
const CLI = new URL('./verify-anchors.mjs', import.meta.url).pathname;
for (const argv of [['--anchors'], ['--db'], ['--audit-dir'], ['--anchors', '--json'], ['--db', '--anchors', 'x']]) {
  test(`CLI exits 2 on missing value: [${argv.join(' ')}]`, () => {
    const r = spawnSync('node', [CLI, ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}`);
    assert.match(r.stderr + r.stdout, /requires an argument/);
  });
}

// ─── (e/f/g) the --db cross-check: the anchor as an EXTERNAL WITNESS ──────────
// Every test above passes db:null, so the whole reason the anchor exists — to
// catch a local rewrite the in-DB verifier cannot — was untested. These exercise
// verifyDbCrossCheck against a real sqlite audit_events table. The latest anchor
// (validThreeRecords → r2) froze { chainedRows: 30, chainHead: 'c'*64 }.

test('(e) --db cross-check PASSES when the live chain head matches the latest anchor', () => {
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const db = makeAuditDb(dir, { chainedRows: 30, headHash: 'c'.repeat(64) });
    const res = verify({ anchors: anchorsPath, auditDir: dir, db });
    assert.equal(res.verdict, 'PASS', JSON.stringify(res.findings));
    assert.equal(res.findings.filter((f) => f.reason === 'HISTORY_REWRITTEN').length, 0);
    // and the check actually RAN — not silently skipped
    assert.equal(res.findings.some((f) => f.reason === 'DB_CHECK_SKIPPED'), false);
  } finally {
    cleanup(dir);
  }
});

test('(f) re-hash-forward is CAUGHT BY THE ANCHOR though the DB chain is internally valid', () => {
  // The executable form of the README trust-model box: a local writer edits an
  // event and re-hashes the chain FORWARD — same row count, a new head that is
  // internally consistent, so the in-DB brain_audit_verify (which re-anchors on
  // each stored entry_hash) returns ok:true. The externally-committed anchor is
  // the ONLY witness that the head at the anchored position (30 rows) changed.
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const db = makeAuditDb(dir, { chainedRows: 30, headHash: 'f'.repeat(64) });
    const res = verify({ anchors: anchorsPath, auditDir: dir, db });
    const rewrite = res.findings.filter((f) => f.reason === 'HISTORY_REWRITTEN');
    assert.equal(rewrite.length, 1, JSON.stringify(res.findings));
    assert.match(rewrite[0].detail, /the head at the anchored position changed/);
    assert.equal(res.verdict, 'FAIL');
  } finally {
    cleanup(dir);
  }
});

test('(g) history truncation below the anchored position is caught by the anchor', () => {
  const records = validThreeRecords();
  const { dir, anchorsPath } = writeLog(records, { commit: true, addRemote: true });
  try {
    const db = makeAuditDb(dir, { chainedRows: 20, headHash: 'c'.repeat(64) });
    const res = verify({ anchors: anchorsPath, auditDir: dir, db });
    const rewrite = res.findings.filter((f) => f.reason === 'HISTORY_REWRITTEN');
    assert.equal(rewrite.length, 1, JSON.stringify(res.findings));
    assert.match(rewrite[0].detail, /history truncated/);
    assert.equal(res.verdict, 'FAIL');
  } finally {
    cleanup(dir);
  }
});
