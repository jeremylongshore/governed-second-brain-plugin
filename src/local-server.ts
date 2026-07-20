#!/usr/bin/env node
/**
 * Bob's Big Brain — local, in-process MCP server.
 *
 * A self-contained stdio server that drives qmd + the deterministic govern
 * kernel + the local ~/.teamkb store DIRECTLY, in-process. No daemon, no HTTP,
 * no network, no API key. Read tools answer with qmd:// citations; write tools
 * capture a proposal and run it through deterministic governance, recording a
 * SHA-256 hash-chained audit event for every promotion.
 *
 * Tool surface (matches the brain / brain-save skills exactly):
 *   READ : brain_search, brain_status, brain_audit_verify
 *   WRITE: brain_capture, brain_govern, brain_transition
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import {
  createDatabase,
  MemoryRepository,
  AuditRepository,
  verifyAnchors,
  readManifest,
  classifyChainBreaks,
  type ExceptionManifest,
  type StoredRowTuple,
} from '@qmd-team-intent-kb/store';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { loadOrCreateOriginSecret, mintOriginToken, rerankCitedHits } from '@qmd-team-intent-kb/common';
import { writeToSpool } from '@qmd-team-intent-kb/claude-runtime';
import { validateTransition } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { resolveConfig } from './config.js';
import { runGovern } from './govern.js';
import { anchorChainHead } from './anchor.js';
import { acquireWriteLock, WriteLockBusyError } from './write-lock.js';

const VERSION = '1.1.0';
const config = resolveConfig();

const CATEGORIES = [
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
] as const;

function jsonResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

/**
 * The local store (better-sqlite3) is a per-machine native module the plugin
 * keeps EXTERNAL to the bundle — the `npx governed-second-brain init` installer
 * builds it (ensureNativeDep). A file-copy install (e.g. `/plugin install` from a
 * marketplace) ships the bundle without that native build, so any DB-touching
 * tool fails until the installer is run. Detect that case and answer with a
 * clear, actionable message instead of a raw module/ABI error.
 */
function isMissingNativeDep(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /better[_-]sqlite3|MODULE_NOT_FOUND|Cannot find module|did not self-register|NODE_MODULE_VERSION|invalid ELF/i.test(
    msg,
  );
}

const NATIVE_DEP_HINT =
  "The brain's local store (better-sqlite3) isn't built for this machine. Run `npx governed-second-brain init <folder>` once — it builds the native module and registers the MCP — then retry. (Capture still works without it; only the governed store does not.)";

/** Default on-disk path of the byte-pinned audit-break exception manifest. */
function manifestPath(basePath: string): string {
  return join(basePath, 'audit', 'exceptions.manifest.json');
}

/**
 * Load the audit-break exception manifest if it exists, else null. A missing
 * manifest is the common case (the live brain's 155 breaks are ALL benign
 * CHAIN_FORKs — no hash amnesty is needed), and null is a valid input to the
 * classifier: with no amnesty, every tamper-reason break is a tamper signature.
 * A manifest that FAILS its integrity gates (bad hash / count drift / malformed)
 * is treated as absent rather than trusted — fail-closed, never launder.
 */
function loadExceptionManifest(basePath: string): ExceptionManifest | null {
  const p = manifestPath(basePath);
  if (!existsSync(p)) return null;
  try {
    return readManifest(p);
  } catch (e) {
    // Fail-closed under ANY failure — an ExceptionManifestError (bad hash / count
    // drift), a SyntaxError from corrupt JSON, or an fs error must all be treated
    // as "no manifest" rather than trusted or crashing brain_audit_verify. Never
    // launder; never let a malformed amnesty file take down verification. (Gemini review.)
    process.stderr.write(
      `[audit-verify] exception manifest ignored (treated as absent): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/**
 * Build the classifier's `rowsById` map — audit row id → its CURRENT stored
 * `{entry_hash, prev_entry_hash, hash_version, seq}`. The classifier reads the
 * live DB tuple (not the manifest's recorded one) so it can byte-match and
 * catch drift. `findAllChronological()` returns `SELECT *` rows, so the raw
 * `seq` column is present even though the typed row shape omits it.
 */
function buildRowsById(auditRepo: AuditRepository): Map<string, StoredRowTuple> {
  const rowsById = new Map<string, StoredRowTuple>();
  for (const row of auditRepo.findAllChronological()) {
    const raw = row as unknown as { seq?: number };
    rowsById.set(row.id, {
      entry_hash: row.entry_hash,
      prev_entry_hash: row.prev_entry_hash,
      hash_version: row.hash_version ?? 1,
      seq: raw.seq ?? 0,
    });
  }
  return rowsById;
}

/**
 * Compose the newcomer-safe clean-chain message. Never calls a benign
 * ordering fork "tamper"; omits zero-count clauses so the common all-clean
 * case reads simply.
 */
function honestCleanMessage(
  totalEvents: number,
  forkCount: number,
  exceptionCount: number,
  anchorCount: number,
): string {
  const parts = ['0 tamper signatures'];
  if (forkCount > 0) {
    parts.push(`${forkCount} benign chain-ordering fork(s) (known artifact)`);
  }
  if (exceptionCount > 0) {
    parts.push(`${exceptionCount} documented exception(s)`);
  }
  return (
    `Audit chain verified over ${totalEvents} event(s): ${parts.join(', ')}, ` +
    `consistent with ${anchorCount} external anchor(s).`
  );
}

const server = new McpServer({ name: 'governed-brain', version: VERSION });

// ─── READ ────────────────────────────────────────────────────────────────────

server.tool(
  'brain_search',
  'Search your governed knowledge brain and return qmd:// citations — receipts, not recall. Runs in-process against your local qmd index (no network, no API key). Curated scope by default.',
  {
    query: z.string().min(1).describe('Natural-language search query'),
    scope: z
      .enum(['curated', 'all', 'inbox', 'archived'])
      .optional()
      .describe('Search scope: curated (default, governed knowledge), all, inbox, or archived'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of cited hits to return (default 10)'),
  },
  async (params) => {
    const scope = params.scope ?? 'curated';
    const limit = params.limit ?? 10;
    const adapter = new QmdAdapter({ tenantId: config.tenantId, exportDir: config.exportDir });
    // Pass the bound tenant explicitly: adapter.query() is fail-closed on an
    // undefined tenantId (the c5k.2 hardening), so a local search that omits it
    // is refused and silently returns zero hits. In local mode the query tenant
    // IS the bound tenant.
    const res = await adapter.query(params.query, scope, config.tenantId);
    if (!res.ok) {
      return jsonResult({
        source: 'local-qmd',
        query: params.query,
        scope,
        count: 0,
        results: [],
        note: 'qmd search returned no index — install qmd 2.x on PATH and run brain_govern to build it.',
      });
    }
    // R1 freshness + category rerank over the R2-fused cited hits.
    // adapter.query already fuses the qmd binary with the native FTS5 backend
    // (reciprocal-rank fusion, INTKB #257) — that comes for free with the
    // rebundle. What the local path historically SKIPPED is the freshness/
    // category rerank the INTKB API's SearchService.searchViaQmd applies (INTKB
    // #256): the local server returned adapter.query results raw. Wire it in
    // here so local mode ranks the same way the team path does — resolve each
    // qmd citation back to its governed store row for {category, updatedAt},
    // opening the local DB read-only purely for that metadata lookup. If the DB
    // can't open (missing native store, empty brain), degrade to the un-reranked
    // fused order rather than break search.
    const nowIso = new Date().toISOString();
    let ranked: Array<{ file: string; snippet: string; score: number; collection: string }> = res.value;
    let db;
    try {
      db = createDatabase({ path: config.dbPath, readonly: true });
      const repo = new MemoryRepository(db);
      // Normalise the qmd/fusion scores to [0,1] against the top hit BEFORE the
      // rerank: exact hits can all score 0, and multiplying freshness into raw
      // zeros would erase the ordering (mirrors SearchService.searchViaQmd).
      const maxScore = res.value.reduce((m, h) => (h.score > m ? h.score : m), 0);
      const normalised = res.value.map((h, i) => ({
        ...h,
        score:
          maxScore > 0
            ? Math.min(Math.max(h.score / maxScore, 0), 1)
            : res.value.length > 0
              ? (res.value.length - i) / res.value.length
              : 0,
      }));
      const reranked = rerankCitedHits(
        normalised,
        (memoryId) => {
          const m = repo.findById(memoryId);
          return m ? { category: m.category, updatedAt: m.updatedAt } : null;
        },
        nowIso,
      );
      ranked = reranked.map((r) => ({
        file: r.file,
        snippet: r.snippet,
        score: Math.min(r.finalScore, 1),
        collection: r.collection,
      }));
    } catch {
      // The rerank needs the store for {category, updatedAt}; if it's
      // unavailable, keep the raw fused order — never fail search over ranking.
      ranked = res.value;
    } finally {
      db?.close();
    }
    const results = ranked.slice(0, limit).map((r) => ({
      citation: r.file,
      snippet: r.snippet,
      score: r.score,
      collection: r.collection,
    }));
    return jsonResult({ source: 'local-qmd', query: params.query, scope, count: results.length, results });
  },
);

server.tool(
  'brain_status',
  'Report the health of your governed brain — counts of memories by lifecycle state and category. Read-only.',
  async () => {
    let db;
    try {
      db = createDatabase({ path: config.dbPath, readonly: true });
    } catch (e) {
      if (isMissingNativeDep(e)) return jsonResult({ total: 0, note: NATIVE_DEP_HINT });
      return jsonResult({
        total: 0,
        byLifecycle: {},
        byCategory: {},
        note: 'Brain is empty — capture something with /brain-save (brain_capture + brain_govern).',
      });
    }
    try {
      const repo = new MemoryRepository(db);
      return jsonResult({
        total: repo.count(),
        byLifecycle: repo.countByLifecycle(),
        byCategory: repo.countByCategory(),
      });
    } finally {
      db.close();
    }
  },
);

server.tool(
  'brain_audit_verify',
  "Verify the integrity of your brain's audit trail — the SHA-256 hash chain AND the external anchor log. Reports an honest 3-state summary: tamper signatures (a broken hash link, or a silent rewrite of history caught by cross-checking the anchored snapshots), documented migration exceptions, and benign chain-ordering forks. Read-only.",
  {
    verbose: z
      .boolean()
      .optional()
      .describe(
        'Include the raw per-break detail arrays (row ids, tenants). Default false — the summary reports counts only, to avoid leaking row identity on a read surface an outsider may hit.',
      ),
  },
  async (params) => {
    const verbose = params.verbose ?? false;
    let db;
    try {
      db = createDatabase({ path: config.dbPath, readonly: true });
    } catch (e) {
      if (isMissingNativeDep(e)) return jsonResult({ ok: false, totalEvents: 0, note: NATIVE_DEP_HINT });
      return jsonResult({ ok: true, totalEvents: 0, note: 'Brain is empty — no audit chain yet.' });
    }
    try {
      const auditRepo = new AuditRepository(db);
      const result = verifyAnchors(auditRepo, join(config.basePath, 'audit', 'anchors.jsonl'));

      // Partition the raw breaks the walker found into an honest 3-state view:
      // tamper signatures vs documented migration exceptions vs benign ordering
      // forks. Load the byte-pinned exception manifest if present (else null →
      // every tamper-reason break is a tamper signature; benign forks stay
      // benign). rowsById is the DB's CURRENT stored tuple per audit row, so the
      // classifier can byte-match against the manifest and catch drift.
      const manifest = loadExceptionManifest(config.basePath);
      const rowsById = buildRowsById(auditRepo);
      const classified = classifyChainBreaks(result.chain.breaks, manifest, rowsById);

      const tamperCount = classified.tamperSignatures.length;
      const exceptionCount = classified.documentedExceptions.length;
      const forkCount = classified.chainForks.length;
      const anchorBreakCount = result.anchorBreaks.length;

      // `ok` reflects NO-TAMPERING, not a strict zero-breaks chain. Benign
      // ordering forks and documented, byte-pinned migration exceptions do not
      // make the brain "not ok". Anchor breaks are always tamper-grade.
      const ok = tamperCount === 0 && anchorBreakCount === 0;

      const message = ok
        ? honestCleanMessage(result.chain.totalRows, forkCount, exceptionCount, result.anchorCount)
        : `⚠ TAMPER DETECTED — ${tamperCount} tamper signature(s), ${anchorBreakCount} anchor break(s).`;

      // Default response is counts-only. The raw breaks[]/anchorBreaks[] arrays
      // carry row ids + tenant (an info-disclosure oracle on a read surface an
      // outsider may hit — R8), so they are gated behind an explicit `verbose`.
      const base = {
        ok,
        totalEvents: result.chain.totalRows,
        cleanRows: result.chain.cleanRows,
        tamperSignatures: tamperCount,
        documentedExceptions: exceptionCount,
        chainForks: forkCount,
        anchorCount: result.anchorCount,
        anchorBreaks: anchorBreakCount,
        message,
      };
      if (!verbose) return jsonResult(base);
      return jsonResult({
        ...base,
        detail: {
          tamperSignatures: classified.tamperSignatures,
          documentedExceptions: classified.documentedExceptions,
          chainForks: classified.chainForks,
          anchorBreaks: result.anchorBreaks,
        },
      });
    } finally {
      db.close();
    }
  },
);

// ─── WRITE ───────────────────────────────────────────────────────────────────

server.tool(
  'brain_capture',
  'Capture a single fact, decision, pattern, or convention as a governance candidate (the model\'s PROPOSAL). It is appended to the local spool; run brain_govern to put it through deterministic dedupe/policy/promotion with a hash-chained receipt.',
  {
    title: z.string().min(1).describe('Short, specific title for the memory'),
    content: z.string().min(1).describe('The fact to remember, in full'),
    category: z.enum(CATEGORIES).optional().describe('Memory category (default: reference)'),
    filePaths: z.array(z.string()).optional().describe('Related file paths, if any'),
  },
  async (params) => {
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    // H1 write-time provenance: mint the origin token over (id, tenantId,
    // capturedAt) with the per-installation secret (~/.teamkb/origin-secret,
    // auto-created 0600 on first capture; TEAMKB_ORIGIN_SECRET overrides). The
    // local govern pass verifies it with the SAME file before promotion.
    // Best-effort: an unwritable base dir degrades to an UNATTESTED capture
    // (governs exactly like a pre-H1 candidate) rather than losing the capture.
    // Channel `local-mcp` is self-asserted — local mode is one trust domain
    // (H4; see the Registrar's 049-AT-DECR).
    let origin: MemoryCandidate['origin'];
    try {
      const secret = loadOrCreateOriginSecret(config.basePath);
      origin = {
        tokenHmac: mintOriginToken(secret, {
          candidateId: id,
          tenantId: config.tenantId,
          capturedAt,
        }),
        channel: 'local-mcp',
        mintedAt: capturedAt,
      };
    } catch {
      origin = undefined;
    }
    const candidate: MemoryCandidate = {
      schemaVersion: '1',
      id,
      status: 'inbox',
      source: 'mcp',
      content: params.content,
      title: params.title,
      category: params.category ?? 'reference',
      trustLevel: 'medium',
      author: { type: 'ai', id: 'governed-brain' },
      tenantId: config.tenantId,
      metadata: { filePaths: params.filePaths ?? [], tags: [] },
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      capturedAt,
      ...(origin !== undefined ? { origin } : {}),
    };
    const res = await writeToSpool(candidate, config.spoolPath);
    if (!res.ok) {
      return jsonResult({ ok: false, error: res.error });
    }
    return jsonResult({
      ok: true,
      candidateId: candidate.id,
      message: 'Captured to the spool. Run brain_govern to dedupe → policy → promote with a hash-chained receipt.',
    });
  },
);

server.tool(
  'brain_govern',
  'Run the deterministic govern pipeline once, in-process: drain the spool → dedupe → policy/secret-detection → promote, append a SHA-256 hash-chained audit event per decision, then refresh the search index. This is the deterministic system DISPOSING of the model\'s proposals.',
  async () => {
    let s;
    try {
      s = await runGovern(config);
    } catch (e) {
      // Another writer (an interactive transition, or the cron backup/compile
      // holding /usr/bin/flock) held the write lock past the bounded wait. Return
      // a clean, retryable result instead of hanging the MCP.
      if (e instanceof WriteLockBusyError) return jsonResult({ ok: false, error: e.message });
      if (isMissingNativeDep(e)) return jsonResult({ ok: false, error: 'native-store-unavailable', message: NATIVE_DEP_HINT });
      throw e;
    }
    const parts = [
      `${s.promoted} promoted`,
      `${s.quarantined} quarantined`,
      `${s.rejected} rejected`,
      `${s.duplicates} duplicate`,
      `${s.flagged} flagged`,
    ];
    if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
    let message = `Governed ${s.processed} inbox candidate(s) (${s.ingested} newly ingested): ${parts.join(', ')}.`;
    if (!s.indexUpdated) {
      message += ' Search index not refreshed — install qmd 2.x on PATH and re-run brain_govern to make new memories searchable.';
    }
    return jsonResult({ ok: true, ...s, message });
  },
);

server.tool(
  'brain_transition',
  'Change the lifecycle state of an existing governed memory (e.g. retire an outdated one). Writes a hash-chained audit event. Valid moves: active→{deprecated,superseded,archived}, deprecated→{active,archived}, superseded→archived.',
  {
    memoryId: z.string().uuid().describe('UUID of the memory to transition'),
    to: z
      .enum(['active', 'deprecated', 'superseded', 'archived'])
      .describe('Target lifecycle state'),
    reason: z.string().min(1).describe('Human-readable justification (lands in the audit trail)'),
    actor: z.string().optional().describe('Who is making the change (default: owner)'),
    supersededBy: z.string().uuid().optional().describe('Required UUID when transitioning to "superseded"'),
  },
  async (params) => {
    // Serialize the whole transition (DB lifecycle update + audit insert + anchor
    // append) under the brain's exclusive flock(2) write lock — THE SAME lock the
    // cron backup/compile take via /usr/bin/flock — so a lifecycle write can't land
    // mid-backup and can't fork the anchor log against a concurrent govern. On
    // contention past the bounded wait, report busy cleanly rather than hang.
    let lock;
    try {
      lock = await acquireWriteLock(config.basePath);
    } catch (e) {
      if (e instanceof WriteLockBusyError) return jsonResult({ ok: false, error: e.message });
      throw e;
    }
    try {
      let db;
      try {
        db = createDatabase({ path: config.dbPath });
      } catch (e) {
        if (isMissingNativeDep(e)) return jsonResult({ ok: false, error: 'native-store-unavailable', message: NATIVE_DEP_HINT });
        throw e;
      }
      try {
        const memoryRepo = new MemoryRepository(db);
        const auditRepo = new AuditRepository(db);
        const memory = memoryRepo.findById(params.memoryId);
        if (!memory) {
          return jsonResult({ ok: false, error: `No memory found with id ${params.memoryId}` });
        }
        const actor = { type: 'human' as const, id: params.actor ?? 'owner' };
        const validation = validateTransition(memory.lifecycle, params.to, {
          reason: params.reason,
          actor,
          supersededBy: params.supersededBy,
        });
        if (!validation.valid) {
          return jsonResult({ ok: false, error: validation.error });
        }
        const now = new Date().toISOString();
        const action =
          params.to === 'archived' ? 'archived' : params.to === 'superseded' ? 'superseded' : 'demoted';
        db.transaction(() => {
          memoryRepo.updateLifecycle(params.memoryId, params.to, now);
          auditRepo.insert({
            id: randomUUID(),
            action,
            memoryId: params.memoryId,
            tenantId: memory.tenantId,
            actor,
            reason: params.reason,
            details: { from: memory.lifecycle, to: params.to },
            timestamp: now,
          });
        })();
        // Re-anchor the chain head AFTER the durable audit write commits, so this
        // transition's row is snapshotted into the external anchor log immediately
        // — narrowing the rewrite-detection window to one write instead of one
        // govern cycle (010-AT-RISK R3b). Best-effort: a failed anchor must NOT
        // fail the transition; the memory move + audit event already committed.
        // `committed:true` may be unpushed when there's no remote — a local-only
        // witness, not external tamper-evidence (the verifier reports that as
        // UNPUSHED_LOCAL_WITNESS), so we don't overclaim in the message.
        const anchored = anchorChainHead(auditRepo, config.basePath, config.tenantId);
        return jsonResult({
          ok: true,
          memoryId: params.memoryId,
          from: memory.lifecycle,
          to: params.to,
          anchored,
          message: anchored
            ? 'Transition applied; hash-chained audit event written and chain head re-anchored.'
            : 'Transition applied; hash-chained audit event written. (External anchor skipped — best-effort; the durable write is unaffected.)',
        });
      } finally {
        db.close();
      }
    } finally {
      lock.release();
    }
  },
);

// ─── boot ──────────────────────────────────────────────────────────────────

/**
 * Boot local mode: connect the stdio transport. Exported so the dispatcher
 * (src/index.ts) can start it. The dispatcher dynamic-imports this module ONLY
 * in local mode, so team mode never loads the local store's native module.
 */
export async function startLocalServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`[governed-brain:local] ${sig}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
  process.stderr.write(
    `[governed-brain:local] started — tenant=${config.tenantId} base=${config.basePath} (local, in-process, no network)\n`,
  );
}
