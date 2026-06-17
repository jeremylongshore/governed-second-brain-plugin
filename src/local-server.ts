#!/usr/bin/env node
/**
 * Governed Second Brain — local, in-process MCP server.
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import {
  createDatabase,
  MemoryRepository,
  AuditRepository,
  verifyAnchors,
} from '@qmd-team-intent-kb/store';
import { QmdAdapter } from '@qmd-team-intent-kb/qmd-adapter';
import { writeToSpool } from '@qmd-team-intent-kb/claude-runtime';
import { validateTransition } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { resolveConfig } from './config.js';
import { runGovern } from './govern.js';

const VERSION = '0.1.6';
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
    const res = await adapter.query(params.query, scope);
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
    const results = res.value.slice(0, limit).map((r) => ({
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
  "Verify the integrity of your brain's audit trail — the SHA-256 hash chain AND the external anchor log. Reports any tamper: a broken hash link, or a silent rewrite of history the chain alone would miss (caught by cross-checking the anchored snapshots). Read-only.",
  async () => {
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
      return jsonResult({
        ok: result.ok,
        totalEvents: result.chain.totalRows,
        cleanRows: result.chain.cleanRows,
        chainBreaks: result.chain.breaks,
        anchorCount: result.anchorCount,
        anchorBreaks: result.anchorBreaks,
        message: result.ok
          ? `Audit chain intact (${result.chain.totalRows} events), consistent with ${result.anchorCount} external anchor(s).`
          : `⚠ TAMPER DETECTED — ${result.chain.breaks.length} chain break(s), ${result.anchorBreaks.length} anchor break(s).`,
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
    const candidate: MemoryCandidate = {
      id: randomUUID(),
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
      capturedAt: new Date().toISOString(),
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
      if (isMissingNativeDep(e)) return jsonResult({ ok: false, error: 'native-store-unavailable', message: NATIVE_DEP_HINT });
      throw e;
    }
    const parts = [
      `${s.promoted} promoted`,
      `${s.rejected} rejected`,
      `${s.duplicates} duplicate`,
      `${s.flagged} flagged`,
    ];
    let message = `Governed ${s.ingested} candidate(s): ${parts.join(', ')}.`;
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
      return jsonResult({
        ok: true,
        memoryId: params.memoryId,
        from: memory.lifecycle,
        to: params.to,
        message: 'Transition applied; hash-chained audit event written.',
      });
    } finally {
      db.close();
    }
  },
);

// ─── boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`[governed-brain] ${sig}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
  process.stderr.write(
    `[governed-brain] started — tenant=${config.tenantId} base=${config.basePath} (local, in-process, no network)\n`,
  );
}

void main();
