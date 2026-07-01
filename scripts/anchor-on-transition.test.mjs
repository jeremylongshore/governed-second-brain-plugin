/**
 * Test for the shared external-anchor helper `anchorChainHead` (src/anchor.ts),
 * the write-path fix that re-anchors the audit chain head after every durable
 * audit write — specifically brain_transition (bead compile-then-govern-e06.1,
 * umbrella #27, risk 010-AT-RISK R3).
 *
 * Runs with the built-in runner (`node --test scripts/anchor-on-transition.test.mjs`).
 * The helper is TypeScript, so it is esbuild-transpiled (a devDep, the same
 * bundler build.mjs uses) to a throwaway .mjs at setup, then imported and driven
 * directly against a REAL seeded audit chain in a git-init-ed temp dir. NOTHING
 * touches ~/.teamkb.
 *
 * We drive the helper against a mock AuditRepository whose findAllChronological()
 * returns a valid hash chain — exactly how the store's own audit-anchor test
 * seeds one (@qmd-team-intent-kb/store/src/audit-anchor.test.ts) — because that
 * is the only method appendAnchor + verifyAnchors read. Growing the chain by one
 * row then calling the helper again models a brain_transition inserting its audit
 * row and re-anchoring right after.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import {
  appendAnchor,
  verifyAnchors,
  computeEntryHash,
  readAnchors,
} from '@qmd-team-intent-kb/store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ─── seed a REAL, valid audit hash chain ────────────────────────────────────────

/** Build a VALID hash chain (correct entry_hash + prev links) from a list of reasons. */
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

/** Minimal AuditRepository — appendAnchor + verifyAnchors only call findAllChronological. */
function mockRepo(rows) {
  return { findAllChronological: () => rows };
}

/** head entry_hash of a chain (what an anchor should snapshot). */
function chainHeadOf(rows) {
  const chained = rows.filter((r) => r.entry_hash !== null);
  return chained.length > 0 ? chained[chained.length - 1].entry_hash : '';
}

// ─── transpile the TS helper under test to a throwaway .mjs ──────────────────────

let anchorChainHead;

let helperTmpDir;

before(async () => {
  // Emit the transpiled helper INSIDE the repo tree so Node resolves the repo's
  // node_modules (@qmd-team-intent-kb/store) from it; a /tmp location cannot.
  helperTmpDir = mkdtempSync(join(REPO_ROOT, 'scripts', '.anchor-helper-'));
  const outfile = join(helperTmpDir, 'anchor.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'anchor.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Keep the store + node builtins external — we import the SAME store the app
    // uses, so the seeded mock repo type-matches appendAnchor at runtime.
    external: ['@qmd-team-intent-kb/*', 'node:*'],
    logLevel: 'silent',
  });
  ({ anchorChainHead } = await import(`file://${outfile}`));
  assert.equal(typeof anchorChainHead, 'function', 'anchorChainHead must be exported');
});

after(() => {
  if (helperTmpDir) rmSync(helperTmpDir, { recursive: true, force: true });
});

// ─── the test: re-anchor after a durable audit write (a transition) ─────────────

test('anchorChainHead re-anchors after a transition — log grows by one, head matches, verify passes', () => {
  // A throwaway "brain" base — its audit/ dir is created + git-init-ed by the helper.
  const basePath = mkdtempSync(join(tmpdir(), 'gsb-throwaway-brain-'));
  const anchorsPath = join(basePath, 'audit', 'anchors.jsonl');

  try {
    // 1. capture + govern → an initial promoted chain, anchored once (the govern pass).
    const governRows = buildChain(['seed-a', 'seed-b']);
    const first = anchorChainHead(mockRepo(governRows), basePath, 'local');

    assert.ok(first, 'govern-time anchor must succeed on a fresh brain');
    assert.equal(first.chainedRows, 2);
    assert.equal(first.chainHead, chainHeadOf(governRows), 'first anchor snapshots the govern head');
    assert.equal(readAnchors(anchorsPath).length, 1, 'anchor log has exactly one record after govern');
    // committed:true (best-effort git commit succeeded); no remote, so it is an
    // UNPUSHED_LOCAL_WITNESS — a local witness, not external tamper-evidence.
    assert.equal(first.committed, true, 'the anchor log was git-committed (local witness)');
    assert.ok(existsSync(join(basePath, 'audit', '.git')), 'audit dir is a git repo');

    // 2. brain_transition → its audit row is appended (chain grows by one durable row),
    //    then the fix re-anchors the head immediately.
    const afterTransitionRows = buildChain(['seed-a', 'seed-b', 'archived-transition']);
    const second = anchorChainHead(mockRepo(afterTransitionRows), basePath, 'local');

    assert.ok(second, 'transition-time anchor must succeed');

    // (a) the anchor log gained EXACTLY one record.
    assert.equal(readAnchors(anchorsPath).length, 2, 'transition adds exactly one anchor record');
    assert.equal(second.chainedRows, 3);

    // (b) its chainHead equals the current audit chain head AFTER the transition.
    assert.equal(
      second.chainHead,
      chainHeadOf(afterTransitionRows),
      'the transition anchor snapshots the post-transition chain head',
    );
    assert.notEqual(second.chainHead, first.chainHead, 'the head moved — the transition wrote a durable row');

    // (c) verifyAnchors still passes against the current chain.
    const result = verifyAnchors(mockRepo(afterTransitionRows), anchorsPath);
    assert.equal(result.ok, true, 'verifyAnchors passes after the transition re-anchor');
    assert.equal(result.anchorCount, 2);
    assert.equal(result.anchorBreaks.length, 0, 'no anchor breaks');
    assert.equal(result.chain.breaks.length, 0, 'no chain breaks');
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

test('anchorChainHead never throws on a bad base path — best-effort contract', () => {
  // A base path that cannot be created (a file where the dir should be) makes
  // mkdirSync throw internally; the helper must swallow it and return undefined,
  // never failing the caller's already-committed durable write.
  const filePath = mkdtempSync(join(tmpdir(), 'gsb-badbase-'));
  const brokenBase = join(filePath, 'not-a-dir-audit-parent');
  try {
    // Point basePath at a non-existent nested path under a path we then make
    // unwritable by using a base that is actually a file: create the file, then
    // treat it as a directory parent.
    const asFile = join(brokenBase, 'x');
    // brokenBase does not exist and its parent will be created recursively by
    // mkdirSync, so instead force failure by pointing at a path under /dev/null.
    const result = anchorChainHead(mockRepo(buildChain(['a'])), join('/dev/null', 'audit-parent'), 'local');
    assert.equal(result, undefined, 'a failed anchor returns undefined, never throws');
    void asFile;
  } finally {
    rmSync(filePath, { recursive: true, force: true });
  }
});
