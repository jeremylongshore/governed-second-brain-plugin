#!/usr/bin/env node
/**
 * verify-anchors.mjs — a standalone, zero-dependency anchor-log verifier.
 *
 * "Don't trust us — run it yourself." This is the INDEPENDENT counterpart to the
 * in-box `brain_audit_verify` tool. That tool lives inside the same codebase that
 * WROTE the chain (circular trust); this script re-derives every anchor hash from
 * scratch, importing NOTHING from INTKB or the plugin's own audit code. A skeptic
 * can drop this one file next to a copy of `~/.teamkb/audit/anchors.jsonl` and
 * confirm the externally-committed anchor log is internally consistent, witnessed
 * by git, and — optionally — still consistent with the live audit DB.
 *
 * It is the `cat log.md` of receipts: node built-ins only (crypto, fs, child_process),
 * no npm imports, no build step. If you can run `node`, you can verify.
 *
 * --------------------------------------------------------------------------------
 * The anchor log format (an append-only, hash-chained JSONL file). Each line is an
 * AnchorRecord:
 *
 *   { schemaVersion: 1, anchoredAt: <ISO8601>, tenantId: <string>,
 *     chainedRows: <int>, chainHead: <hex entry_hash or "">,
 *     prevAnchorHash: <hex or null>, anchorHash: <hex> }
 *
 * anchorHash = sha256hex( JSON.stringify({schemaVersion, anchoredAt, tenantId,
 *              chainedRows, chainHead, prevAnchorHash}) )  — that EXACT key order,
 * with the `anchorHash` field itself EXCLUDED from the hashed body.
 *
 * This canonical body serialisation is REPLICATED here on purpose (see
 * bobs-big-brain-registrar/packages/store/src/audit-anchor.ts `anchorBodyJson` /
 * `computeAnchorHash`) — it is deliberately NOT imported, so verification does not
 * depend on the code under audit.
 * --------------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/verify-anchors.mjs [--anchors <path>] [--audit-dir <dir>] [--db <path>] [--json]
 *
 * Defaults:
 *   --anchors    $HOME/.teamkb/audit/anchors.jsonl
 *   --audit-dir  the parent dir of --anchors
 *   --db         (unset — DB cross-check skipped unless provided)
 *
 * Exit codes:
 *   0  per-record + linkage checks pass AND (DB check skipped or passes).
 *      Witness warnings alone still exit 0 (WARN).
 *   1  a hard failure (bad anchorHash, broken link, regressed rows, or a
 *      DB cross-check failure — history rewritten).
 *   2  a usage / IO error (e.g. anchors file missing or unparseable).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── argument parsing (no deps) ───────────────────────────────────────────────

function parseArgs(argv) {
  const out = { anchors: null, auditDir: null, db: null, json: false, help: false };
  // A value-taking option must be followed by a real value — not the end of the
  // args and not another flag. Otherwise `--anchors --json` would silently eat
  // `--json` as the path, and a trailing `--db` would set it to undefined.
  const take = (i, opt) => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('-')) {
      throw new UsageError(`option ${opt} requires an argument`);
    }
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--anchors') { out.anchors = take(i, '--anchors'); i++; }
    else if (a === '--audit-dir') { out.auditDir = take(i, '--audit-dir'); i++; }
    else if (a === '--db') { out.db = take(i, '--db'); i++; }
    else if (a.startsWith('--anchors=')) out.anchors = a.slice('--anchors='.length);
    else if (a.startsWith('--audit-dir=')) out.auditDir = a.slice('--audit-dir='.length);
    else if (a.startsWith('--db=')) out.db = a.slice('--db='.length);
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return out;
}

class UsageError extends Error {}

const HELP = `verify-anchors — standalone, zero-dependency audit-anchor verifier

Usage:
  node scripts/verify-anchors.mjs [--anchors <path>] [--audit-dir <dir>] [--db <path>] [--json]

Options:
  --anchors <path>    Path to anchors.jsonl  (default: $HOME/.teamkb/audit/anchors.jsonl)
  --audit-dir <dir>   Git repo dir that witnesses the anchor log  (default: parent of --anchors)
  --db <path>         Optional teamkb.db to cross-check the live chain head against the
                      latest anchor (requires sqlite3 on PATH; skipped otherwise)
  --json              Emit a machine-readable JSON object instead of the human summary
  -h, --help          Show this help

Checks: per-record anchorHash integrity, append-only chain linkage + non-decreasing
chainedRows, git witness of the log, and (optional) a DB cross-check for silent
history rewrites. Exit 0 on pass (warnings allowed), non-zero on any hard failure.`;

// ─── canonical anchor-hash re-derivation (replicated, NOT imported) ────────────

/**
 * Re-serialise the canonical anchor body with the EXACT key order the writer
 * uses, then sha256-hex it. The `anchorHash` field is intentionally excluded.
 * This mirrors audit-anchor.ts `anchorBodyJson` byte-for-byte, on purpose.
 */
function computeAnchorHash(rec) {
  const body = JSON.stringify({
    schemaVersion: rec.schemaVersion,
    anchoredAt: rec.anchoredAt,
    tenantId: rec.tenantId,
    chainedRows: rec.chainedRows,
    chainHead: rec.chainHead,
    prevAnchorHash: rec.prevAnchorHash,
  });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// ─── anchor-log parsing ────────────────────────────────────────────────────────

/** Parse the append-only anchor log into records. Throws UsageError on IO/parse failure. */
function readAnchors(anchorPath) {
  if (!existsSync(anchorPath)) {
    throw new UsageError(`anchors file not found: ${anchorPath}`);
  }
  let raw;
  try {
    raw = readFileSync(anchorPath, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read anchors file ${anchorPath}: ${e.message}`);
  }
  const lines = raw.split('\n').map((l, i) => ({ text: l, lineNo: i + 1 })).filter((l) => l.text.trim().length > 0);
  const records = [];
  for (const { text, lineNo } of lines) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`anchors line ${lineNo} is not valid JSON: ${e.message}`);
    }
    records.push(rec);
  }
  return records;
}

// ─── core verification ─────────────────────────────────────────────────────────

const HARD_REASONS = new Set([
  'ANCHOR_HASH_MISMATCH',
  'ANCHOR_LINK_MISMATCH',
  'ANCHOR_ROWS_REGRESSED',
  'HISTORY_REWRITTEN',
]);

const WARN_REASONS = new Set([
  'UNWITNESSED_LOCAL_EDIT',
  'NO_EXTERNAL_WITNESS',
  'UNPUSHED_LOCAL_WITNESS',
]);

// A skipped optional DB cross-check is a NOTE, not a warning — it must not demote
// the verdict (the exit contract is "exit 0 when DB check skipped or passes").
const NOTE_REASONS = new Set(['DB_CHECK_SKIPPED']);

function short(hex) {
  return typeof hex === 'string' && hex.length > 0 ? hex.slice(0, 12) : '(empty)';
}

/** Per-record integrity + chain linkage + non-decreasing chainedRows. */
function verifyRecords(records) {
  const findings = [];
  let expectedPrev = null; // record[0].prevAnchorHash must be null
  let prevRows = -1;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];

    // Shape sanity — a malformed record is itself a hard failure.
    if (
      r == null ||
      typeof r !== 'object' ||
      typeof r.anchorHash !== 'string' ||
      typeof r.anchoredAt !== 'string' ||
      typeof r.chainedRows !== 'number' ||
      typeof r.chainHead !== 'string' ||
      (r.prevAnchorHash !== null && typeof r.prevAnchorHash !== 'string')
    ) {
      findings.push({
        index: i,
        anchoredAt: r?.anchoredAt ?? '(unknown)',
        reason: 'ANCHOR_HASH_MISMATCH',
        detail: 'anchor record is missing required fields or has wrong types',
      });
      // Can't chain-check a malformed record reliably; keep going but reset expectation.
      expectedPrev = typeof r?.anchorHash === 'string' ? r.anchorHash : expectedPrev;
      continue;
    }

    // 1. Per-record integrity: recompute anchorHash from the canonical body.
    const recomputed = computeAnchorHash(r);
    if (recomputed !== r.anchorHash) {
      findings.push({
        index: i,
        anchoredAt: r.anchoredAt,
        reason: 'ANCHOR_HASH_MISMATCH',
        detail: `recomputed ${short(recomputed)} != stored ${short(r.anchorHash)} — record content was edited`,
      });
    }

    // 2a. Chain linkage: prevAnchorHash must point at the prior record's anchorHash
    //     (null for the first record).
    if (r.prevAnchorHash !== expectedPrev) {
      findings.push({
        index: i,
        anchoredAt: r.anchoredAt,
        reason: 'ANCHOR_LINK_MISMATCH',
        detail: `prevAnchorHash ${r.prevAnchorHash === null ? 'null' : short(r.prevAnchorHash)} != expected ${expectedPrev === null ? 'null' : short(expectedPrev)} — log reordered/spliced`,
      });
    }
    expectedPrev = r.anchorHash;

    // 2b. chainedRows must be non-decreasing (an append-only chain never shrinks).
    if (r.chainedRows < prevRows) {
      findings.push({
        index: i,
        anchoredAt: r.anchoredAt,
        reason: 'ANCHOR_ROWS_REGRESSED',
        detail: `chainedRows ${r.chainedRows} < previous ${prevRows} — anchored row count went backward`,
      });
    }
    prevRows = r.chainedRows;
  }

  return findings;
}

// ─── external witness (git) ────────────────────────────────────────────────────

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Confirm the anchor log is committed to git in `auditDir` and has no uncommitted
 * rewrite. An un-pushed/dirty anchor is only *locally* witnessed — a warning, not a
 * hard fail. If the dir is not a git repo at all, there is no external witness.
 */
function verifyWitness(auditDir, anchorFileName) {
  const findings = [];
  const witness = { isGitRepo: false, tracked: false, clean: false, hasRemote: false, headCommit: null };

  const inside = runGit(auditDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || (inside.stdout || '').trim() !== 'true') {
    findings.push({
      index: -1,
      anchoredAt: '',
      reason: 'NO_EXTERNAL_WITNESS',
      detail: `${auditDir} is not a git repo — the anchor log has no external witness (a local file alone can be silently rewritten).`,
    });
    return { findings, witness };
  }
  witness.isGitRepo = true;

  const ls = runGit(auditDir, ['ls-files', '--error-unmatch', '--', anchorFileName]);
  witness.tracked = ls.status === 0;

  const st = runGit(auditDir, ['status', '--porcelain', '--', anchorFileName]);
  const dirty = st.status === 0 ? (st.stdout || '').trim().length > 0 : true;
  witness.clean = witness.tracked && !dirty;

  const rem = runGit(auditDir, ['remote']);
  witness.hasRemote = rem.status === 0 && (rem.stdout || '').trim().length > 0;

  const head = runGit(auditDir, ['rev-parse', '--short', 'HEAD']);
  if (head.status === 0) witness.headCommit = (head.stdout || '').trim() || null;

  if (!witness.tracked) {
    findings.push({
      index: -1,
      anchoredAt: '',
      reason: 'UNWITNESSED_LOCAL_EDIT',
      detail: `${anchorFileName} is not tracked by git in ${auditDir} — not committed, so only locally witnessed.`,
    });
  } else if (dirty) {
    findings.push({
      index: -1,
      anchoredAt: '',
      reason: 'UNWITNESSED_LOCAL_EDIT',
      detail: `${anchorFileName} has uncommitted changes in ${auditDir} — a pending local rewrite is not yet externally witnessed.`,
    });
  } else if (!witness.hasRemote) {
    // Committed cleanly, but with no remote the anchor log has only been
    // witnessed by the local git object store. Push it to a remote an offline
    // editor cannot quietly rewrite to make it externally tamper-evident.
    findings.push({
      index: -1,
      anchoredAt: '',
      reason: 'UNPUSHED_LOCAL_WITNESS',
      detail: `${anchorFileName} is committed in ${auditDir} but that repo has no remote — the log is only locally witnessed until pushed.`,
    });
  }

  return { findings, witness };
}

// ─── optional DB cross-check ───────────────────────────────────────────────────

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

function sqlite3Query(dbPath, sql) {
  // Read-only, batch mode. -readonly guarantees we never mutate ~/.teamkb.
  const r = spawnSync('sqlite3', ['-readonly', '-batch', '-noheader', dbPath, sql], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`sqlite3 failed (${r.status}): ${(r.stderr || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

/**
 * Cross-check the LATEST anchor against the live audit chain in the DB. The chain
 * orders by `seq ASC` (not timestamp/id — see the yxp fix); the head is the
 * entry_hash of the max-seq chained row, and chainedRows = count where
 * entry_hash IS NOT NULL. The latest anchor's chainHead must equal the current
 * head, and its chainedRows must be <= the current count (else history moved
 * backward vs what was anchored — HISTORY_REWRITTEN).
 */
function verifyDbCrossCheck(dbPath, latestAnchor) {
  const findings = [];
  const info = { checked: false, note: null, currentChainedRows: null, currentHead: null };

  if (!dbPath) {
    info.note = 'no --db provided; DB cross-check skipped';
    findings.push({ index: -1, anchoredAt: '', reason: 'DB_CHECK_SKIPPED', detail: info.note });
    return { findings, info };
  }
  if (!existsSync(dbPath)) {
    info.note = `--db ${dbPath} does not exist; DB cross-check skipped`;
    findings.push({ index: -1, anchoredAt: '', reason: 'DB_CHECK_SKIPPED', detail: info.note });
    return { findings, info };
  }
  if (!which('sqlite3')) {
    info.note = 'sqlite3 not on PATH; DB cross-check skipped';
    findings.push({ index: -1, anchoredAt: '', reason: 'DB_CHECK_SKIPPED', detail: info.note });
    return { findings, info };
  }

  let count, head;
  try {
    count = sqlite3Query(dbPath, 'SELECT count(*) FROM audit_events WHERE entry_hash IS NOT NULL;');
    // Head of the live chain = entry_hash of the highest-seq chained row.
    head = sqlite3Query(
      dbPath,
      'SELECT entry_hash FROM audit_events WHERE entry_hash IS NOT NULL ORDER BY seq DESC LIMIT 1;',
    );
  } catch (e) {
    info.note = `sqlite3 query failed (${e.message}); DB cross-check skipped`;
    findings.push({ index: -1, anchoredAt: '', reason: 'DB_CHECK_SKIPPED', detail: info.note });
    return { findings, info };
  }

  const currentChainedRows = Number.parseInt(count, 10);
  const currentHead = head; // may be '' if there are no chained rows
  info.checked = true;
  info.currentChainedRows = currentChainedRows;
  info.currentHead = currentHead;

  if (!latestAnchor) {
    info.note = 'no anchors to cross-check against the DB';
    return { findings, info };
  }

  // The anchor snapshotted the head at chainedRows position. If the chain has
  // grown, we cannot re-check that exact historical head from the tail alone —
  // but we CAN catch the specific rewrite the anchor exists to catch: when the
  // anchored row count exceeds the current count (history truncated), or when the
  // anchored count equals the current count but the head differs (head at the
  // anchored position changed).
  if (latestAnchor.chainedRows > currentChainedRows) {
    findings.push({
      index: -1,
      anchoredAt: latestAnchor.anchoredAt,
      reason: 'HISTORY_REWRITTEN',
      detail: `latest anchor recorded ${latestAnchor.chainedRows} chained rows but the DB now has only ${currentChainedRows} — history truncated below the anchored position.`,
    });
  } else if (latestAnchor.chainedRows === currentChainedRows && latestAnchor.chainHead !== currentHead) {
    findings.push({
      index: -1,
      anchoredAt: latestAnchor.anchoredAt,
      reason: 'HISTORY_REWRITTEN',
      detail: `at the anchored row count (${currentChainedRows}) the DB head is ${short(currentHead)} but the anchor froze ${short(latestAnchor.chainHead)} — the head at the anchored position changed.`,
    });
  }
  // latestAnchor.chainedRows < currentChainedRows is the normal "chain grew since
  // the last anchor" case — not a failure.

  return { findings, info };
}

// ─── orchestration ─────────────────────────────────────────────────────────────

function verify(opts) {
  const anchorsPath = isAbsolute(opts.anchors) ? opts.anchors : resolve(process.cwd(), opts.anchors);
  const auditDir = opts.auditDir
    ? isAbsolute(opts.auditDir)
      ? opts.auditDir
      : resolve(process.cwd(), opts.auditDir)
    : dirname(anchorsPath);
  const anchorFileName = basename(anchorsPath);

  const records = readAnchors(anchorsPath);

  const recordFindings = verifyRecords(records);
  const { findings: witnessFindings, witness } = verifyWitness(auditDir, anchorFileName);
  const latestAnchor = records.length > 0 ? records[records.length - 1] : null;
  const { findings: dbFindings, info: dbInfo } = verifyDbCrossCheck(opts.db ?? null, latestAnchor);

  const findings = [...recordFindings, ...witnessFindings, ...dbFindings];
  const hard = findings.filter((f) => HARD_REASONS.has(f.reason));
  const warn = findings.filter((f) => WARN_REASONS.has(f.reason));
  const notes = findings.filter((f) => NOTE_REASONS.has(f.reason));

  const verdict = hard.length > 0 ? 'FAIL' : warn.length > 0 ? 'WARN' : 'PASS';

  return {
    verdict,
    anchorsPath,
    auditDir,
    anchorCount: records.length,
    latest: latestAnchor
      ? {
          anchoredAt: latestAnchor.anchoredAt,
          tenantId: latestAnchor.tenantId,
          chainedRows: latestAnchor.chainedRows,
          chainHead: latestAnchor.chainHead,
          chainHeadShort: short(latestAnchor.chainHead),
        }
      : null,
    witness,
    db: dbInfo,
    hardFailures: hard,
    warnings: warn,
    notes,
    findings,
  };
}

// ─── reporting ─────────────────────────────────────────────────────────────────

function printHuman(res) {
  const lines = [];
  const badge = res.verdict === 'PASS' ? '✓ PASS' : res.verdict === 'WARN' ? '⚠ WARN' : '✗ FAIL';
  lines.push(`${badge} — standalone anchor-log verification`);
  lines.push('');
  lines.push(`  anchors file : ${res.anchorsPath}`);
  lines.push(`  audit dir    : ${res.auditDir}`);
  lines.push(`  anchors      : ${res.anchorCount}`);
  if (res.latest) {
    lines.push(`  latest anchor: ${res.latest.anchoredAt}  tenant=${res.latest.tenantId}`);
    lines.push(`  chained rows : ${res.latest.chainedRows}`);
    lines.push(`  chain head   : ${res.latest.chainHeadShort}…`);
  }
  // witness
  const w = res.witness;
  let witnessLine;
  if (!w.isGitRepo) witnessLine = 'no (audit dir is not a git repo)';
  else if (!w.tracked) witnessLine = 'no (anchor log not tracked by git)';
  else if (!w.clean) witnessLine = 'partial (tracked but uncommitted changes present)';
  else witnessLine = w.hasRemote ? `yes (git, committed, remote present; HEAD ${w.headCommit})` : `local-only (git committed at ${w.headCommit}, no remote — push to be externally witnessed)`;
  lines.push(`  witnessed    : ${witnessLine}`);
  // db
  if (res.db.checked) {
    lines.push(`  db crosscheck: chained rows=${res.db.currentChainedRows}, head=${short(res.db.currentHead)}…`);
  } else if (res.db.note) {
    lines.push(`  db crosscheck: skipped (${res.db.note})`);
  }

  if (res.hardFailures.length > 0) {
    lines.push('');
    lines.push(`  HARD FAILURES (${res.hardFailures.length}):`);
    for (const f of res.hardFailures) {
      const at = f.index >= 0 ? `record[${f.index}]` : 'log';
      lines.push(`    ✗ ${f.reason} @ ${at}: ${f.detail}`);
    }
  }
  if (res.warnings.length > 0) {
    lines.push('');
    lines.push(`  WARNINGS (${res.warnings.length}):`);
    for (const f of res.warnings) {
      lines.push(`    ⚠ ${f.reason}: ${f.detail}`);
    }
  }

  lines.push('');
  if (res.verdict === 'PASS') {
    lines.push('  Every anchor hash re-derives, the log links cleanly, and the log is git-witnessed.');
  } else if (res.verdict === 'WARN') {
    lines.push('  Anchor integrity + linkage are intact, but the witness is incomplete (see warnings).');
  } else {
    lines.push('  Anchor integrity or linkage is BROKEN — do not trust this anchor log.');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── main ──────────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }
  if (!opts.anchors) {
    opts.anchors = join(homedir(), '.teamkb', 'audit', 'anchors.jsonl');
  }

  let res;
  try {
    res = verify(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ verdict: 'ERROR', error: e.message }, null, 2) + '\n');
      } else {
        process.stderr.write(`✗ ERROR: ${e.message}\n`);
      }
      process.exit(2);
    }
    throw e;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    printHuman(res);
  }

  process.exit(res.verdict === 'FAIL' ? 1 : 0);
}

// Exported for unit tests; only run main() when invoked as a script.
export { computeAnchorHash, readAnchors, verifyRecords, verify, UsageError };

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === thisPath) {
  main();
}
