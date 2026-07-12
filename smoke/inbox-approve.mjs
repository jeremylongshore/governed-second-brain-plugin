#!/usr/bin/env node
/**
 * jfv.8 / 014-AT-DECR — the agent-review admin surface (brain_inbox / brain_approve
 * / brain_reject), driven END-TO-END through the BUILT team-mode runtime
 * (plugin-runtime/governed-brain.cjs) over a REAL stdio MCP session and a REAL HTTP
 * socket. Hermetic, zero-egress: a tiny request-capturing stub stands in for the
 * governed brain API on 127.0.0.1, so this proves the WIRE contract the stubbed-
 * fetch unit tests cannot — the exact URL, query, method, Authorization header, and
 * JSON body each tool puts on the socket, plus how it parses the response.
 *
 * The API's own handling of these requests (status flip, actor receipt, disclosure
 * hard floor, reject) is proven separately by the INTKB integration tests
 * (apps/api promote.test.ts + candidates.test.ts). Together: tool→wire (here) +
 * wire→API→DB (there) = the full loop.
 *
 * Uses only PRODUCTION deps (the smoke workflow strips devDependencies): Node's
 * built-in http + the MCP SDK. No @qmd-team-intent-kb import, no better-sqlite3.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');
const TOKEN = 'smoke-admin-tok';
const TENANT = 'intent-solutions';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed += 1;
};
const parse = (res) => JSON.parse(res.content[0].text);

// ── A request-capturing stub for the governed brain API. ──────────────────────
const seen = []; // { method, path, query, auth, body }
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const rec = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers['authorization'] ?? '',
      body: raw.length > 0 ? JSON.parse(raw) : null,
    };
    seen.push(rec);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/candidates') {
      // The quarantined queue the API would return (Author OBJECT + a sparse row).
      res.end(
        JSON.stringify([
          {
            id: 'cand-1',
            title: 'Nightly backup window',
            category: 'reference',
            author: { type: 'ai', id: 'ezekiel' },
            capturedAt: '2026-07-11T03:00:00.000Z',
          },
          { id: 'cand-2', title: 'no author/date', category: 'pattern' },
        ]),
      );
    } else if (req.method === 'POST' && /\/promote$/.test(url.pathname)) {
      res.end(JSON.stringify({ id: 'mem-42', lifecycle: 'active' }));
    } else if (req.method === 'POST' && /\/reject$/.test(url.pathname)) {
      res.end(JSON.stringify({ ok: true, candidateId: 'cand-1', status: 'rejected' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unexpected route' }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const API_URL = `http://127.0.0.1:${port}`;

const transport = new StdioClientTransport({
  command: 'node',
  args: [RUNTIME],
  env: { ...process.env, TEAMKB_API_URL: API_URL, TEAMKB_API_TOKEN: TOKEN, TEAMKB_TENANT_ID: TENANT },
});
const client = new Client({ name: 'gsb-inbox-approve-smoke', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  // The three admin tools must be registered in team mode.
  const tools = (await client.listTools()).tools.map((t) => t.name);
  ok(
    ['brain_inbox', 'brain_approve', 'brain_reject'].every((t) => tools.includes(t)),
    `team mode registers the admin tools (${tools.filter((t) => t.startsWith('brain_')).join(', ')})`,
  );

  // ── brain_inbox — lists the quarantined queue, compacted. ──
  const inbox = parse(await client.callTool({ name: 'brain_inbox', arguments: { limit: 50 } }));
  ok(inbox.ok === true && inbox.count === 2, `brain_inbox returned the queue (count=${inbox.count})`);
  ok(
    inbox.candidates?.[0]?.author === 'ezekiel',
    'brain_inbox compacts the Author object down to its id',
  );
  const getReq = seen.find((r) => r.method === 'GET' && r.path === '/api/candidates');
  ok(getReq?.query.status === 'quarantined', "brain_inbox filtered on status=quarantined over the wire");
  ok(getReq?.query.tenantId === TENANT, 'brain_inbox scoped the request to the team tenant');
  ok(getReq?.auth === `Bearer ${TOKEN}`, 'brain_inbox sent the Bearer token over the wire');

  // ── brain_approve — POSTs /promote with reason + actorType:ai, parses memoryId. ──
  const appr = parse(
    await client.callTool({
      name: 'brain_approve',
      arguments: { candidateId: '11111111-1111-4111-8111-111111111111', tenantId: TENANT, reason: 'durable + useful' },
    }),
  );
  ok(appr.ok === true && appr.memoryId === 'mem-42', `brain_approve promoted (memoryId=${appr.memoryId})`);
  const promoteReq = seen.find((r) => r.method === 'POST' && /\/promote$/.test(r.path));
  ok(/\/api\/candidates\/11111111-1111-4111-8111-111111111111\/promote$/.test(promoteReq?.path ?? ''), 'brain_approve hit the candidate promote path');
  ok(
    promoteReq?.body?.reason === 'durable + useful' && promoteReq?.body?.actorType === 'ai',
    'brain_approve sent { reason, actorType:ai } — the server owns the actor id',
  );
  ok(promoteReq?.auth === `Bearer ${TOKEN}`, 'brain_approve sent the Bearer token over the wire');

  // ── brain_reject — POSTs /reject with a reason. ──
  const rej = parse(
    await client.callTool({
      name: 'brain_reject',
      arguments: { candidateId: '22222222-2222-4222-8222-222222222222', tenantId: TENANT, reason: 'duplicate noise' },
    }),
  );
  ok(rej.ok === true, 'brain_reject reported the retirement');
  const rejectReq = seen.find((r) => r.method === 'POST' && /\/reject$/.test(r.path));
  ok(rejectReq?.body?.reason === 'duplicate noise', 'brain_reject sent the reason over the wire (a permanent receipt)');
  ok(/\/api\/candidates\/22222222-2222-4222-8222-222222222222\/reject$/.test(rejectReq?.path ?? ''), 'brain_reject hit the candidate reject path');
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

console.log(failed === 0 ? '\nINBOX-APPROVE SMOKE PASS' : `\nINBOX-APPROVE SMOKE FAIL (${failed} check(s) failed)`);
process.exit(failed === 0 ? 0 : 1);
