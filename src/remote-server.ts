#!/usr/bin/env node
/**
 * Bob's Big Brain — team mode (remote proxy).
 *
 * The same plugin, in TEAM mode: a self-contained stdio server that proxies the
 * read tools (`brain_search`, `brain_status`), the member write tool
 * (`brain_capture`), and the admin tools (`brain_transition` + the inbox surface
 * `brain_inbox` / `brain_approve` / `brain_reject`) to your team's governed brain
 * API over the tailnet. Selected automatically by the dispatcher (src/index.ts) when
 * TEAMKB_API_URL is set; otherwise the plugin runs the local in-process brain
 * instead. Failures are surfaced as distinct, visible errors — never a silent
 * empty result set.
 *
 * Deliberately minimal: no database, no qmd-adapter, no native modules — so team
 * mode runs from a marketplace clone with zero install/build and never touches
 * better-sqlite3. Capture/govern/promote stay server-side (governed centrally);
 * a teammate reads + proposes, the server disposes. The tool surface is unified
 * with local mode (`brain_search`) so the /brain and /brain-save skills work in
 * either mode.
 *
 * Env:
 *   TEAMKB_API_URL    — brain API base (e.g. http://team-server:3847). Required for results.
 *   TEAMKB_API_TOKEN  — per-user bearer token (sent as Authorization: Bearer).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '1.1.0';
const API_URL = process.env['TEAMKB_API_URL'];
const API_TOKEN = process.env['TEAMKB_API_TOKEN'];
// The team brain's tenant. Defaults to the real shared tenant; an env override
// lets a teammate target another tenant. NEVER hardcode 'local' here (that would
// silently route team writes into a tenant the team brain never reads).
const TENANT_ID = process.env['TEAMKB_TENANT_ID']?.trim() || 'intent-solutions';

// Category enum, copied verbatim from local-server.ts (NOT imported — team mode
// stays dependency-free: no @qmd-team-intent-kb/* in the bundle).
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

/** content-type + (optional) per-user bearer — the one auth surface for every call. */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (API_TOKEN !== undefined && API_TOKEN !== '') {
    headers['authorization'] = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

/** Map a non-OK brain-API response to a clear, role-aware message (no silent failures). */
export async function errorResult(res: Response): Promise<ReturnType<typeof jsonResult>> {
  // Read the body stream ONCE as text, then parse — calling res.json() then
  // res.text() in a fallback throws "body stream already read" and loses non-JSON
  // error bodies (plain text / HTML error pages).
  let detail = '';
  try {
    const text = await res.text();
    try {
      const b = JSON.parse(text) as { error?: unknown };
      detail = typeof b.error === 'string' ? b.error : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  const msg =
    res.status === 401
      ? 'team token rejected — check TEAMKB_API_TOKEN'
      : res.status === 403
        ? 'this action needs an ADMIN token; your member token can propose but not promote/transition — nothing was applied'
        : res.status === 422
          ? `the brain declined it: ${detail}`
          : `request failed (${res.status})${detail ? ': ' + detail : ''}`;
  return jsonResult({ ok: false, status: res.status, error: msg });
}

// ─── IDEMPOTENCY + DURABLE OUTBOX (jfv.9 + session-stable seam) ───────────────
// An automated/hook-driven capture must neither DUPLICATE nor SILENTLY LOSE.
//
// Identity (Property 1):
//  • When sessionId is present: UUIDv5 over (tenant, sessionId, "session-end") so
//    the key exists BEFORE content. Re-distillation / re-serialization cannot mint
//    a second id for the same session (Alex Spinov seam review).
//  • When sessionId is absent (manual /brain-save): fall back to
//    (tenant, title, content) for content-stable ad-hoc captures.
//
// Outbox (Property 2): stores the FINAL serialized POST body bytes (not a rebuild
// recipe). Drain POSTs that file verbatim — never re-derives id or re-builds the
// candidate from title/content args. A durable outbox that stored "intent" and
// rebuilt on drain would quietly reintroduce the Property 1 failure mode.

// Fixed namespace UUID for candidate-id derivation (RFC-4122 §4.3 UUIDv5 seed).
const CANDIDATE_ID_NAMESPACE = '6ba7b8f0-9dad-11d1-80b4-00c04fd430c8';

/** RFC-4122 UUIDv5 (SHA-1) — dependency-free (team mode pulls no uuid package). */
function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Deterministic candidate id.
 * - With sessionId: stable before content. Include learningIndex (0..N) so a
 *   multi-learning SessionEnd can mint up to N distinct slots; re-distill of the
 *   *same* slot collapses. Without learningIndex, defaults to 0 (single-slot).
 * - Without sessionId: content-derived (manual /brain-save; backward compatible).
 */
export function deriveCandidateId(
  tenant: string,
  title: string,
  content: string,
  sessionId?: string,
  learningIndex?: number,
): string {
  const sid = sessionId?.trim();
  if (sid !== undefined && sid !== '') {
    const idx =
      typeof learningIndex === 'number' && Number.isInteger(learningIndex) && learningIndex >= 0
        ? learningIndex
        : 0;
    return uuidv5(`${tenant}\n${sid}\nsession-end\n${idx}`, CANDIDATE_ID_NAMESPACE);
  }
  return uuidv5(`${tenant}\n${title}\n${content}`, CANDIDATE_ID_NAMESPACE);
}

/** The durable-outbox directory (env-overridable for tests). */
export function outboxDir(): string {
  const o = process.env['TEAMKB_OUTBOX_DIR']?.trim();
  return o !== undefined && o !== '' ? o : join(homedir(), '.teamkb-outbox');
}

/**
 * Queue a candidate that could not be delivered (network throw / 5xx).
 * FREEZES the final JSON body that would have been POSTed — drain replays these
 * bytes, it does not rebuild the candidate. Async + non-blocking.
 */
async function enqueueOutbox(candidate: { id: string }): Promise<boolean> {
  const dir = outboxDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Freeze exact POST body (not args-to-rebuild). Filename is advisory; body is authority.
    const body = JSON.stringify(candidate);
    await writeFile(join(dir, `${candidate.id}.json`), body, { mode: 0o600 });
    return true;
  } catch (e) {
    process.stderr.write(
      `[governed-brain:team] outbox enqueue failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return false;
  }
}

// A drain runs at most ONE at a time: concurrent captures (two overlapping tool
// calls) must not both process the same outbox file and double-POST it.
let draining = false;

/**
 * Drain the outbox: re-POST each queued candidate. Remove on a definitive outcome
 * (2xx delivered, or a NON-transient 4xx permanent reject — logged); STOP (keep the
 * rest queued) on a TRANSIENT status (5xx, or 429/408 rate-limit/timeout) or a
 * network throw. Async, non-blocking, single-flight, and never throws — a drain
 * failure must not fail the capture that triggered it.
 */
export async function drainOutbox(): Promise<number> {
  if (API_URL === undefined || API_URL === '') return 0;
  if (draining) return 0; // single-flight guard
  draining = true;
  try {
    const dir = outboxDir();
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return 0; // dir absent / unreadable → nothing to drain
    }
    let cleared = 0;
    for (const f of files) {
      const path = join(dir, f);
      let body: string;
      try {
        body = await readFile(path, 'utf8');
        JSON.parse(body); // validate — a corrupt file is dropped below, not retried forever
      } catch {
        await unlink(path).catch(() => {});
        continue;
      }
      let res: Response;
      try {
        res = await fetch(`${API_URL.replace(/\/+$/, '')}/api/candidates`, {
          method: 'POST',
          headers: authHeaders(),
          body,
        });
      } catch {
        break; // still offline — keep this + the rest queued
      }
      // 429 (rate-limited) + 408 (timeout) are TRANSIENT — keep them queued and retry
      // later, exactly like a 5xx. Only a non-transient 4xx (validation/auth) is a
      // permanent reject worth dropping.
      const transient = res.status === 429 || res.status === 408;
      if (res.ok || (res.status >= 400 && res.status < 500 && !transient)) {
        if (!res.ok) {
          process.stderr.write(`[governed-brain:team] outbox: dropping ${f} on ${res.status} (permanent)\n`);
        }
        await unlink(path)
          .then(() => {
            cleared++;
          })
          .catch(() => {});
      } else {
        break; // 5xx or transient 4xx — retry on a later drain
      }
    }
    return cleared;
  } finally {
    draining = false;
  }
}

interface CitedHit {
  citation: string;
  snippet: string;
  score: number;
  title?: string;
  collection?: string;
}

/**
 * Query the team brain and return an MCP result. Errors are SURFACED, never
 * swallowed into an empty hit set: a rejected token, a dead API, and being
 * off-tailnet each produce a distinct, visible error (the exact shaping
 * capture/transition already use) instead of a silent count:0 that reads like
 * "the brain has nothing for you."
 */
export async function search(
  query: string,
  scope: string,
  limit: number,
): Promise<ReturnType<typeof jsonResult>> {
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
  }
  const url = `${API_URL.replace(/\/+$/, '')}/api/search`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      // Send the tenant — the API's /api/search scopes qmd by tenantId and returns
      // ZERO hits without it (unlike capture, which carried tenantId in the candidate).
      // TENANT_ID defaults to the shared 'intent-solutions' tenant; a scoped teammate
      // token still has its tenantId validated server-side by the tenancy guard.
      body: JSON.stringify({ query, scope, tenantId: TENANT_ID, pagination: { page: 1, pageSize: limit } }),
    });
  } catch (e) {
    // fetch() itself threw — dead API, off-tailnet, DNS failure. Surface it.
    return jsonResult({
      ok: false,
      error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  // Non-OK response — role-aware message (401 → token rejected, 403 → admin-only,
  // …), identical shaping to brain_capture / brain_transition. Never return empty.
  if (!res.ok) return errorResult(res);
  const body = (await res.json()) as {
    hits?: Array<{
      citation?: string;
      snippet?: string;
      score?: number;
      title?: string;
      collection?: string;
    }>;
  };
  const results: CitedHit[] = (body.hits ?? [])
    .filter((h) => typeof h.citation === 'string' && h.citation.length > 0)
    .map((h) => ({
      citation: h.citation as string,
      snippet: typeof h.snippet === 'string' ? h.snippet : '',
      score: typeof h.score === 'number' ? h.score : 0,
      title: h.title,
      collection: h.collection,
    }));
  return jsonResult({ source: 'brain-api', query, scope, count: results.length, results });
}

/**
 * team-mode connectivity probe. Calls the brain's health route (GET /api/health,
 * auth-exempt server-side) so a teammate can answer "am I connected, in team
 * mode, with a token?" without touching any brain data. Read-only.
 */
export async function status(): Promise<ReturnType<typeof jsonResult>> {
  const tokenSet = API_TOKEN !== undefined && API_TOKEN !== '';
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({
      mode: 'team',
      apiUrl: null,
      tokenSet,
      healthy: false,
      version: null,
      error: 'unconfigured — set TEAMKB_API_URL to your team brain',
    });
  }
  const apiUrl = API_URL.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/health`, { method: 'GET' });
  } catch (e) {
    return jsonResult({
      mode: 'team',
      apiUrl,
      tokenSet,
      healthy: false,
      version: null,
      error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  let version: string | null = null;
  try {
    const b = (await res.json()) as { version?: unknown };
    if (typeof b.version === 'string') version = b.version;
  } catch {
    version = null;
  }
  // healthy tracks the HTTP status: the health route replies 200 healthy / 503 degraded.
  return jsonResult({ mode: 'team', apiUrl, tokenSet, healthy: res.ok, version });
}

const server = new McpServer({ name: 'governed-brain', version: VERSION });

server.tool(
  'brain_search',
  'Search your team\'s governed knowledge brain and return qmd:// citations. Every hit is anchored to a verifiable source — receipts, not recall. Read-only; curated scope by default. Proxies to the governed brain over the tailnet (team mode).',
  {
    query: z.string().min(1).describe('Natural-language search query'),
    scope: z
      .enum(['curated', 'all', 'inbox', 'archived'])
      .optional()
      .describe('Search scope: curated (default), all, inbox, or archived'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of cited hits to return (default 10)'),
  },
  async (params) => search(params.query, params.scope ?? 'curated', params.limit ?? 10),
);

server.tool(
  'brain_status',
  'Check your connection to the team brain: are you in team mode, is TEAMKB_API_URL reachable, and is a per-user token set? Calls the brain\'s health probe (no auth) and reports { mode, apiUrl, tokenSet, healthy, version }. Read-only — no query, touches no data.',
  {},
  async () => status(),
);

// ─── WRITE (team mode: member proposes, the server disposes) ──────────────────

/**
 * Propose a candidate to the team brain (exported for unit testing). Idempotent +
 * durable: session-stable id when sessionId is set; content-derived otherwise.
 * Network throw / 5xx freezes the POST body in the durable outbox; success drains.
 * Response includes `intake` when the server reports created vs already_exists.
 */
export async function capture(
  title: string,
  content: string,
  category: string | undefined,
  filePaths: string[] | undefined,
  sessionId?: string,
  learningIndex?: number,
): Promise<ReturnType<typeof jsonResult>> {
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
  }
  // Build the FULL MemoryCandidate client-side once. This object (serialized) is
  // what gets POSTed and, on failure, FROZEN in the outbox — drain never rebuilds it.
  const candidate = {
    id: deriveCandidateId(TENANT_ID, title, content, sessionId, learningIndex),
    status: 'inbox',
    source: 'mcp',
    content,
    title,
    category: category ?? 'reference',
    trustLevel: 'medium',
    author: { type: 'ai', id: 'governed-brain' },
    tenantId: TENANT_ID,
    metadata: {
      filePaths: filePaths ?? [],
      tags: [] as string[],
      ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
      ...(typeof learningIndex === 'number' && Number.isInteger(learningIndex)
        ? { learningIndex }
        : {}),
    },
    prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
    capturedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(candidate);
  let res: Response;
  try {
    res = await fetch(`${API_URL.replace(/\/+$/, '')}/api/candidates`, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });
  } catch (e) {
    // API unreachable (dead / off-tailnet). DON'T drop it — freeze body in outbox.
    const queued = await enqueueOutbox(candidate);
    return jsonResult({
      ok: queued,
      queued,
      candidateId: candidate.id,
      tenantId: TENANT_ID,
      message: queued
        ? `Could not reach the brain (${e instanceof Error ? e.message : String(e)}). Queued to the durable outbox — it will be sent on the next successful capture. Nothing was lost.`
        : `Could not reach the brain (${e instanceof Error ? e.message : String(e)}) AND could not write the durable outbox — this capture was NOT saved. Please retry.`,
    });
  }
  if (!res.ok) {
    // 5xx = transient server error → queue (retry later). 4xx = a real rejection
    // (validation/auth/disclosure) → surface it; queuing would just loop.
    // Note: 200 already_exists is res.ok — handled below.
    if (res.status >= 500) {
      const queued = await enqueueOutbox(candidate);
      return jsonResult({
        ok: queued,
        queued,
        candidateId: candidate.id,
        tenantId: TENANT_ID,
        message: queued
          ? `The brain returned ${res.status}. Queued to the durable outbox — it will be retried on the next successful capture. Nothing was lost.`
          : `The brain returned ${res.status} AND the durable outbox write failed — this capture was NOT saved. Please retry.`,
      });
    }
    return errorResult(res);
  }
  // Delivered (201 created or 200 already_exists). Read body once, then drain.
  let intake: string | undefined;
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { intake?: string };
      if (typeof parsed.intake === 'string') intake = parsed.intake;
    } catch {
      /* non-JSON body — still ok */
    }
  } catch {
    intake = undefined;
  }
  const drained = await drainOutbox();
  // Prefer body.intake for knowledge; do not invent already_exists from bare 200
  // (old servers / proxies may return 200 without meaning collapse).
  const known =
    intake === 'created' || intake === 'already_exists'
      ? intake
      : res.status === 201
        ? 'created'
        : 'unknown';
  const already = known === 'already_exists';
  return jsonResult({
    ok: true,
    candidateId: candidate.id,
    tenantId: TENANT_ID,
    intake: known,
    alreadyExists: already,
    ...(drained > 0 ? { outboxDrained: drained } : {}),
    message: already
      ? 'Idempotent: this proposal already exists in the team brain inbox (same session slot or same content). Safe to retry; not a new capture.'
      : known === 'unknown'
        ? 'Proposed to the team brain inbox (server did not report created vs already_exists). This is a PROPOSAL — not durable memory until promoted.'
        : 'Proposed to the team brain inbox. This is a PROPOSAL — the deterministic govern pipeline decides if/when it is promoted (an admin governs, or auto-govern once enabled). It is not durable memory yet.',
  });
}

server.tool(
  'brain_capture',
  "Propose a fact, decision, pattern, or convention to your team's governed brain — a PROPOSAL, not a promotion. Member-allowed: the server queues it as a candidate and the deterministic govern pipeline disposes; it is not durable memory until promoted. Proxies to the brain over the tailnet (team mode). For SessionEnd: pass sessionId + learningIndex (0..4) so each learning is its own slot and re-distill of that slot collapses.",
  {
    title: z.string().min(1).describe('Short, specific title for the memory'),
    content: z.string().min(1).describe('The fact to remember, in full'),
    category: z.enum(CATEGORIES).optional().describe('Memory category (default: reference)'),
    filePaths: z.array(z.string()).optional().describe('Related file paths, if any'),
    sessionId: z
      .string()
      .optional()
      .describe(
        'Stable session id (Claude Code session). With learningIndex, forms a per-learning slot so re-distill does not duplicate and multi-learning sessions keep separate rows.',
      ),
    learningIndex: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe(
        '0-based index of this learning within the session (SessionEnd: 0..4 for up to 5 learnings). Defaults to 0 when sessionId is set.',
      ),
  },
  async (params) =>
    capture(
      params.title,
      params.content,
      params.category,
      params.filePaths,
      params.sessionId,
      params.learningIndex,
    ),
);

server.tool(
  'brain_transition',
  'Change the lifecycle state of an existing governed memory (e.g. retire an outdated one). ADMIN-ONLY in team mode — a member token gets a clear 403 and nothing is applied. The server writes a hash-chained audit event. Valid moves: active→{deprecated,superseded,archived}, deprecated→{active,archived}, superseded→archived.',
  {
    memoryId: z.string().uuid().describe('UUID of the memory to transition'),
    to: z.enum(['active', 'deprecated', 'superseded', 'archived']).describe('Target lifecycle state'),
    reason: z.string().min(1).describe('Human-readable justification (lands in the audit trail)'),
    actor: z.string().optional().describe('Who is making the change (default: owner)'),
    supersededBy: z.string().uuid().optional().describe('Required UUID when transitioning to "superseded"'),
  },
  async (params) => {
    if (API_URL === undefined || API_URL === '') {
      return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
    }
    // The transition route expects an Author OBJECT (not local mode's string).
    const body: Record<string, unknown> = {
      to: params.to,
      reason: params.reason,
      actor: { type: 'human', id: params.actor ?? 'owner' },
    };
    if (params.supersededBy !== undefined) body['supersededBy'] = params.supersededBy;
    let res: Response;
    try {
      res = await fetch(`${API_URL.replace(/\/+$/, '')}/api/memories/${params.memoryId}/transition`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      return jsonResult({ ok: false, error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (!res.ok) return errorResult(res);
    return jsonResult({
      ok: true,
      memoryId: params.memoryId,
      to: params.to,
      message: 'Transition applied; hash-chained audit event written server-side.',
    });
  },
);

// ─── ADMIN INBOX (team mode: review + dispose the quarantined queue) ──────────
// The last mile of team capture (jfv.8 / 014-AT-DECR): member proposals land
// QUARANTINED by the nightly govern sweep and, without these, rot unreviewed.
// brain_inbox lists them; brain_approve / brain_reject dispose them. All three are
// ADMIN-ONLY (a member token gets a clear 403 via errorResult) and HTTP-proxy only
// — no sqlite, so team mode stays install-free. The deterministic pipeline OWNS the
// transition: brain_approve's promote re-runs the govern rules server-side
// (dedupe/policy/secret-scan) as a hard floor the caller cannot override, and every
// decision is a hash-chained receipt naming the acting token as the actor.
//
// Handlers are exported (like search/status) so they are unit-testable against a
// stubbed fetch. Tenant defaults to TENANT_ID; an explicit tenantId overrides.

/** Resolve the target tenant: an explicit non-empty override, else the team tenant. */
function resolveTenant(tenantId: string | undefined): string {
  const t = tenantId?.trim();
  return t !== undefined && t !== '' ? t : TENANT_ID;
}

/** List the quarantined review queue (admin). Returns a compact per-candidate view. */
export async function listInbox(
  tenantId: string | undefined,
  limit: number,
): Promise<ReturnType<typeof jsonResult>> {
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
  }
  const tenant = resolveTenant(tenantId);
  const url =
    `${API_URL.replace(/\/+$/, '')}/api/candidates` +
    `?status=quarantined&tenantId=${encodeURIComponent(tenant)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: authHeaders() });
  } catch (e) {
    return jsonResult({ ok: false, error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!res.ok) return errorResult(res);
  let rows: Array<{
    id?: string;
    title?: string;
    category?: string;
    author?: { id?: string } | string;
    capturedAt?: string;
  }>;
  try {
    // A 2xx with an unreadable (non-JSON) body must not crash the tool — surface it.
    rows = (await res.json()) as typeof rows;
  } catch {
    return jsonResult({ ok: false, error: 'the brain returned an unreadable (non-JSON) inbox response' });
  }
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r.id === 'string' && r.id.length > 0)
    .slice(0, limit)
    .map((r) => ({
      id: r.id as string,
      title: typeof r.title === 'string' ? r.title : '',
      category: typeof r.category === 'string' ? r.category : '',
      author:
        typeof r.author === 'object' && r.author !== null ? (r.author.id ?? '') : (r.author ?? ''),
      capturedAt: typeof r.capturedAt === 'string' ? r.capturedAt : '',
    }));
  return jsonResult({ ok: true, tenantId: tenant, count: candidates.length, candidates });
}

/** Promote a quarantined candidate to durable memory through the govern gate (admin). */
export async function approveCandidate(
  candidateId: string,
  tenantId: string | undefined,
  reason: string,
): Promise<ReturnType<typeof jsonResult>> {
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
  }
  const tenant = resolveTenant(tenantId);
  let res: Response;
  try {
    res = await fetch(
      `${API_URL.replace(/\/+$/, '')}/api/candidates/${encodeURIComponent(candidateId)}/promote` +
        `?tenantId=${encodeURIComponent(tenant)}`,
      {
        method: 'POST',
        headers: authHeaders(),
        // actorType:'ai' — this is the review AGENT proxying; the SERVER derives
        // the actor id from the authenticated token, so it can't be spoofed here.
        body: JSON.stringify({ reason, actorType: 'ai' }),
      },
    );
  } catch (e) {
    return jsonResult({ ok: false, error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!res.ok) return errorResult(res);
  // The promotion already SUCCEEDED (2xx). An unreadable/null body must not turn a
  // real promotion into an error — just report ok without the memory id.
  let memory: { id?: string } | null = null;
  try {
    memory = (await res.json()) as { id?: string } | null;
  } catch {
    memory = null;
  }
  return jsonResult({
    ok: true,
    candidateId,
    memoryId: memory?.id,
    tenantId: tenant,
    message:
      'Promoted to durable team memory — it passed the deterministic govern rules and a hash-chained receipt names you as the approving actor.',
  });
}

/** Retire a quarantined candidate as `rejected` (admin) — a marker, never a delete. */
export async function rejectCandidate(
  candidateId: string,
  tenantId: string | undefined,
  reason: string,
): Promise<ReturnType<typeof jsonResult>> {
  if (API_URL === undefined || API_URL === '') {
    return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
  }
  const tenant = resolveTenant(tenantId);
  let res: Response;
  try {
    res = await fetch(
      `${API_URL.replace(/\/+$/, '')}/api/candidates/${encodeURIComponent(candidateId)}/reject` +
        `?tenantId=${encodeURIComponent(tenant)}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ reason, actorType: 'ai' }),
      },
    );
  } catch (e) {
    return jsonResult({ ok: false, error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (!res.ok) return errorResult(res);
  return jsonResult({
    ok: true,
    candidateId,
    tenantId: tenant,
    message: 'Retired as rejected (row preserved); a hash-chained receipt names you + your reason.',
  });
}

server.tool(
  'brain_inbox',
  "List your team brain's quarantined capture queue — member proposals held for review, awaiting an admin's promote/reject. ADMIN-ONLY in team mode (a member token gets a clear 403). Read-only; returns { id, title, category, author, capturedAt } per candidate so you can review then brain_approve / brain_reject by id. Proxies to the governed brain over the tailnet.",
  {
    tenantId: z.string().optional().describe('Tenant to inspect (default: the team tenant)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max candidates to return (default 50)'),
  },
  async (params) => listInbox(params.tenantId, params.limit ?? 50),
);

server.tool(
  'brain_approve',
  "Promote a quarantined candidate to durable team memory — the agent-review 'this is worth keeping' verdict. ADMIN-ONLY (member token → 403, nothing applied). The server re-runs the deterministic govern rules (dedupe / policy / secret-scan) as a hard floor you CANNOT override, then writes a hash-chained receipt naming you (the acting token) + your reason. A secret or duplicate is refused server-side (422) — it cannot be laundered through an approval.",
  {
    candidateId: z.string().uuid().describe('UUID of the quarantined candidate (from brain_inbox)'),
    tenantId: z.string().optional().describe('Tenant the candidate belongs to (default: the team tenant)'),
    reason: z.string().min(1).describe('Why it should become durable memory (lands in the receipt)'),
  },
  async (params) => approveCandidate(params.candidateId, params.tenantId, params.reason),
);

server.tool(
  'brain_reject',
  "Retire a quarantined candidate as noise WITHOUT promoting it — the agent-review 'don't keep proposing this' verdict. ADMIN-ONLY (member token → 403). Non-destructive: the candidate row survives (never deleted), stamped `rejected`, and a hash-chained receipt names you + your reason. Proxies to the governed brain over the tailnet.",
  {
    candidateId: z.string().uuid().describe('UUID of the quarantined candidate (from brain_inbox)'),
    tenantId: z.string().optional().describe('Tenant the candidate belongs to (default: the team tenant)'),
    reason: z.string().min(1).describe('Why it is being retired (lands in the receipt)'),
  },
  async (params) => rejectCandidate(params.candidateId, params.tenantId, params.reason),
);

/**
 * Boot team mode: connect the stdio transport. Exported so the dispatcher
 * (src/index.ts) can start it, and invoked directly when this module is the
 * entry point (e.g. running the bundle standalone).
 */
export async function startRemoteServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const shutdown = async (sig: string): Promise<void> => {
    process.stderr.write(`[governed-brain:team] ${sig}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(transport);
  process.stderr.write(
    `[governed-brain:team] started — brain=${API_URL ?? '(TEAMKB_API_URL unset)'} token=${API_TOKEN ? 'set' : 'none'}\n`,
  );
}
