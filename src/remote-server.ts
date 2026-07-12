#!/usr/bin/env node
/**
 * Governed Second Brain — team mode (remote proxy).
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
import { randomUUID } from 'node:crypto';
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
      body: JSON.stringify({ query, scope, pagination: { page: 1, pageSize: limit } }),
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

server.tool(
  'brain_capture',
  "Propose a fact, decision, pattern, or convention to your team's governed brain — a PROPOSAL, not a promotion. Member-allowed: the server queues it as a candidate and the deterministic govern pipeline disposes; it is not durable memory until promoted. Proxies to the brain over the tailnet (team mode).",
  {
    title: z.string().min(1).describe('Short, specific title for the memory'),
    content: z.string().min(1).describe('The fact to remember, in full'),
    category: z.enum(CATEGORIES).optional().describe('Memory category (default: reference)'),
    filePaths: z.array(z.string()).optional().describe('Related file paths, if any'),
  },
  async (params) => {
    if (API_URL === undefined || API_URL === '') {
      return jsonResult({ ok: false, error: 'unconfigured — set TEAMKB_API_URL to your team brain' });
    }
    // Build the FULL MemoryCandidate client-side (the server safeParses it with
    // no defaults) — identical shape to local mode, but tenant-scoped to TENANT_ID.
    const candidate = {
      id: randomUUID(),
      status: 'inbox',
      source: 'mcp',
      content: params.content,
      title: params.title,
      category: params.category ?? 'reference',
      trustLevel: 'medium',
      author: { type: 'ai', id: 'governed-brain' },
      tenantId: TENANT_ID,
      metadata: { filePaths: params.filePaths ?? [], tags: [] as string[] },
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
      capturedAt: new Date().toISOString(),
    };
    let res: Response;
    try {
      res = await fetch(`${API_URL.replace(/\/+$/, '')}/api/candidates`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(candidate),
      });
    } catch (e) {
      return jsonResult({ ok: false, error: `could not reach the brain API: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (!res.ok) return errorResult(res);
    return jsonResult({
      ok: true,
      candidateId: candidate.id,
      tenantId: TENANT_ID,
      message:
        'Proposed to the team brain inbox. This is a PROPOSAL — the deterministic govern pipeline decides if/when it is promoted (an admin governs, or auto-govern once enabled). It is not durable memory yet.',
    });
  },
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
