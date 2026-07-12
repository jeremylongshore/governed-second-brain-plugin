import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ingestFromSpool, Curator } from '@qmd-team-intent-kb/curator';
import { runExport } from '@qmd-team-intent-kb/git-exporter';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
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
 * Fixed sentinel `memoryId` stamped on the batch-level `governed` sweep receipt
 * (B1). A sweep governs MANY candidates, so its receipt is not tied to one memory;
 * this constant marks the row as a sweep event and makes every sweep receipt
 * discoverable via `auditRepo.findByMemory(SWEEP_RECEIPT_MEMORY_ID)`. It is a
 * synthetic (never-a-real-memory) but structurally-valid UUID.
 */
const SWEEP_RECEIPT_MEMORY_ID = '00000000-0000-4000-8000-000000000b10';

/** One candidate's outcome in a sweep receipt — id + terminal outcome, NO content. */
interface SweepOutcome {
  candidateId: string;
  outcome: 'promoted' | 'duplicate' | 'quarantined' | 'flagged' | 'rejected' | 'skipped';
}

/**
 * Result of one in-process govern pass — what the deterministic pipeline did with
 * the whole inbox (freshly-spooled candidates PLUS any remote team-mode captures
 * sitting in the `candidates` table), plus whether the search index was refreshed.
 */
export interface GovernSummary {
  ingested: number;
  /** Number of inbox candidates the sweep examined this run. */
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  /** Member-authored candidates held back from auto-promotion for admin review. */
  quarantined: number;
  /** Candidates skipped by per-candidate error containment (never aborts the sweep). */
  skipped: number;
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

    // 1. Ingest the spool → inbox candidates in SQLite. Archive each file after
    //    it is ingested (B1 idempotency): a re-run over unchanged input re-reads
    //    nothing, and the candidate findById dedup already blocks re-inserts.
    const ingestResult = await ingestFromSpool(candidateRepo, config.spoolPath, {
      archiveIngestedDir: join(config.spoolPath, 'ingested'),
    });
    const ingested = ingestResult.ok ? ingestResult.value.length : 0;

    // 2. Sweep the WHOLE inbox → govern it (B1, bead compile-then-govern-jfv.2.1).
    //    This is the marquee capture feature: freshly-spooled candidates AND remote
    //    team-mode brain_capture proposals (which POST to /api/candidates and land
    //    in the inbox with nothing else draining them) are governed in one pass.
    const curation = sweepInbox(config, { candidateRepo, memoryRepo, policyRepo, auditRepo });

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
      ingested,
      processed: curation.processed,
      promoted: curation.promoted,
      rejected: curation.rejected,
      flagged: curation.flagged,
      duplicates: curation.duplicates,
      quarantined: curation.quarantined,
      skipped: curation.skipped,
      exported,
      indexUpdated,
      indexError,
      anchored,
    };
  } finally {
    db.close();
  }
}

/** Repositories the inbox sweep operates over (all built on ONE db connection). */
interface SweepDeps {
  candidateRepo: CandidateRepository;
  memoryRepo: MemoryRepository;
  policyRepo: PolicyRepository;
  auditRepo: AuditRepository;
}

/** Aggregate counters + per-candidate outcomes produced by one inbox sweep. */
interface SweepResult {
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  quarantined: number;
  skipped: number;
}

/**
 * Drain and govern the ENTIRE pre-governance inbox for this tenant (B1, bead
 * compile-then-govern-jfv.2.1). The marker-based, DELETE-free auto-govern sweep.
 *
 * For every candidate in `status='inbox'` (freshly-spooled locals + remote
 * team-mode captures alike):
 *
 *   • MEMBER-authored (metadata.proposedByRole==='member', stamped server-side by
 *     R8) → NEVER auto-promoted. Marked `quarantined` (leaves the inbox, stays out
 *     of durable memory) for an admin digest-approve. Only admin/self-authored
 *     candidates flow through the promotion pipeline.
 *   • otherwise run the deterministic curator (tenant-scoped dedup → policy →
 *     promote). On the CurationResult:
 *       - promoted / duplicate → stamped to that terminal status; the row LEAVES
 *         the inbox (non-destructively — the row + its content survive).
 *       - flagged / rejected → LEFT in the inbox for human review. The review
 *         queue + the only copy of the content must survive, so the sweep never
 *         retires them. Per-candidate reject receipts are suppressed
 *         (`suppressRejectionReceipts`) so a candidate re-evaluated every night
 *         never grows the audit chain — the batch receipt below is the record.
 *
 * Every candidate is wrapped in its own try/catch: a single bad row is skipped +
 * counted, never aborting the drain (paired with the tolerant `findByStatus`
 * mapper, so even an unparseable row can't wedge the inbox forever).
 *
 * Emits exactly ONE batch-level `governed` audit receipt — but ONLY when ≥1
 * candidate actually LEFT the inbox this run (promoted / duplicate / quarantined).
 * That condition is what makes a re-run over unchanged input a genuine no-op: a
 * sweep that only re-encounters candidates already left in the inbox for review
 * writes nothing. The receipt records the per-candidate outcomes (ids + outcome),
 * never any content. Runs under the caller's flock + on the shared connection;
 * each promotion is atomic (R9) and the receipt is a single append.
 */
function sweepInbox(config: BrainConfig, deps: SweepDeps): SweepResult {
  const { candidateRepo, memoryRepo, policyRepo, auditRepo } = deps;
  const inbox = candidateRepo.findByStatus('inbox', config.tenantId);

  const res: SweepResult = {
    processed: inbox.length,
    promoted: 0,
    rejected: 0,
    flagged: 0,
    duplicates: 0,
    quarantined: 0,
    skipped: 0,
  };
  if (inbox.length === 0) return res;

  const curator = new Curator(
    { candidateRepo, memoryRepo, policyRepo, auditRepo },
    { tenantId: config.tenantId, suppressRejectionReceipts: true },
  );

  // Tenant-scoped intra-batch dedup set, extended as promotions land (mirrors
  // Curator.processBatch, but we drive processSingle per-candidate so each
  // candidate has its own error containment).
  const existingHashes = new Set(memoryRepo.getContentHashesByTenant(config.tenantId));
  const outcomes: SweepOutcome[] = [];

  for (const candidate of inbox) {
    try {
      // Member-quarantine gate: a member's proposal must NOT auto-promote.
      if (isMemberAuthored(candidate)) {
        candidateRepo.updateStatus(candidate.id, 'quarantined', config.tenantId);
        res.quarantined++;
        outcomes.push({ candidateId: candidate.id, outcome: 'quarantined' });
        continue;
      }

      const result = curator.processSingle(candidate, existingHashes);
      switch (result.outcome) {
        case 'promoted':
          candidateRepo.updateStatus(candidate.id, 'promoted', config.tenantId);
          existingHashes.add(computeContentHash(candidate.content));
          res.promoted++;
          outcomes.push({ candidateId: candidate.id, outcome: 'promoted' });
          break;
        case 'duplicate':
          candidateRepo.updateStatus(candidate.id, 'duplicate', config.tenantId);
          res.duplicates++;
          outcomes.push({ candidateId: candidate.id, outcome: 'duplicate' });
          break;
        case 'flagged':
          // LEFT in the inbox for human review (row + content survive).
          res.flagged++;
          outcomes.push({ candidateId: candidate.id, outcome: 'flagged' });
          break;
        case 'rejected':
          // LEFT in the inbox for human review (row + content survive).
          res.rejected++;
          outcomes.push({ candidateId: candidate.id, outcome: 'rejected' });
          break;
      }
    } catch (e) {
      // Per-candidate containment: skip + count, never abort the whole sweep.
      res.skipped++;
      outcomes.push({ candidateId: candidate.id, outcome: 'skipped' });
      process.stderr.write(
        `[govern:sweep] skipped candidate ${candidate.id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // ONE batch receipt — only when durable state changed (a candidate left the
  // inbox). A no-op sweep (only review-queue leftovers) writes nothing, keeping a
  // re-run idempotent. Content is NEVER included (ids + outcomes only).
  const leftInbox = res.promoted + res.duplicates + res.quarantined;
  if (leftInbox > 0) {
    try {
      auditRepo.insert(
        AuditEvent.parse({
          id: randomUUID(),
          action: 'governed',
          memoryId: SWEEP_RECEIPT_MEMORY_ID,
          tenantId: config.tenantId,
          actor: { type: 'system', id: 'auto-govern' },
          reason: `Auto-govern sweep: ${res.promoted} promoted, ${res.duplicates} duplicate, ${res.quarantined} quarantined, ${res.flagged} flagged, ${res.rejected} rejected, ${res.skipped} skipped`,
          details: {
            promoted: res.promoted,
            duplicates: res.duplicates,
            quarantined: res.quarantined,
            flagged: res.flagged,
            rejected: res.rejected,
            skipped: res.skipped,
            processed: res.processed,
            outcomes,
          },
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (e) {
      // Best-effort: a failed batch receipt must not undo the governed writes.
      process.stderr.write(
        `[govern:sweep] batch receipt skipped: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  return res;
}

/**
 * True when a candidate was proposed by a `member` token (R8 stamps
 * `metadata.proposedByRole` server-side at intake). Member-authored proposals are
 * quarantined rather than auto-promoted. Self-authored local captures and
 * admin-authored proposals have no `member` marker and flow through normally.
 */
function isMemberAuthored(candidate: MemoryCandidate): boolean {
  return candidate.metadata?.proposedByRole === 'member';
}
