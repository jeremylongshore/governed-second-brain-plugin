import { ingestFromSpool, Curator } from '@qmd-team-intent-kb/curator';
import { runExport } from '@qmd-team-intent-kb/git-exporter';
import {
  createDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import type { BrainConfig } from './config.js';
import { seedDefaultPolicy } from './seed-policy.js';
import { anchorChainHead } from './anchor.js';
import { acquireWriteLock } from './write-lock.js';

/**
 * Result of one in-process govern pass — what the deterministic pipeline did
 * with the spooled candidates, plus whether the search index was refreshed.
 */
export interface GovernSummary {
  ingested: number;
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  exported: number;
  indexUpdated: boolean;
  indexError?: string;
  /** External anchor of the audit chain head (append-only log, git-committed). */
  anchored?: { chainHead: string; chainedRows: number; committed: boolean };
}

/**
 * Drive the deterministic govern pipeline once, in-process, with no daemon.
 *
 * This hand-wires the same sequence the edge-daemon runs per cycle — ingest the
 * spool → dedupe → policy → promote → export the markdown tree → refresh the qmd
 * index — but synchronously and on demand, pulling in only the curator,
 * git-exporter, qmd-adapter, and store packages (no daemon, no health server,
 * no pino). Promotion is where durable state and the SHA-256 hash-chained audit
 * event are written — the deterministic system DISPOSING of the model's
 * proposals. `runExport` is file-generation only (no git commit/push).
 *
 * Graceful degradation: if `qmd` is not on PATH, ingest/govern/promote/export
 * and the audit chain all still complete; only the index refresh fails (its
 * error is surfaced in `indexError`, and the new memory becomes searchable once
 * qmd is installed and govern is re-run).
 *
 * Concurrency: the ENTIRE pass (DB writes → export → qmd index → anchor append)
 * runs while holding the brain's exclusive `flock(2)` write lock on
 * `<base>/.write.lock` — THE SAME lock the cron backup/compile wrappers take via
 * `/usr/bin/flock`. This is what keeps an interactive govern from landing between
 * the 04:30 backup's `VACUUM INTO` and its `tar` (a false "TAMPER DETECTED" on
 * restore) and stops concurrent anchor appends from forking the anchor log. On
 * contention past the bounded wait it throws `WriteLockBusyError` — the tool
 * handler turns that into a clean, retryable result instead of hanging the MCP.
 */
export async function runGovern(config: BrainConfig): Promise<GovernSummary> {
  const lock = await acquireWriteLock(config.basePath);
  try {
    return await runGovernLocked(config);
  } finally {
    lock.release();
  }
}

/** The govern pass body, run under the already-held write lock (see runGovern). */
async function runGovernLocked(config: BrainConfig): Promise<GovernSummary> {
  const db = createDatabase({ path: config.dbPath });
  try {
    const candidateRepo = new CandidateRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const policyRepo = new PolicyRepository(db);
    const auditRepo = new AuditRepository(db);
    const exportStateRepo = new ExportStateRepository(db);

    // 0. Seed the local default governance policy once (idempotent). Without it
    //    the Curator auto-approves every non-duplicate candidate; with it, local
    //    mode gets receipted rejections for secrets + too-short content. Best-effort:
    //    a seed failure (schema mismatch, read-only DB) must NOT crash the govern
    //    pass — degrade to the prior no-policy behavior.
    try {
      seedDefaultPolicy(policyRepo, config.tenantId);
    } catch (e) {
      process.stderr.write(
        `[governed-brain] default policy seed skipped: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    // 1. Ingest the spool → inbox candidates in SQLite.
    const ingestResult = await ingestFromSpool(candidateRepo, config.spoolPath);
    const candidates = ingestResult.ok ? ingestResult.value : [];

    // 2. Govern: dedupe → policy → promote (writes the hash-chained audit).
    const curation = { processed: 0, promoted: 0, rejected: 0, flagged: 0, duplicates: 0 };
    if (candidates.length > 0) {
      const curator = new Curator(
        { candidateRepo, memoryRepo, policyRepo, auditRepo },
        { tenantId: config.tenantId },
      );
      const r = curator.processBatch(candidates);
      curation.processed = r.processed;
      curation.promoted = r.promoted;
      curation.rejected = r.rejected;
      curation.flagged = r.flagged;
      curation.duplicates = r.duplicates;
    }

    // 3. Export promoted memories to the markdown tree (file generation only).
    let exported = 0;
    try {
      const ex = await runExport(
        memoryRepo,
        exportStateRepo,
        { outputDir: config.exportDir, targetId: 'kb-export-default', tenantId: config.tenantId },
        () => new Date().toISOString(),
      );
      exported = ex.written.length;
    } catch (e) {
      process.stderr.write(`[govern] export failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    // 4. Refresh the qmd index (graceful degrade if qmd is absent).
    let indexUpdated = false;
    let indexError: string | undefined;
    try {
      const adapter = new QmdAdapter({ tenantId: config.tenantId, exportDir: config.exportDir });
      const ensure = await adapter.ensureCollections();
      if (!ensure.ok) throw new Error(ensure.error.message);
      const upd = await adapter.update();
      if (!upd.ok) throw new Error(upd.error.message);
      indexUpdated = true;
    } catch (e) {
      indexError = e instanceof Error ? e.message : String(e);
    }

    // 5. Anchor the chain head externally — snapshot to an append-only, hash-chained
    //    log and commit it to git (the tamper-evidence verifyAnchors checks against).
    //    Shared with brain_transition so every durable audit write re-anchors.
    const anchored = anchorChainHead(auditRepo, config.basePath, config.tenantId);
    if (!anchored) {
      process.stderr.write('[govern] anchor failed (best-effort; govern pass unaffected)\n');
    }

    return {
      ingested: candidates.length,
      processed: curation.processed,
      promoted: curation.promoted,
      rejected: curation.rejected,
      flagged: curation.flagged,
      duplicates: curation.duplicates,
      exported,
      indexUpdated,
      indexError,
      anchored,
    };
  } finally {
    db.close();
  }
}
