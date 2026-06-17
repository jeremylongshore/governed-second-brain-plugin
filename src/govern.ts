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
 */
export async function runGovern(config: BrainConfig): Promise<GovernSummary> {
  const db = createDatabase({ path: config.dbPath });
  try {
    const candidateRepo = new CandidateRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const policyRepo = new PolicyRepository(db);
    const auditRepo = new AuditRepository(db);
    const exportStateRepo = new ExportStateRepository(db);

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
    };
  } finally {
    db.close();
  }
}
